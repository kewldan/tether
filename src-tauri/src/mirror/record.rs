//! Recording the mirrored stream to MP4 without re-encoding.
//!
//! The video loop hands every packet to the session's [`Tap`]. The tap
//! remembers the latest session size and codec config (also as frontend
//! records, so a newly attached view can start decoding at once) and, while
//! a [`Recorder`] is attached, forwards packets to its writer thread. The
//! thread waits for a key frame, converts the packets to MP4 samples
//! (length-prefixed NAL units, or AV1 OBUs without temporal delimiters) and
//! streams them to disk with [`Mp4Writer`].
//!
//! A config change mid-recording (rotation, encoder reset) keeps the first
//! sample description; the new parameter sets are prepended to the next
//! key frame, as scrcpy's own recorder does, which players decode in-band.
//!
//! Opus audio (when the session streams it) goes to a second track. Both
//! streams carry PTS from the device's monotonic clock, so audio is placed
//! relative to the first recorded video frame; packets from before it are
//! dropped.

use std::fs::File;
use std::io::BufWriter;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::sync::oneshot;

use super::codec;
use super::mp4::{AudioEntry, Mp4Writer, SampleEntry, Summary, Track};
use super::opus;
use super::protocol::{Header, VideoCodec};
use crate::error::{AppError, AppResult};
use crate::state::lock;

/// How often the writer reports progress.
const PROGRESS_EVERY: Duration = Duration::from_secs(1);

/// Stream packets the writer thread needs.
#[derive(Debug)]
pub enum Packet {
    Session {
        width: u32,
        height: u32,
    },
    Config(Vec<u8>),
    Frame {
        key: bool,
        pts: u64,
        data: Vec<u8>,
    },
    /// The `OpusHead` of the audio stream.
    AudioConfig(Vec<u8>),
    /// One Opus packet.
    Audio {
        pts: u64,
        data: Vec<u8>,
    },
}

#[derive(Default)]
struct Cache {
    /// Last session and config records in frontend format.
    session_record: Vec<u8>,
    config_record: Vec<u8>,
    /// Same, raw, for a recorder that starts mid-stream.
    size: Option<(u32, u32)>,
    config: Option<Vec<u8>>,
    /// Last audio config record, and the `OpusHead` for recorders.
    audio_config_record: Vec<u8>,
    opus_head: Option<Vec<u8>>,
}

/// Per-session observer of the video stream.
#[derive(Default)]
pub struct Tap {
    cache: Mutex<Cache>,
    recorder: Mutex<Option<Recorder>>,
}

impl Tap {
    /// Called by the video loop for every packet; `record` is what the
    /// packet was converted to for the frontend.
    pub fn observe(&self, header: Header, payload: &[u8], record: &[u8]) {
        let packet = match header {
            Header::Session { width, height } => {
                let mut cache = lock(&self.cache);
                cache.session_record = record.to_vec();
                cache.size = Some((width, height));
                Packet::Session { width, height }
            }
            Header::Media { config: true, .. } => {
                let mut cache = lock(&self.cache);
                cache.config_record = record.to_vec();
                cache.config = Some(payload.to_vec());
                Packet::Config(payload.to_vec())
            }
            Header::Media { key_frame, pts, .. } => {
                let recorder = lock(&self.recorder);
                if let Some(r) = recorder.as_ref() {
                    r.send(Packet::Frame {
                        key: key_frame,
                        pts,
                        data: payload.to_vec(),
                    });
                }
                return;
            }
        };
        if let Some(r) = lock(&self.recorder).as_ref() {
            r.send(packet);
        }
    }

    /// Called by the audio loop once the stream format is known: `record`
    /// is the frontend's audio config record, `opus_head` the stream's
    /// `OpusHead` when it is recordable Opus.
    pub fn audio_config(&self, record: &[u8], opus_head: Option<&[u8]>) {
        {
            let mut cache = lock(&self.cache);
            cache.audio_config_record = record.to_vec();
            cache.opus_head = opus_head.map(<[u8]>::to_vec);
        }
        if let (Some(head), Some(r)) = (opus_head, lock(&self.recorder).as_ref()) {
            r.send(Packet::AudioConfig(head.to_vec()));
        }
    }

    /// One Opus packet of the audio stream.
    pub fn audio_packet(&self, pts: u64, data: &[u8]) {
        if let Some(r) = lock(&self.recorder).as_ref() {
            r.send(Packet::Audio {
                pts,
                data: data.to_vec(),
            });
        }
    }

