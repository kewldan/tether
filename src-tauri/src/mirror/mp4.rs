//! A minimal streaming MP4 (ISO BMFF) writer for one video track.
//!
//! Samples go straight to disk inside one `mdat` with a 64-bit size, so
//! memory stays flat however long the recording runs (only the sample
//! tables are kept: ~16 bytes per frame). `finish` patches the `mdat` size
//! and appends the `moov`. One sample per chunk with `co64` offsets keeps
//! the tables trivial and files above 4 GB valid.
//!
//! Boxes follow ISO/IEC 14496-12 (container), 14496-15 (`avc1`/`hvc1`
//! sample entries with `avcC`/`hvcC`) and the AV1-in-ISOBMFF binding
//! (`av01` with `av1C`).

use std::io::{self, Seek, SeekFrom, Write};

/// Media timescale: 90 kHz, the usual video clock; scrcpy's microsecond
/// PTS are converted per sample, so rounding never accumulates.
pub const TIMESCALE: u32 = 90_000;
/// Movie (presentation) timescale: milliseconds.
const MOVIE_TIMESCALE: u32 = 1000;
/// Duration given to the last sample (its successor never came): 1/60 s.
const LAST_SAMPLE: u32 = TIMESCALE / 60;

/// Codec configuration that goes into the sample description.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SampleEntry {
    /// `avc1` with an `AVCDecoderConfigurationRecord`.
    Avc(Vec<u8>),
    /// `hvc1` with an `HEVCDecoderConfigurationRecord`.
    Hevc(Vec<u8>),
    /// `av01` with an `AV1CodecConfigurationRecord`.
    Av1(Vec<u8>),
}

impl SampleEntry {
    fn kinds(&self) -> (&'static [u8; 4], &'static [u8; 4]) {
        match self {
            Self::Avc(_) => (b"avc1", b"avcC"),
            Self::Hevc(_) => (b"hvc1", b"hvcC"),
            Self::Av1(_) => (b"av01", b"av1C"),
        }
    }

    fn record(&self) -> &[u8] {
        match self {
            Self::Avc(r) | Self::Hevc(r) | Self::Av1(r) => r,
        }
    }
}

/// What a finished file contains.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Summary {
    pub frames: usize,
    pub bytes: u64,
    pub duration_ms: u64,
}

pub struct Mp4Writer<W: Write + Seek> {
    out: W,
    /// File offset of the `mdat` box header.
    mdat_at: u64,
    /// Current end of the file.
    pos: u64,
    sizes: Vec<u32>,
    offsets: Vec<u64>,
    /// Sample times in [`TIMESCALE`] units, strictly increasing from 0.
    times: Vec<u64>,
    /// 1-based numbers of key frames.
    sync: Vec<u32>,
}

impl<W: Write + Seek> Mp4Writer<W> {
    /// Writes `ftyp` and an open `mdat` header.
    pub fn new(mut out: W, brand: &[u8; 4]) -> io::Result<Self> {
        let mut head = Vec::new();
        bx(&mut head, b"ftyp", |b| {
            b.extend_from_slice(b"isom");
            b.extend_from_slice(&0x200u32.to_be_bytes());
            for compatible in [b"isom", b"iso2", b"mp41", brand] {
                b.extend_from_slice(compatible);
            }
        });
        let mdat_at = head.len() as u64;
        // size = 1: a 64-bit `largesize` follows the type, patched later.
        head.extend_from_slice(&1u32.to_be_bytes());
        head.extend_from_slice(b"mdat");
        head.extend_from_slice(&0u64.to_be_bytes());
        out.write_all(&head)?;
        Ok(Self {
            out,
            mdat_at,
            pos: head.len() as u64,
            sizes: Vec::new(),
            offsets: Vec::new(),
            times: Vec::new(),
            sync: Vec::new(),
        })
    }

