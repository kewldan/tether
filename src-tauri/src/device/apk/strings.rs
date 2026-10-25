//! `ResStringPool` (chunk type 0x0001), decoded lazily: resource tables of
//! large apps carry tens of thousands of strings and we need a handful.

use super::{Chunk, Le};

pub const CHUNK_STRING_POOL: u16 = 0x0001;
const UTF8_FLAG: u32 = 1 << 8;

#[derive(Debug, Clone, Copy)]
pub struct StringPool<'a> {
    chunk: &'a [u8],
    count: usize,
    offsets_at: usize,
    strings_at: usize,
    utf8: bool,
}

impl<'a> StringPool<'a> {
    /// Parses the pool chunk starting at `at`.
    pub fn parse(data: &'a [u8], at: usize) -> Option<Self> {
        let header = Chunk::read(data, at)?;
        if header.kind != CHUNK_STRING_POOL {
            return None;
        }
        let chunk = &data[at..at + header.size];
        let count = chunk.u32_at(8)? as usize;
        let flags = chunk.u32_at(16)?;
        let strings_at = chunk.u32_at(20)? as usize;
        // Offsets follow the header; reject counts that cannot fit.
        if count.checked_mul(4)? > chunk.len() {
            return None;
        }
        Some(Self {
            chunk,
            count,
            offsets_at: header.header_size,
            strings_at,
            utf8: flags & UTF8_FLAG != 0,
        })
    }

    pub fn empty() -> Self {
        Self {
            chunk: &[],
            count: 0,
            offsets_at: 0,
            strings_at: 0,
            utf8: true,
        }
    }

    pub fn get(&self, index: u32) -> Option<String> {
        let index = index as usize;
        if index >= self.count {
            return None;
        }
        let offset = self.chunk.u32_at(self.offsets_at + index * 4)? as usize;
        let at = self.strings_at.checked_add(offset)?;
        if self.utf8 {
            self.utf8_at(at)
        } else {
            self.utf16_at(at)
        }
    }

    fn utf8_at(&self, mut at: usize) -> Option<String> {
        // UTF-16 length (unused), then UTF-8 byte length; each 1 or 2 bytes.
        let (_, used) = utf8_len(self.chunk, at)?;
        at += used;
        let (len, used) = utf8_len(self.chunk, at)?;
        at += used;
        let bytes = self.chunk.get(at..at.checked_add(len)?)?;
        Some(String::from_utf8_lossy(bytes).into_owned())
    }

    fn utf16_at(&self, mut at: usize) -> Option<String> {
        let mut len = self.chunk.u16_at(at)? as usize;
        at += 2;
        if len & 0x8000 != 0 {
            len = ((len & 0x7fff) << 16) | self.chunk.u16_at(at)? as usize;
            at += 2;
        }
        let bytes = self.chunk.get(at..at.checked_add(len.checked_mul(2)?)?)?;
        let units: Vec<u16> = bytes
            .as_chunks::<2>()
            .0
            .iter()
            .map(|&b| u16::from_le_bytes(b))
            .collect();
        Some(String::from_utf16_lossy(&units))
    }
}

fn utf8_len(data: &[u8], at: usize) -> Option<(usize, usize)> {
    let first = data.u8_at(at)? as usize;
    if first & 0x80 != 0 {
        let second = data.u8_at(at + 1)? as usize;
        Some((((first & 0x7f) << 8) | second, 2))
    } else {
        Some((first, 1))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pool(utf8: bool, encoded: &[&[u8]]) -> Vec<u8> {
        let header = 28usize;
        let offsets_len = encoded.len() * 4;
        let mut strings = Vec::new();
        let mut offsets = Vec::new();
        for s in encoded {
            offsets.extend_from_slice(&(strings.len() as u32).to_le_bytes());
            strings.extend_from_slice(s);
        }
        let size = header + offsets_len + strings.len();
        let mut out = Vec::new();
        out.extend_from_slice(&CHUNK_STRING_POOL.to_le_bytes());
        out.extend_from_slice(&(header as u16).to_le_bytes());
        out.extend_from_slice(&(size as u32).to_le_bytes());
        out.extend_from_slice(&(encoded.len() as u32).to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        out.extend_from_slice(&(if utf8 { UTF8_FLAG } else { 0 }).to_le_bytes());
        out.extend_from_slice(&((header + offsets_len) as u32).to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        out.extend_from_slice(&offsets);
        out.extend_from_slice(&strings);
        out
    }

    #[test]
    fn decodes_utf8_and_utf16_pools() {
        let data = pool(true, &[b"\x03\x03abc\0", b"\x02\x04\xd0\x96\xd0\x96\0"]);
        let p = StringPool::parse(&data, 0).unwrap();
        assert_eq!(p.count, 2);
        assert_eq!(p.get(0).as_deref(), Some("abc"));
        assert_eq!(p.get(1).as_deref(), Some("ЖЖ"));
        assert_eq!(p.get(2), None);

        let data = pool(false, &[b"\x02\x00h\0i\0\0\0"]);
        let p = StringPool::parse(&data, 0).unwrap();
        assert_eq!(p.get(0).as_deref(), Some("hi"));
    }

    #[test]
    fn long_utf8_lengths_use_two_bytes() {
        let body = "x".repeat(200);
        let mut s = vec![0x80, 200, 0x80, 200];
        s.extend_from_slice(body.as_bytes());
        s.push(0);
        let data = pool(true, &[&s]);
        let p = StringPool::parse(&data, 0).unwrap();
        assert_eq!(p.get(0).unwrap().len(), 200);
    }

    #[test]
    fn truncated_pool_is_rejected_or_yields_none() {
        let mut data = pool(true, &[b"\x03\x03abc\0"]);
        data.truncate(data.len() - 3);
        // Header claims more bytes than present.
        assert!(StringPool::parse(&data, 0).is_none());
    }
}