    /// The session size and decoder config records seen last (video and
    /// audio), so a new view can configure its decoders before the next
    /// key frame.
    pub fn cached_records(&self) -> Vec<u8> {
        let cache = lock(&self.cache);
        [
            cache.session_record.as_slice(),
            &cache.config_record,
            &cache.audio_config_record,
        ]
        .concat()
    }

    pub fn is_recording(&self) -> bool {
        lock(&self.recorder).is_some()
    }

    /// Attaches a recorder, seeding it with the current size and config.
    pub fn attach(&self, recorder: Recorder) -> AppResult<()> {
        let mut slot = lock(&self.recorder);
        if slot.is_some() {
            return Err(AppError::InvalidInput(
                "this device is already being recorded".into(),
            ));
        }
        let cache = lock(&self.cache);
        if let Some((width, height)) = cache.size {
            recorder.send(Packet::Session { width, height });
        }
        if let Some(config) = &cache.config {
            recorder.send(Packet::Config(config.clone()));
        }
        if let Some(head) = &cache.opus_head {
            recorder.send(Packet::AudioConfig(head.clone()));
        }
        *slot = Some(recorder);
        Ok(())
    }

    pub fn detach(&self) -> Option<Recorder> {
        lock(&self.recorder).take()
    }
}

/// Progress of a running recording.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Progress {
    pub bytes: u64,
    pub duration_ms: u64,
}

/// A finished recording.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Saved {
    pub path: PathBuf,
    pub summary: Summary,
}

pub type ProgressSink = Box<dyn Fn(Progress) + Send>;
/// Called when the recording ended without `stop` (the session went away).
pub type EndSink = Box<dyn FnOnce(AppResult<Saved>) + Send>;

/// A running recording. Dropping it (with the session) finishes the file
/// and reports through the end sink; [`Recorder::stop`] finishes it and
/// returns the result instead.
pub struct Recorder {
    tx: mpsc::Sender<Packet>,
    stopped: Arc<AtomicBool>,
    done: oneshot::Receiver<AppResult<Saved>>,
    pub path: PathBuf,
    pub started: Instant,
}

impl Recorder {
    /// Creates `path` and starts the writer thread for `codec`.
    pub fn start(
        codec: VideoCodec,
        path: PathBuf,
        on_progress: ProgressSink,
        on_end: EndSink,
    ) -> AppResult<Self> {
        let file = File::create(&path)?;
        let writer = Mp4Writer::new(BufWriter::with_capacity(1 << 20, file), brand(codec))?;
        let (tx, rx) = mpsc::channel();
        let (done_tx, done) = oneshot::channel();
        let stopped = Arc::new(AtomicBool::new(false));
        let thread_stopped = stopped.clone();
        let thread_path = path.clone();
        std::thread::Builder::new()
            .name("mirror-recorder".into())
            .spawn(move || {
                let result = write_loop(codec, writer, &rx, &thread_path, on_progress);
                if result.is_err() {
                    let _ = std::fs::remove_file(&thread_path);
                }
                if thread_stopped.load(Ordering::SeqCst) {
                    let _ = done_tx.send(result);
                } else {
                    on_end(result);
                }
            })?;
        Ok(Self {
            tx,
            stopped,
            done,
            path,
            started: Instant::now(),
        })
    }

    fn send(&self, packet: Packet) {
        // The thread only goes away after a write error; it reports that.
        let _ = self.tx.send(packet);
    }

    /// Finishes the file and waits for the writer.
    pub async fn stop(self) -> AppResult<Saved> {
        self.stopped.store(true, Ordering::SeqCst);
        let Self { tx, done, .. } = self;
        drop(tx);
        done.await
            .unwrap_or_else(|_| Err(AppError::Device("the recorder stopped unexpectedly".into())))
    }
}

fn brand(codec: VideoCodec) -> &'static [u8; 4] {
    match codec {
        VideoCodec::H264 => b"avc1",
        VideoCodec::H265 => b"iso6",
        VideoCodec::Av1 => b"av01",
    }
}

