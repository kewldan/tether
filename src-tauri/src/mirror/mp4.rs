//! A minimal streaming MP4 (ISO BMFF) writer for one video track and an
//! optional Opus audio track.
//!
//! Samples go straight to disk inside one `mdat` with a 64-bit size, in
//! the order they arrive, so audio and video end up interleaved and memory
//! stays flat however long the recording runs (only the sample tables are
//! kept: ~16 bytes per sample). `finish` patches the `mdat` size and
//! appends the `moov`. One sample per chunk with `co64` offsets keeps the
//! tables trivial and files above 4 GB valid.
//!
//! Boxes follow ISO/IEC 14496-12 (container), 14496-15 (`avc1`/`hvc1`
//! sample entries with `avcC`/`hvcC`), the AV1-in-ISOBMFF binding (`av01`
//! with `av1C`) and the Opus-in-ISOBMFF encapsulation (`Opus` with `dOps`).
//! An audio track that starts after the video gets an edit list with an
//! empty edit, so both keep their place on the shared timeline.

use std::io::{self, Seek, SeekFrom, Write};

use super::opus;

/// Video media timescale: 90 kHz, the usual video clock; scrcpy's
/// microsecond PTS are converted per sample, so rounding never accumulates.
pub const TIMESCALE: u32 = 90_000;
/// Audio media timescale: the Opus sample rate.
pub const AUDIO_TIMESCALE: u32 = opus::SAMPLE_RATE;
/// Movie (presentation) timescale: milliseconds.
const MOVIE_TIMESCALE: u32 = 1000;
/// Duration given to the last video sample (its successor never came).
const LAST_SAMPLE: u32 = TIMESCALE / 60;
/// Fallback duration of an Opus packet whose TOC is unreadable: 20 ms.
const OPUS_PACKET: u32 = AUDIO_TIMESCALE / 50;
/// An audio packet this much later than the end of the previous one marks
/// a gap in the capture: 100 ms.
const AUDIO_GAP: u32 = AUDIO_TIMESCALE / 10;

/// Video codec configuration that goes into the sample description.
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

/// Opus sample description: an `Opus` entry with its `dOps` body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AudioEntry {
    pub channels: u8,
    pub dops: Vec<u8>,
}