    /// Appends one sample. `time_us` counts from the start of the file;
    /// a time that does not move forward is nudged by one tick.
    pub fn write_sample(&mut self, time_us: u64, data: &[u8], key: bool) -> io::Result<()> {
        let size = u32::try_from(data.len())
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "sample too large"))?;
        let mut time = time_us * u64::from(TIMESCALE) / 1_000_000;
        if let Some(&last) = self.times.last() {
            time = time.max(last + 1);
        } else {
            time = 0;
        }
        self.out.write_all(data)?;
        self.offsets.push(self.pos);
        self.pos += u64::from(size);
        self.sizes.push(size);
        self.times.push(time);
        if key {
            self.sync.push(self.sizes.len() as u32);
        }
        Ok(())
    }

    pub fn frames(&self) -> usize {
        self.sizes.len()
    }

    /// Size of the file so far.
    pub fn bytes(&self) -> u64 {
        self.pos
    }

    /// Media duration so far, counting the last frame as 1/60 s.
    pub fn duration_ms(&self) -> u64 {
        self.media_duration() * u64::from(MOVIE_TIMESCALE) / u64::from(TIMESCALE)
    }

    fn durations(&self) -> Vec<u32> {
        let mut out: Vec<u32> = self
            .times
            .windows(2)
            .map(|w| u32::try_from(w[1] - w[0]).unwrap_or(u32::MAX))
            .collect();
        if !self.times.is_empty() {
            out.push(LAST_SAMPLE);
        }
        out
    }

    fn media_duration(&self) -> u64 {
        self.times
            .last()
            .map_or(0, |&last| last + u64::from(LAST_SAMPLE))
    }

    /// Patches the `mdat` size and writes the `moov`. The output is
    /// returned so the caller can flush and sync it.
    pub fn finish(
        mut self,
        entry: &SampleEntry,
        width: u32,
        height: u32,
    ) -> io::Result<(W, Summary)> {
        let mdat_size = self.pos - self.mdat_at;
        self.out.seek(SeekFrom::Start(self.mdat_at + 8))?;
        self.out.write_all(&mdat_size.to_be_bytes())?;
        self.out.seek(SeekFrom::Start(self.pos))?;
        let moov = self.moov(entry, width, height);
        self.out.write_all(&moov)?;
        self.out.flush()?;
        let summary = Summary {
            frames: self.sizes.len(),
            bytes: self.pos + moov.len() as u64,
            duration_ms: self.duration_ms(),
        };
        Ok((self.out, summary))
    }

    fn moov(&self, entry: &SampleEntry, width: u32, height: u32) -> Vec<u8> {
        let media = self.media_duration();
        let movie = media * u64::from(MOVIE_TIMESCALE) / u64::from(TIMESCALE);
        let media = u32::try_from(media).unwrap_or(u32::MAX);
        let movie = u32::try_from(movie).unwrap_or(u32::MAX);
        let mut out = Vec::with_capacity(1024 + self.sizes.len() * 16);
        bx(&mut out, b"moov", |b| {
            full(b, b"mvhd", 0, 0, |b| {
                b.extend_from_slice(&[0; 8]); // creation, modification
                b.extend_from_slice(&MOVIE_TIMESCALE.to_be_bytes());
                b.extend_from_slice(&movie.to_be_bytes());
                b.extend_from_slice(&0x0001_0000u32.to_be_bytes()); // rate 1.0
                b.extend_from_slice(&0x0100u16.to_be_bytes()); // volume 1.0
                b.extend_from_slice(&[0; 10]);
                matrix(b);
                b.extend_from_slice(&[0; 24]); // pre_defined
                b.extend_from_slice(&2u32.to_be_bytes()); // next_track_ID
            });
            bx(b, b"trak", |b| {
                // Flags: enabled | in movie | in preview.
                full(b, b"tkhd", 0, 0x7, |b| {
                    b.extend_from_slice(&[0; 8]);
                    b.extend_from_slice(&1u32.to_be_bytes()); // track_ID
                    b.extend_from_slice(&[0; 4]);
                    b.extend_from_slice(&movie.to_be_bytes());
                    b.extend_from_slice(&[0; 8]);
                    b.extend_from_slice(&[0; 4]); // layer, alternate_group
                    b.extend_from_slice(&[0; 4]); // volume 0 (video), reserved
                    matrix(b);
                    b.extend_from_slice(&(width << 16).to_be_bytes());
                    b.extend_from_slice(&(height << 16).to_be_bytes());
                });
                bx(b, b"mdia", |b| {
                    full(b, b"mdhd", 0, 0, |b| {
                        b.extend_from_slice(&[0; 8]);
                        b.extend_from_slice(&TIMESCALE.to_be_bytes());
                        b.extend_from_slice(&media.to_be_bytes());
                        b.extend_from_slice(&0x55C4u16.to_be_bytes()); // "und"
                        b.extend_from_slice(&[0; 2]);
                    });
                    full(b, b"hdlr", 0, 0, |b| {
                        b.extend_from_slice(&[0; 4]);
                        b.extend_from_slice(b"vide");
                        b.extend_from_slice(&[0; 12]);
                        b.extend_from_slice(b"VideoHandler\0");
                    });
                    bx(b, b"minf", |b| {
                        full(b, b"vmhd", 0, 1, |b| b.extend_from_slice(&[0; 8]));
                        bx(b, b"dinf", |b| {
                            full(b, b"dref", 0, 0, |b| {
                                b.extend_from_slice(&1u32.to_be_bytes());
                                // Self-contained: data is in this file.
                                full(b, b"url ", 0, 1, |_| {});
                            });
                        });
                        self.stbl(b, entry, width, height);
                    });
                });
            });
        });
        out
    }

    fn stbl(&self, b: &mut Vec<u8>, entry: &SampleEntry, width: u32, height: u32) {
        bx(b, b"stbl", |b| {
            full(b, b"stsd", 0, 0, |b| {
                b.extend_from_slice(&1u32.to_be_bytes());
                let (kind, config) = entry.kinds();
                bx(b, kind, |b| {
                    b.extend_from_slice(&[0; 6]);
                    b.extend_from_slice(&1u16.to_be_bytes()); // data_reference_index
                    b.extend_from_slice(&[0; 16]); // pre_defined, reserved
                    b.extend_from_slice(&(width.min(0xFFFF) as u16).to_be_bytes());
                    b.extend_from_slice(&(height.min(0xFFFF) as u16).to_be_bytes());
                    b.extend_from_slice(&0x0048_0000u32.to_be_bytes()); // 72 dpi
                    b.extend_from_slice(&0x0048_0000u32.to_be_bytes());
                    b.extend_from_slice(&[0; 4]);
                    b.extend_from_slice(&1u16.to_be_bytes()); // frame_count
                    let mut name = [0u8; 32];
                    let label = b"Tether";
                    name[0] = label.len() as u8;
                    name[1..=label.len()].copy_from_slice(label);
                    b.extend_from_slice(&name);
                    b.extend_from_slice(&0x0018u16.to_be_bytes()); // depth
                    b.extend_from_slice(&(-1i16).to_be_bytes());
                    bx(b, config, |b| b.extend_from_slice(entry.record()));
                });
            });
            full(b, b"stts", 0, 0, |b| {
                let runs = runs(&self.durations());
                b.extend_from_slice(&(runs.len() as u32).to_be_bytes());
                for (count, delta) in runs {
                    b.extend_from_slice(&count.to_be_bytes());
                    b.extend_from_slice(&delta.to_be_bytes());
                }
            });
            full(b, b"stss", 0, 0, |b| {
                b.extend_from_slice(&(self.sync.len() as u32).to_be_bytes());
                for n in &self.sync {
                    b.extend_from_slice(&n.to_be_bytes());
                }
            });
            full(b, b"stsc", 0, 0, |b| {
                b.extend_from_slice(&1u32.to_be_bytes());
                b.extend_from_slice(&1u32.to_be_bytes()); // first_chunk
                b.extend_from_slice(&1u32.to_be_bytes()); // samples_per_chunk
                b.extend_from_slice(&1u32.to_be_bytes()); // description index
            });
            full(b, b"stsz", 0, 0, |b| {
                b.extend_from_slice(&0u32.to_be_bytes());
                b.extend_from_slice(&(self.sizes.len() as u32).to_be_bytes());
                for size in &self.sizes {
                    b.extend_from_slice(&size.to_be_bytes());
                }
            });
            full(b, b"co64", 0, 0, |b| {
                b.extend_from_slice(&(self.offsets.len() as u32).to_be_bytes());
                for offset in &self.offsets {
                    b.extend_from_slice(&offset.to_be_bytes());
                }
            });
        });
    }
}