/// Sample description for a config packet of `codec`.
pub fn sample_entry(codec: VideoCodec, config: &[u8]) -> AppResult<SampleEntry> {
    let entry = match codec {
        VideoCodec::H264 => codec::h264_config(config).map(|c| SampleEntry::Avc(c.description)),
        VideoCodec::H265 => codec::hevc_record(config).map(SampleEntry::Hevc),
        // MediaCodec hands out an av1C record (marker bit + version 1).
        VideoCodec::Av1 => {
            (config.first() == Some(&0x81)).then(|| SampleEntry::Av1(config.to_vec()))
        }
    };
    entry.ok_or_else(|| AppError::Protocol("the codec config cannot be recorded".into()))
}

/// Converts one encoded frame to MP4 sample data.
pub fn sample_data(codec: VideoCodec, frame: &[u8]) -> Vec<u8> {
    match codec {
        VideoCodec::H264 | VideoCodec::H265 => codec::to_length_prefixed(frame),
        VideoCodec::Av1 => codec::av1_sample(frame),
    }
}

/// One sample for the MP4 writer.
#[derive(Debug, PartialEq, Eq)]
pub struct Sample {
    pub track: Track,
    /// Microseconds since the first recorded video frame.
    pub time_us: u64,
    pub data: Vec<u8>,
    pub key: bool,
}

/// Pure packet → sample logic, separate from the thread for testing.
pub struct Muxer {
    codec: VideoCodec,
    size: Option<(u32, u32)>,
    config: Option<Vec<u8>>,
    /// Sample description and dimensions, fixed by the first key frame.
    track: Option<(SampleEntry, u32, u32, Vec<u8>)>,
    first_pts: u64,
    /// Parameter sets to put in front of the next key frame.
    pending_params: Option<Vec<u8>>,
    /// Opus sample description, fixed by the first readable `OpusHead`.
    audio: Option<AudioEntry>,
}

impl Muxer {
    pub fn new(codec: VideoCodec) -> Self {
        Self {
            codec,
            size: None,
            config: None,
            track: None,
            first_pts: 0,
            pending_params: None,
            audio: None,
        }
    }

    /// Feeds one packet; returns the sample to write, if any.
    pub fn push(&mut self, packet: Packet) -> AppResult<Option<Sample>> {
        match packet {
            Packet::Session { width, height } => {
                self.size = Some((width, height));
                Ok(None)
            }
            Packet::Config(config) => {
                if let Some((_, _, _, track_config)) = &self.track
                    && *track_config != config
                    && self.codec != VideoCodec::Av1
                {
                    self.pending_params = Some(codec::to_length_prefixed(&config));
                }
                self.config = Some(config);
                Ok(None)
            }
            Packet::Frame { key, pts, data } => {
                if self.track.is_none() {
                    // Start on a key frame with a known config and size.
                    let (Some(config), Some((w, h)), true) = (&self.config, self.size, key) else {
                        return Ok(None);
                    };
                    let entry = sample_entry(self.codec, config)?;
                    self.track = Some((entry, w, h, config.clone()));
                    self.first_pts = pts;
                }
                let mut sample = sample_data(self.codec, &data);
                if key && let Some(mut params) = self.pending_params.take() {
                    params.extend_from_slice(&sample);
                    sample = params;
                }
                Ok(Some(Sample {
                    track: Track::Video,
                    time_us: pts.saturating_sub(self.first_pts),
                    data: sample,
                    key,
                }))
            }
            Packet::AudioConfig(head) => {
                if self.audio.is_none() {
                    self.audio = opus::parse_opus_head(&head).map(AudioEntry::from);
                }
                Ok(None)
            }
            Packet::Audio { pts, data } => {
                // Audio joins the video timeline once it has started.
                if self.track.is_none() || self.audio.is_none() || pts < self.first_pts {
                    return Ok(None);
                }
                Ok(Some(Sample {
                    track: Track::Audio,
                    time_us: pts - self.first_pts,
                    data,
                    key: true,
                }))
            }
        }
    }

    pub fn track(&self) -> Option<(&SampleEntry, u32, u32)> {
        self.track.as_ref().map(|(e, w, h, _)| (e, *w, *h))
    }

    pub fn audio(&self) -> Option<&AudioEntry> {
        self.audio.as_ref()
    }
}