impl From<opus::OpusConfig> for AudioEntry {
    fn from(c: opus::OpusConfig) -> Self {
        Self {
            channels: c.channels,
            dops: c.dops,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Track {
    Video,
    Audio,
}

/// What a finished file contains.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Summary {
    pub frames: usize,
    /// Opus packets in the audio track; 0 when the file has no audio.
    pub audio_packets: usize,
    pub bytes: u64,
    pub duration_ms: u64,
}

/// Sample tables of one track.
#[derive(Default)]
struct Table {
    sizes: Vec<u32>,
    offsets: Vec<u64>,
    /// Sample times in the track's timescale, strictly increasing.
    times: Vec<u64>,
    /// 1-based numbers of key frames (video only).
    sync: Vec<u32>,
    /// Duration of the last sample.
    last: u32,
}

impl Table {
    fn push(&mut self, offset: u64, size: u32, mut time: u64, key: bool) {
        if let Some(&last) = self.times.last() {
            time = time.max(last + 1);
        }
        self.offsets.push(offset);
        self.sizes.push(size);
        self.times.push(time);
        if key {
            self.sync.push(self.sizes.len() as u32);
        }
    }

    fn start(&self) -> u64 {
        self.times.first().copied().unwrap_or(0)
    }

    /// Media time from the first sample to the end of the last one.
    fn span(&self) -> u64 {
        match (self.times.first(), self.times.last()) {
            (Some(first), Some(last)) => last - first + u64::from(self.last),
            _ => 0,
        }
    }

    fn durations(&self) -> Vec<u32> {
        let mut out: Vec<u32> = self
            .times
            .windows(2)
            .map(|w| u32::try_from(w[1] - w[0]).unwrap_or(u32::MAX))
            .collect();
        if !self.times.is_empty() {
            out.push(self.last);
        }
        out
    }
}

/// Converts `value` from `from` units to `to` units.
fn rescale(value: u64, from: u32, to: u32) -> u64 {
    value * u64::from(to) / u64::from(from)
}

pub struct Mp4Writer<W: Write + Seek> {
    out: W,
    /// File offset of the `mdat` box header.
    mdat_at: u64,
    /// Current end of the file.
    pos: u64,
    video: Table,
    audio: Table,
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
            video: Table {
                last: LAST_SAMPLE,
                ..Table::default()
            },
            audio: Table {
                last: OPUS_PACKET,
                ..Table::default()
            },
        })
    }

    /// Appends one sample. `time_us` counts from the start of the file
    /// (the first video frame); the video track always starts at 0. A time
    /// that does not move forward is nudged by one tick.
    pub fn write_sample(
        &mut self,
        track: Track,
        time_us: u64,
        data: &[u8],
        key: bool,
    ) -> io::Result<()> {
        let size = u32::try_from(data.len())
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "sample too large"))?;
        self.out.write_all(data)?;
        let offset = self.pos;
        self.pos += u64::from(size);
        match track {
            Track::Video => {
                let mut time = rescale(time_us, 1_000_000, TIMESCALE);
                if self.video.times.is_empty() {
                    time = 0;
                }
                self.video.push(offset, size, time, key);
            }
            Track::Audio => {
                // Capture PTS jitter (packets arrive in bursts) must not
                // shorten or overlap packets: they play back to back, and
                // only a real gap in the capture moves the next one.
                let pts = rescale(time_us, 1_000_000, AUDIO_TIMESCALE);
                let time = match self.audio.times.last() {
                    Some(&last) => {
                        let next = last + u64::from(self.audio.last);
                        if pts > next + u64::from(AUDIO_GAP) {
                            pts
                        } else {
                            next
                        }
                    }
                    None => pts,
                };
                self.audio.push(offset, size, time, true);
                self.audio.last = opus::packet_samples(data).unwrap_or(OPUS_PACKET);
            }
        }
        Ok(())
    }

    pub fn frames(&self) -> usize {
        self.video.sizes.len()
    }

    /// Size of the file so far.
    pub fn bytes(&self) -> u64 {
        self.pos
    }

    /// Duration so far, counting the last video frame as 1/60 s.
    pub fn duration_ms(&self) -> u64 {
        self.video_ms().max(self.audio_end_ms())
    }

    fn video_ms(&self) -> u64 {
        rescale(self.video.span(), TIMESCALE, MOVIE_TIMESCALE)
    }

    /// Where the audio track starts on the movie timeline.
    fn audio_offset_ms(&self) -> u64 {
        rescale(self.audio.start(), AUDIO_TIMESCALE, MOVIE_TIMESCALE)
    }

    fn audio_ms(&self) -> u64 {
        rescale(self.audio.span(), AUDIO_TIMESCALE, MOVIE_TIMESCALE)
    }

    fn audio_end_ms(&self) -> u64 {
        if self.audio.times.is_empty() {
            0
        } else {
            self.audio_offset_ms() + self.audio_ms()
        }
    }

    /// Patches the `mdat` size and writes the `moov`; the audio track is
    /// included when `audio` is given and at least one packet was written.
    /// The output is returned so the caller can flush and sync it.
    pub fn finish(
        mut self,
        video: &SampleEntry,
        width: u32,
        height: u32,
        audio: Option<&AudioEntry>,
    ) -> io::Result<(W, Summary)> {
        let audio = audio.filter(|_| !self.audio.times.is_empty());
        let mdat_size = self.pos - self.mdat_at;
        self.out.seek(SeekFrom::Start(self.mdat_at + 8))?;
        self.out.write_all(&mdat_size.to_be_bytes())?;
        self.out.seek(SeekFrom::Start(self.pos))?;
        let moov = self.moov(video, width, height, audio);
        self.out.write_all(&moov)?;
        self.out.flush()?;
        let summary = Summary {
            frames: self.video.sizes.len(),
            audio_packets: if audio.is_some() {
                self.audio.sizes.len()
            } else {
                0
            },
            bytes: self.pos + moov.len() as u64,
            duration_ms: if audio.is_some() {
                self.duration_ms()
            } else {
                self.video_ms()
            },
        };
        Ok((self.out, summary))
    }

    fn moov(
        &self,
        video: &SampleEntry,
        width: u32,
        height: u32,
        audio: Option<&AudioEntry>,
    ) -> Vec<u8> {
        let movie = if audio.is_some() {
            self.duration_ms()
        } else {
            self.video_ms()
        };
        let movie = u32::try_from(movie).unwrap_or(u32::MAX);
        let tracks = if audio.is_some() { 2 } else { 1 };
        let mut out =
            Vec::with_capacity(1024 + (self.video.sizes.len() + self.audio.sizes.len()) * 16);
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
                b.extend_from_slice(&(tracks + 1u32).to_be_bytes()); // next_track_ID
            });
            self.video_trak(b, video, width, height);
            if let Some(audio) = audio {
                self.audio_trak(b, audio);
            }
        });
        out
    }

    fn video_trak(&self, b: &mut Vec<u8>, entry: &SampleEntry, width: u32, height: u32) {
        let media = u32::try_from(self.video.span()).unwrap_or(u32::MAX);
        let duration = u32::try_from(self.video_ms()).unwrap_or(u32::MAX);
        bx(b, b"trak", |b| {
            tkhd(b, 1, duration, false, width, height);
            bx(b, b"mdia", |b| {
                mdhd(b, TIMESCALE, media);
                hdlr(b, b"vide", b"VideoHandler\0");
                bx(b, b"minf", |b| {
                    full(b, b"vmhd", 0, 1, |b| b.extend_from_slice(&[0; 8]));
                    dinf(b);
                    bx(b, b"stbl", |b| {
                        full(b, b"stsd", 0, 0, |b| {
                            b.extend_from_slice(&1u32.to_be_bytes());
                            visual_entry(b, entry, width, height);
                        });
                        self.video.tables(b, true);
                    });
                });
            });
        });
    }

    fn audio_trak(&self, b: &mut Vec<u8>, entry: &AudioEntry) {
        let media = u32::try_from(self.audio.span()).unwrap_or(u32::MAX);
        let offset = u32::try_from(self.audio_offset_ms()).unwrap_or(u32::MAX);
        let span = u32::try_from(self.audio_ms()).unwrap_or(u32::MAX);
        bx(b, b"trak", |b| {
            tkhd(b, 2, offset.saturating_add(span), true, 0, 0);
            if offset > 0 {
                bx(b, b"edts", |b| {
                    full(b, b"elst", 0, 0, |b| {
                        b.extend_from_slice(&2u32.to_be_bytes());
                        // Empty edit: nothing plays until the audio starts.
                        b.extend_from_slice(&offset.to_be_bytes());
                        b.extend_from_slice(&(-1i32).to_be_bytes());
                        b.extend_from_slice(&0x0001_0000u32.to_be_bytes());
                        // Then the whole media from its first sample.
                        b.extend_from_slice(&span.to_be_bytes());
                        b.extend_from_slice(&0u32.to_be_bytes());
                        b.extend_from_slice(&0x0001_0000u32.to_be_bytes());
                    });
                });
            }
            bx(b, b"mdia", |b| {
                mdhd(b, AUDIO_TIMESCALE, media);
                hdlr(b, b"soun", b"SoundHandler\0");
                bx(b, b"minf", |b| {
                    full(b, b"smhd", 0, 0, |b| b.extend_from_slice(&[0; 4]));
                    dinf(b);
                    bx(b, b"stbl", |b| {
                        full(b, b"stsd", 0, 0, |b| {
                            b.extend_from_slice(&1u32.to_be_bytes());
                            bx(b, b"Opus", |b| {
                                b.extend_from_slice(&[0; 6]);
                                b.extend_from_slice(&1u16.to_be_bytes()); // data_reference_index
                                b.extend_from_slice(&[0; 8]); // reserved
                                b.extend_from_slice(&u16::from(entry.channels).to_be_bytes());
                                b.extend_from_slice(&16u16.to_be_bytes()); // samplesize
                                b.extend_from_slice(&[0; 4]); // pre_defined, reserved
                                b.extend_from_slice(&(AUDIO_TIMESCALE << 16).to_be_bytes());
                                bx(b, b"dOps", |b| b.extend_from_slice(&entry.dops));
                            });
                        });
                        self.audio.tables(b, false);
                    });
                });
            });
        });
    }
}