/// `(count, value)` runs of equal neighbours, as `stts` stores them.
fn runs(values: &[u32]) -> Vec<(u32, u32)> {
    let mut out: Vec<(u32, u32)> = Vec::new();
    for &v in values {
        match out.last_mut() {
            Some((count, last)) if *last == v => *count += 1,
            _ => out.push((1, v)),
        }
    }
    out
}

fn matrix(b: &mut Vec<u8>) {
    for v in [0x0001_0000u32, 0, 0, 0, 0x0001_0000, 0, 0, 0, 0x4000_0000] {
        b.extend_from_slice(&v.to_be_bytes());
    }
}

/// Writes a box: 32-bit size, type, body.
fn bx(out: &mut Vec<u8>, kind: &[u8; 4], body: impl FnOnce(&mut Vec<u8>)) {
    let start = out.len();
    out.extend_from_slice(&[0; 4]);
    out.extend_from_slice(kind);
    body(out);
    let size = (out.len() - start) as u32;
    out[start..start + 4].copy_from_slice(&size.to_be_bytes());
}

/// A full box: a box whose body starts with version and 24-bit flags.
fn full(
    out: &mut Vec<u8>,
    kind: &[u8; 4],
    version: u8,
    flags: u32,
    body: impl FnOnce(&mut Vec<u8>),
) {
    bx(out, kind, |b| {
        b.push(version);
        b.extend_from_slice(&flags.to_be_bytes()[1..]);
        body(b);
    });
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;

    /// Child boxes of a box body: (type, body).
    fn children(mut data: &[u8]) -> Vec<([u8; 4], &[u8])> {
        let mut out = Vec::new();
        while data.len() >= 8 {
            let mut size = u32::from_be_bytes(data[..4].try_into().unwrap()) as u64;
            let kind: [u8; 4] = data[4..8].try_into().unwrap();
            let mut header = 8;
            if size == 1 {
                size = u64::from_be_bytes(data[8..16].try_into().unwrap());
                header = 16;
            }
            let size = size as usize;
            out.push((kind, &data[header..size]));
            data = &data[size..];
        }
        out
    }

    fn find<'a>(data: &'a [u8], path: &[&[u8; 4]]) -> &'a [u8] {
        let mut body = data;
        for (i, kind) in path.iter().enumerate() {
            // Skip the version/flags of full boxes and the stsd header.
            let found = children(body)
                .into_iter()
                .find(|(k, _)| k == *kind)
                .unwrap_or_else(|| panic!("no {:?}", std::str::from_utf8(*kind)))
                .1;
            body = match (*kind, path.get(i + 1)) {
                (b"stsd", Some(_)) => &found[8..],
                (b"dref", Some(_)) => &found[8..],
                _ => found,
            };
        }
        body
    }

    fn u32_at(b: &[u8], at: usize) -> u32 {
        u32::from_be_bytes(b[at..at + 4].try_into().unwrap())
    }

    #[test]
    fn writes_a_playable_layout() {
        let mut w = Mp4Writer::new(Cursor::new(Vec::new()), b"avc1").unwrap();
        // 3 frames at 60 fps from scrcpy-like microsecond PTS, one late.
        w.write_sample(0, &[1, 2, 3], true).unwrap();
        w.write_sample(16_667, &[4, 5], false).unwrap();
        w.write_sample(50_000, &[6], false).unwrap();
        w.write_sample(50_000, &[7, 7], true).unwrap(); // same PTS: nudged
        assert_eq!(w.frames(), 4);
        let entry = SampleEntry::Avc(vec![1, 0x42, 0xC0, 0x29, 0xFF, 0xE0, 0]);
        let (out, summary) = w.finish(&entry, 576, 1280).unwrap();
        let file = out.into_inner();
        assert_eq!(summary.bytes, file.len() as u64);
        assert_eq!(summary.frames, 4);

        let top = children(&file);
        let kinds: Vec<_> = top.iter().map(|(k, _)| *k).collect();
        assert_eq!(kinds, [*b"ftyp", *b"mdat", *b"moov"]);
        assert_eq!(&top[0].1[..4], b"isom");
        // mdat holds the samples back to back.
        assert_eq!(top[1].1, [1, 2, 3, 4, 5, 6, 7, 7]);

        let moov = top[2].1;
        let mvhd = find(moov, &[b"mvhd"]);
        assert_eq!(u32_at(mvhd, 12), 1000);
        // 50 ms + 1 tick + 1/60 s ≈ 66 ms.
        assert_eq!(u32_at(mvhd, 16), 66);

        let tkhd = find(moov, &[b"trak", b"tkhd"]);
        assert_eq!(u32_at(tkhd, 76), 576 << 16);
        assert_eq!(u32_at(tkhd, 80), 1280 << 16);

        let stbl = &[b"trak", b"mdia", b"minf", b"stbl"];
        let path = |last: &'static [u8; 4]| {
            let mut p = stbl.to_vec();
            p.push(last);
            p
        };
        let avc1 = find(
            moov,
            &path(b"stsd")
                .into_iter()
                .chain([b"avc1"])
                .collect::<Vec<_>>(),
        );
        assert_eq!(u16::from_be_bytes([avc1[24], avc1[25]]), 576);
        assert_eq!(u16::from_be_bytes([avc1[26], avc1[27]]), 1280);
        assert_eq!(&avc1[78 + 4..78 + 8], b"avcC");

        let stts = find(moov, &path(b"stts"));
        // 16_667 µs → 1500 ticks; 50_000 → 4500 (3000 more); +1; last 1500.
        assert_eq!(u32_at(stts, 4), 4);
        let entries: Vec<_> = (0..4)
            .map(|i| (u32_at(stts, 8 + i * 8), u32_at(stts, 12 + i * 8)))
            .collect();
        assert_eq!(entries, [(1, 1500), (1, 3000), (1, 1), (1, 1500)]);

        let stss = find(moov, &path(b"stss"));
        assert_eq!(
            (u32_at(stss, 4), u32_at(stss, 8), u32_at(stss, 12)),
            (2, 1, 4)
        );

        let stsz = find(moov, &path(b"stsz"));
        assert_eq!(u32_at(stsz, 8), 4);
        assert_eq!(u32_at(stsz, 12), 3);

        let co64 = find(moov, &path(b"co64"));
        let first = u64::from_be_bytes(co64[8..16].try_into().unwrap()) as usize;
        assert_eq!(&file[first..first + 3], [1, 2, 3]);
        let last = u64::from_be_bytes(co64[32..40].try_into().unwrap()) as usize;
        assert_eq!(&file[last..last + 2], [7, 7]);

        let mdhd = find(moov, &[b"trak", b"mdia", b"mdhd"]);
        assert_eq!(u32_at(mdhd, 12), TIMESCALE);
    }

    #[test]
    fn equal_durations_share_one_stts_run() {
        assert_eq!(runs(&[3, 3, 3, 5, 5, 3]), [(3, 3), (2, 5), (1, 3)]);
        assert!(runs(&[]).is_empty());
    }

    #[test]
    fn sample_entry_boxes() {
        assert_eq!(SampleEntry::Hevc(vec![]).kinds(), (b"hvc1", b"hvcC"));
        assert_eq!(SampleEntry::Av1(vec![]).kinds(), (b"av01", b"av1C"));
    }
}