fn write_loop(
    codec: VideoCodec,
    mut writer: Mp4Writer<BufWriter<File>>,
    rx: &mpsc::Receiver<Packet>,
    path: &Path,
    on_progress: ProgressSink,
) -> AppResult<Saved> {
    let mut muxer = Muxer::new(codec);
    let mut last_progress = Instant::now();
    while let Ok(packet) = rx.recv() {
        if let Some(s) = muxer.push(packet)? {
            writer.write_sample(s.track, s.time_us, &s.data, s.key)?;
            if last_progress.elapsed() >= PROGRESS_EVERY {
                last_progress = Instant::now();
                on_progress(Progress {
                    bytes: writer.bytes(),
                    duration_ms: writer.duration_ms(),
                });
            }
        }
    }
    let Some((entry, width, height)) = muxer.track() else {
        return Err(AppError::Device(
            "nothing was recorded: no video frame arrived".into(),
        ));
    };
    let (out, summary) = writer.finish(entry, width, height, muxer.audio())?;
    let file = out.into_inner().map_err(|e| AppError::Io(e.into_error()))?;
    file.sync_all()?;
    Ok(Saved {
        path: path.to_path_buf(),
        summary,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SPS: &[u8] = &[
        0x67, 0x42, 0xC0, 0x29, 0x8D, 0x68, 0x09, 0x00, 0xA1, 0xEF, 0x90, 0x80, 0x80, 0x80, 0x83,
        0xC2, 0x21, 0x1A, 0x80,
    ];
    const PPS: &[u8] = &[0x68, 0xCE, 0x01, 0xA8, 0x35, 0xC8];

    fn config() -> Vec<u8> {
        [&[0, 0, 0, 1][..], SPS, &[0, 0, 0, 1], PPS].concat()
    }

    fn frame(key: bool, pts: u64, body: &[u8]) -> Packet {
        Packet::Frame {
            key,
            pts,
            data: [&[0, 0, 0, 1][..], body].concat(),
        }
    }

    #[test]
    fn starts_on_a_key_frame_with_config() {
        let mut m = Muxer::new(VideoCodec::H264);
        assert!(m.push(frame(true, 10, &[0x65, 1])).unwrap().is_none());
        m.push(Packet::Session {
            width: 576,
            height: 1280,
        })
        .unwrap();
        m.push(Packet::Config(config())).unwrap();
        // Delta frames before the first key frame are dropped.
        assert!(m.push(frame(false, 20, &[0x41, 1])).unwrap().is_none());
        let s = m.push(frame(true, 1_000, &[0x65, 7])).unwrap().unwrap();
        assert_eq!((s.time_us, s.key), (0, true));
        assert_eq!(s.data, [0, 0, 0, 2, 0x65, 7]);
        let s = m.push(frame(false, 17_667, &[0x41, 8])).unwrap().unwrap();
        assert_eq!((s.time_us, s.key), (16_667, false));
        let (entry, w, h) = m.track().unwrap();
        assert_eq!((w, h), (576, 1280));
        let SampleEntry::Avc(avcc) = entry else {
            panic!("{entry:?}")
        };
        assert_eq!(&avcc[..4], [1, 0x42, 0xC0, 0x29]);
    }

    #[test]
    fn new_parameter_sets_go_in_band() {
        let mut m = Muxer::new(VideoCodec::H264);
        m.push(Packet::Session {
            width: 8,
            height: 16,
        })
        .unwrap();
        m.push(Packet::Config(config())).unwrap();
        m.push(frame(true, 0, &[0x65])).unwrap();
        // Same config again (encoder reset): nothing added.
        m.push(Packet::Config(config())).unwrap();
        let data = m.push(frame(true, 5, &[0x65, 2])).unwrap().unwrap().data;
        assert_eq!(data, [0, 0, 0, 2, 0x65, 2]);
        // Rotation: new SPS, prepended to the next key frame only.
        let mut rotated = config();
        rotated[8] ^= 1;
        m.push(Packet::Session {
            width: 16,
            height: 8,
        })
        .unwrap();
        m.push(Packet::Config(rotated.clone())).unwrap();
        let data = m.push(frame(false, 6, &[0x41])).unwrap().unwrap().data;
        assert_eq!(data, [0, 0, 0, 1, 0x41]);
        let data = m.push(frame(true, 7, &[0x65, 3])).unwrap().unwrap().data;
        let mut expected = codec::to_length_prefixed(&rotated);
        expected.extend_from_slice(&[0, 0, 0, 2, 0x65, 3]);
        assert_eq!(data, expected);
        // The sample description keeps the first size.
        assert_eq!(m.track().unwrap().1, 8);
    }

    const OPUS_HEAD: [u8; 19] = [
        b'O', b'p', b'u', b's', b'H', b'e', b'a', b'd', 1, 2, 0x38, 0x01, 0x80, 0xBB, 0, 0, 0, 0, 0,
    ];

    #[test]
    fn audio_joins_the_video_timeline() {
        let mut m = Muxer::new(VideoCodec::H264);
        m.push(Packet::AudioConfig(OPUS_HEAD.to_vec())).unwrap();
        m.push(Packet::Session {
            width: 8,
            height: 16,
        })
        .unwrap();
        m.push(Packet::Config(config())).unwrap();
        let audio = |pts| Packet::Audio {
            pts,
            data: vec![0xFC, 1],
        };
        // Before the first video frame: dropped.
        assert!(m.push(audio(900)).unwrap().is_none());
        m.push(frame(true, 1_000, &[0x65])).unwrap().unwrap();
        // Captured before the first frame but delivered later: dropped.
        assert!(m.push(audio(990)).unwrap().is_none());
        let s = m.push(audio(1_250)).unwrap().unwrap();
        assert_eq!(
            s,
            Sample {
                track: Track::Audio,
                time_us: 250,
                data: vec![0xFC, 1],
                key: true
            }
        );
        assert_eq!(m.audio().unwrap().channels, 2);
    }

    #[test]
    fn unreadable_opus_head_means_no_audio_track() {
        let mut m = Muxer::new(VideoCodec::H264);
        m.push(Packet::AudioConfig(b"AOPUSHDR".to_vec())).unwrap();
        m.push(Packet::Session {
            width: 8,
            height: 16,
        })
        .unwrap();
        m.push(Packet::Config(config())).unwrap();
        m.push(frame(true, 0, &[0x65])).unwrap().unwrap();
        let audio = Packet::Audio {
            pts: 10,
            data: vec![0xFC],
        };
        assert!(m.push(audio).unwrap().is_none());
        assert!(m.audio().is_none());
    }

    #[test]
    fn av1_needs_an_av1c_config() {
        assert!(sample_entry(VideoCodec::Av1, &[0x81, 0x08, 0x0C, 0x00]).is_ok());
        assert!(sample_entry(VideoCodec::Av1, &[0x0A, 0x0B]).is_err());
        assert!(sample_entry(VideoCodec::H264, &[0, 0, 1, 0x68]).is_err());
    }

    #[tokio::test]
    async fn records_a_file_and_stops() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rec.mp4");
        let recorder = Recorder::start(
            VideoCodec::H264,
            path.clone(),
            Box::new(|_| {}),
            Box::new(|_| panic!("stop() must report instead")),
        )
        .unwrap();
        let tap = Tap::default();
        // The stream was already running: the tap seeds the recorder.
        tap.observe(
            Header::Session {
                width: 576,
                height: 1280,
            },
            &[],
            b"session-record",
        );
        tap.observe(
            Header::Media {
                config: true,
                key_frame: false,
                pts: 0,
                size: 0,
            },
            &config(),
            b"config-record",
        );
        assert_eq!(tap.cached_records(), b"session-recordconfig-record");
        tap.attach(recorder).unwrap();
        assert!(tap.is_recording());
        for i in 0..30u64 {
            let body: &[u8] = if i % 10 == 0 {
                &[0x65, 1, 2]
            } else {
                &[0x41, 3]
            };
            tap.observe(
                Header::Media {
                    config: false,
                    key_frame: i % 10 == 0,
                    pts: 5_000_000 + i * 16_667,
                    size: 0,
                },
                &[&[0, 0, 0, 1][..], body].concat(),
                &[],
            );
        }
        let saved = tap.detach().unwrap().stop().await.unwrap();
        assert!(!tap.is_recording());
        assert_eq!(saved.summary.frames, 30);
        // 29 intervals of 1/60 s plus the last frame's 1/60 s.
        assert_eq!(saved.summary.duration_ms, 500);
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(bytes.len() as u64, saved.summary.bytes);
        assert_eq!(&bytes[4..8], b"ftyp");
    }

    #[tokio::test]
    async fn dropping_reports_through_the_end_sink() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("empty.mp4");
        let (tx, rx) = oneshot::channel();
        let recorder = Recorder::start(
            VideoCodec::H264,
            path.clone(),
            Box::new(|_| {}),
            Box::new(move |result| {
                let _ = tx.send(result);
            }),
        )
        .unwrap();
        drop(recorder);
        let result = rx.await.unwrap();
        assert!(result.is_err(), "no frames: {result:?}");
        assert!(!path.exists(), "an empty recording is removed");
    }
}