impl Table {
    /// `stts`, `stss` (when `sync`), `stsc`, `stsz` and `co64`.
    fn tables(&self, b: &mut Vec<u8>, sync: bool) {
        full(b, b"stts", 0, 0, |b| {
            let runs = runs(&self.durations());
            b.extend_from_slice(&(runs.len() as u32).to_be_bytes());
            for (count, delta) in runs {
                b.extend_from_slice(&count.to_be_bytes());
                b.extend_from_slice(&delta.to_be_bytes());
            }
        });
        if sync {
            full(b, b"stss", 0, 0, |b| {
                b.extend_from_slice(&(self.sync.len() as u32).to_be_bytes());
                for n in &self.sync {
                    b.extend_from_slice(&n.to_be_bytes());
                }
            });
        }
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
    }
}

fn tkhd(b: &mut Vec<u8>, id: u32, duration: u32, audio: bool, width: u32, height: u32) {
    // Flags: enabled | in movie | in preview.
    full(b, b"tkhd", 0, 0x7, |b| {
        b.extend_from_slice(&[0; 8]);
        b.extend_from_slice(&id.to_be_bytes()); // track_ID
        b.extend_from_slice(&[0; 4]);
        b.extend_from_slice(&duration.to_be_bytes());
        b.extend_from_slice(&[0; 8]);
        b.extend_from_slice(&[0; 4]); // layer, alternate_group
        // Volume 1.0 for audio, 0 for video; reserved.
        b.extend_from_slice(&(if audio { 0x0100u16 } else { 0 }).to_be_bytes());
        b.extend_from_slice(&[0; 2]);
        matrix(b);
        b.extend_from_slice(&(width << 16).to_be_bytes());
        b.extend_from_slice(&(height << 16).to_be_bytes());
    });
}

