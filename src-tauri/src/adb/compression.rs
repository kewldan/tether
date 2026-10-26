//! Stream codecs for compressed sync transfers (`sendrecv_v2`).
//!
//! adb compresses a whole file as one stream and cuts the compressed bytes
//! into `DATA` messages of at most 64 KiB; message boundaries mean nothing
//! to the codec. Brotli, LZ4 (frame format) and Zstandard streams are
//! accepted by `adbd` (`compression_utils.h` in AOSP).

use std::io::{self, Read, Write};

/// A codec the device can speak, with its `SyncFlag` bit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Compression {
    Brotli,
    Lz4,
    Zstd,
}

impl Compression {
    /// `kSyncFlagBrotli` / `kSyncFlagLZ4` / `kSyncFlagZstd`.
    pub fn flag(self) -> u32 {
        match self {
            Self::Brotli => 1,
            Self::Lz4 => 2,
            Self::Zstd => 4,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Brotli => "brotli",
            Self::Lz4 => "lz4",
            Self::Zstd => "zstd",
        }
    }
}

const ZSTD_LEVEL: i32 = 1;
const BROTLI_QUALITY: u32 = 1;
const BROTLI_LGWIN: u32 = 22;
const BROTLI_BUFFER: usize = 64 * 1024;

/// Push-style encoder: feed input, collect whatever compressed bytes are
/// ready, then finish the stream.
pub struct StreamEncoder(EncoderKind);

enum EncoderKind {
    Brotli(Box<brotli::CompressorWriter<Vec<u8>>>),
    Lz4(lz4_flex::frame::FrameEncoder<Vec<u8>>),
    Zstd(zstd::stream::write::Encoder<'static, Vec<u8>>),
}

impl StreamEncoder {
    pub fn new(codec: Compression) -> io::Result<Self> {
        Ok(Self(match codec {
            Compression::Brotli => EncoderKind::Brotli(Box::new(brotli::CompressorWriter::new(
                Vec::new(),
                BROTLI_BUFFER,
                BROTLI_QUALITY,
                BROTLI_LGWIN,
            ))),
            Compression::Lz4 => EncoderKind::Lz4(lz4_flex::frame::FrameEncoder::new(Vec::new())),
            Compression::Zstd => {
                EncoderKind::Zstd(zstd::stream::write::Encoder::new(Vec::new(), ZSTD_LEVEL)?)
            }
        }))
    }

    /// Compresses `input`, appending the bytes that are ready to `out`.
    pub fn write(&mut self, input: &[u8], out: &mut Vec<u8>) -> io::Result<()> {
        let sink = match &mut self.0 {
            EncoderKind::Brotli(e) => {
                e.write_all(input)?;
                e.get_mut()
            }
            EncoderKind::Lz4(e) => {
                e.write_all(input)?;
                e.get_mut()
            }
            EncoderKind::Zstd(e) => {
                e.write_all(input)?;
                e.get_mut()
            }
        };
        out.append(sink);
        Ok(())
    }

    /// Ends the stream, appending the remaining bytes to `out`.
    pub fn finish(self, out: &mut Vec<u8>) -> io::Result<()> {
        let mut rest = match self.0 {
            EncoderKind::Brotli(e) => e.into_inner(),
            EncoderKind::Lz4(e) => e.finish()?,
            EncoderKind::Zstd(e) => e.finish()?,
        };
        out.append(&mut rest);
        Ok(())
    }
}

/// Pull-style decoder over a reader of compressed bytes.
pub fn decoder<'a, R: Read + Send + 'a>(
    codec: Compression,
    input: R,
) -> io::Result<Box<dyn Read + Send + 'a>> {
    Ok(match codec {
        Compression::Brotli => Box::new(brotli::Decompressor::new(input, BROTLI_BUFFER)),
        Compression::Lz4 => Box::new(lz4_flex::frame::FrameDecoder::new(input)),
        Compression::Zstd => Box::new(zstd::stream::read::Decoder::new(input)?),
    })
}

/// File extensions whose content is already compressed: squeezing them
/// again costs CPU on both ends for nothing.
const COMPRESSED_EXTENSIONS: &[&str] = &[
    // images
    "jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "avif", "jxl",
    // video and audio
    "mp4", "m4v", "mkv", "webm", "mov", "3gp", "avi", "ts", "mp3", "m4a", "aac", "ogg", "oga",
    "opus", "flac", "amr", // archives and packages
    "zip", "apk", "apks", "apkm", "xapk", "aab", "jar", "obb", "gz", "tgz", "xz", "txz", "bz2",
    "zst", "lz4", "br", "7z", "rar", "lz", "lzma", "cab", "dmg", "squashfs", "sfs",
    // documents that are zip containers
    "docx", "xlsx", "pptx", "odt", "ods", "odp", "epub",
];

/// Whether a file with this name is worth compressing in transit.
pub fn worth_compressing(name: &str) -> bool {
    let Some((_, ext)) = name.rsplit_once('.') else {
        return true;
    };
    let ext = ext.to_ascii_lowercase();
    !COMPRESSED_EXTENSIONS.contains(&ext.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roundtrip(codec: Compression, data: &[u8]) -> (Vec<u8>, usize) {
        let mut enc = StreamEncoder::new(codec).unwrap();
        let mut compressed = Vec::new();
        for chunk in data.chunks(10_000) {
            enc.write(chunk, &mut compressed).unwrap();
        }
        enc.finish(&mut compressed).unwrap();
        let mut out = Vec::new();
        decoder(codec, compressed.as_slice())
            .unwrap()
            .read_to_end(&mut out)
            .unwrap();
        (out, compressed.len())
    }

    #[test]
    fn codecs_roundtrip_and_shrink_text() {
        let text: Vec<u8> = (0..20_000)
            .flat_map(|i| {
                format!("10-26 12:00:{:02} I/ActivityManager: line {i}\n", i % 60).into_bytes()
            })
            .collect();
        for codec in [Compression::Brotli, Compression::Lz4, Compression::Zstd] {
            let (out, size) = roundtrip(codec, &text);
            assert_eq!(out, text, "{codec:?}");
            assert!(size * 4 < text.len(), "{codec:?}: {size} of {}", text.len());
            let (empty, _) = roundtrip(codec, &[]);
            assert!(empty.is_empty());
        }
    }

    #[test]
    fn flags_match_aosp() {
        assert_eq!(Compression::Brotli.flag(), 1);
        assert_eq!(Compression::Lz4.flag(), 2);
        assert_eq!(Compression::Zstd.flag(), 4);
    }

    #[test]
    fn skips_compressed_formats() {
        assert!(!worth_compressing("PXL_20261025.JPG"));
        assert!(!worth_compressing("base.apk"));
        assert!(!worth_compressing("backup.tar.gz"));
        assert!(worth_compressing("logcat.txt"));
        assert!(worth_compressing("Makefile"));
        assert!(worth_compressing("raw.dng"));
    }
}