fn mdhd(b: &mut Vec<u8>, timescale: u32, duration: u32) {
    full(b, b"mdhd", 0, 0, |b| {
        b.extend_from_slice(&[0; 8]);
        b.extend_from_slice(&timescale.to_be_bytes());
        b.extend_from_slice(&duration.to_be_bytes());
        b.extend_from_slice(&0x55C4u16.to_be_bytes()); // "und"
        b.extend_from_slice(&[0; 2]);
    });
}

fn hdlr(b: &mut Vec<u8>, kind: &[u8; 4], name: &[u8]) {
    full(b, b"hdlr", 0, 0, |b| {
        b.extend_from_slice(&[0; 4]);
        b.extend_from_slice(kind);
        b.extend_from_slice(&[0; 12]);
        b.extend_from_slice(name);
    });
}

fn dinf(b: &mut Vec<u8>) {
    bx(b, b"dinf", |b| {
        full(b, b"dref", 0, 0, |b| {
            b.extend_from_slice(&1u32.to_be_bytes());
            // Self-contained: data is in this file.
            full(b, b"url ", 0, 1, |_| {});
        });
    });
}

fn visual_entry(b: &mut Vec<u8>, entry: &SampleEntry, width: u32, height: u32) {
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

    /// Body of the `nth` box of `kind` among the children of `data`.
    fn nth<'a>(data: &'a [u8], kind: &[u8; 4], n: usize) -> &'a [u8] {
        children(data)
            .into_iter()
            .filter(|(k, _)| k == kind)
            .nth(n)
            .unwrap_or_else(|| panic!("no {:?} #{n}", std::str::from_utf8(kind)))
            .1
    }

    fn find<'a>(data: &'a [u8], path: &[&[u8; 4]]) -> &'a [u8] {
        let mut body = data;
        for (i, kind) in path.iter().enumerate() {
            let found = nth(body, kind, 0);
            // Skip the version/flags of full boxes and the entry count.
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

    fn stts_entries(stts: &[u8]) -> Vec<(u32, u32)> {
        (0..u32_at(stts, 4) as usize)
            .map(|i| (u32_at(stts, 8 + i * 8), u32_at(stts, 12 + i * 8)))
            .collect()
    }

    #[test]
    fn writes_a_playable_layout() {
        let mut w = Mp4Writer::new(Cursor::new(Vec::new()), b"avc1").unwrap();
        // 3 frames at 60 fps from scrcpy-like microsecond PTS, one late.
        w.write_sample(Track::Video, 0, &[1, 2, 3], true).unwrap();
        w.write_sample(Track::Video, 16_667, &[4, 5], false)
            .unwrap();
        w.write_sample(Track::Video, 50_000, &[6], false).unwrap();
        w.write_sample(Track::Video, 50_000, &[7, 7], true).unwrap(); // same PTS: nudged
        assert_eq!(w.frames(), 4);
        let entry = SampleEntry::Avc(vec![1, 0x42, 0xC0, 0x29, 0xFF, 0xE0, 0]);
        let (out, summary) = w.finish(&entry, 576, 1280, None).unwrap();
        let file = out.into_inner();
        assert_eq!(summary.bytes, file.len() as u64);
        assert_eq!(summary.frames, 4);
        assert_eq!(summary.audio_packets, 0);

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
        assert_eq!(u32_at(mvhd, 96), 2, "next_track_ID");
        assert_eq!(children(moov).len(), 2, "mvhd and one trak");

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

        // 16_667 µs → 1500 ticks; 50_000 → 4500 (3000 more); +1; last 1500.
        let stts = find(moov, &path(b"stts"));
        assert_eq!(
            stts_entries(stts),
            [(1, 1500), (1, 3000), (1, 1), (1, 1500)]
        );

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
    fn interleaves_an_opus_track() {
        let mut w = Mp4Writer::new(Cursor::new(Vec::new()), b"avc1").unwrap();
        // Audio starts 30 ms after the first frame; 20 ms CELT packets.
        w.write_sample(Track::Video, 0, &[0xAA], true).unwrap();
        w.write_sample(Track::Audio, 30_000, &[0xFC, 1], true)
            .unwrap();
        w.write_sample(Track::Video, 33_333, &[0xBB], false)
            .unwrap();
        w.write_sample(Track::Audio, 50_000, &[0xFC, 2], true)
            .unwrap();
        w.write_sample(Track::Audio, 70_000, &[0xFC, 3], true)
            .unwrap();
        let video = SampleEntry::Avc(vec![1, 0x42, 0xC0, 0x29, 0xFF, 0xE0, 0]);
        let audio = AudioEntry {
            channels: 2,
            dops: vec![0, 2, 0x01, 0x38, 0, 0, 0xBB, 0x80, 0, 0, 0],
        };
        let (out, summary) = w.finish(&video, 8, 16, Some(&audio)).unwrap();
        let file = out.into_inner();
        assert_eq!(summary.frames, 2);
        assert_eq!(summary.audio_packets, 3);
        // Audio ends at 30 + 3 × 20 ms; video at 33.3 + 16.7 ms.
        assert_eq!(summary.duration_ms, 90);

        let top = children(&file);
        // Samples in arrival order: interleaved.
        assert_eq!(top[1].1, [0xAA, 0xFC, 1, 0xBB, 0xFC, 2, 0xFC, 3]);
        let moov = top[2].1;
        let mvhd = find(moov, &[b"mvhd"]);
        assert_eq!(u32_at(mvhd, 16), 90);
        assert_eq!(u32_at(mvhd, 96), 3, "next_track_ID");

        let trak = nth(moov, b"trak", 1);
        let tkhd = nth(trak, b"tkhd", 0);
        assert_eq!(u32_at(tkhd, 12), 2, "track_ID");
        assert_eq!(u32_at(tkhd, 20), 90, "duration including the edit");
        assert_eq!(u16::from_be_bytes([tkhd[36], tkhd[37]]), 0x0100, "volume");

        let elst = find(trak, &[b"edts", b"elst"]);
        assert_eq!(u32_at(elst, 4), 2);
        assert_eq!((u32_at(elst, 8), u32_at(elst, 12)), (30, u32::MAX));
        assert_eq!((u32_at(elst, 20), u32_at(elst, 24)), (60, 0));

        let mdia = nth(trak, b"mdia", 0);
        let mdhd = nth(mdia, b"mdhd", 0);
        assert_eq!(u32_at(mdhd, 12), 48_000);
        assert_eq!(u32_at(mdhd, 16), 2880);
        assert_eq!(&nth(mdia, b"hdlr", 0)[8..12], b"soun");

        let stbl = find(mdia, &[b"minf", b"stbl"]);
        let opus = find(stbl, &[b"stsd", b"Opus"]);
        assert_eq!(u16::from_be_bytes([opus[16], opus[17]]), 2, "channels");
        assert_eq!(u32_at(opus, 24), 48_000 << 16);
        assert_eq!(&opus[32..36], b"dOps");
        assert_eq!(&opus[36..], audio.dops);
        assert_eq!(stts_entries(nth(stbl, b"stts", 0)), [(3, 960)]);
        assert!(children(stbl).iter().all(|(k, _)| k != b"stss"));
        let co64 = nth(stbl, b"co64", 0);
        let second = u64::from_be_bytes(co64[16..24].try_into().unwrap()) as usize;
        assert_eq!(&file[second..second + 2], [0xFC, 2]);
    }

    #[test]
    fn audio_plays_back_to_back_until_a_gap() {
        let mut w = Mp4Writer::new(Cursor::new(Vec::new()), b"avc1").unwrap();
        w.write_sample(Track::Video, 0, &[1], true).unwrap();
        // Bursty capture PTS (as the emulator sends at start), then a
        // 300 ms gap, then a 10 ms packet.
        for pts in [0, 5_129, 5_239, 21_929, 44_944, 345_000] {
            w.write_sample(Track::Audio, pts, &[0xFC], true).unwrap();
        }
        w.write_sample(Track::Audio, 365_000, &[0xF0], true)
            .unwrap();
        let audio = AudioEntry {
            channels: 2,
            dops: vec![0; 11],
        };
        let video = SampleEntry::Avc(vec![1]);
        let (out, summary) = w.finish(&video, 8, 8, Some(&audio)).unwrap();
        // 345 ms + 20 ms + 10 ms.
        assert_eq!(summary.duration_ms, 375);
        let file = out.into_inner();
        let moov = children(&file)[2].1;
        let stbl = find(nth(moov, b"trak", 1), &[b"mdia", b"minf", b"stbl"]);
        assert_eq!(
            stts_entries(nth(stbl, b"stts", 0)),
            [(4, 960), (1, 16_560 - 3_840), (1, 960), (1, 480)]
        );
    }

    #[test]
    fn audio_without_packets_is_left_out() {
        let mut w = Mp4Writer::new(Cursor::new(Vec::new()), b"avc1").unwrap();
        w.write_sample(Track::Video, 0, &[1], true).unwrap();
        let audio = AudioEntry {
            channels: 2,
            dops: vec![0; 11],
        };
        let video = SampleEntry::Avc(vec![1]);
        let (out, summary) = w.finish(&video, 8, 8, Some(&audio)).unwrap();
        assert_eq!(summary.audio_packets, 0);
        let file = out.into_inner();
        let moov = children(&file)[2].1;
        assert_eq!(children(moov).len(), 2, "mvhd and the video trak");
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
