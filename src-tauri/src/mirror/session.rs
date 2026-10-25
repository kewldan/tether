//! One mirroring session: push the server, start it, connect the sockets
//! and pump video/audio packets and control messages until something ends.

use std::future::Future;
use std::hash::{BuildHasher, RandomState};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};
use tokio::sync::mpsc::{self, UnboundedReceiver, UnboundedSender};
use tokio::task::JoinHandle;

use super::codec::{self, DecoderConfig};
use super::protocol::{
    self, DeviceMessage, HEADER_LEN, Header, StreamStart, VideoCodec, record, write_record,
};
use super::{SCRCPY_VERSION, SERVER_DEVICE_PATH, push};
use crate::adb::server::AdbServer;
use crate::error::{AppError, AppResult};
use crate::state::lock;

/// How long the server gets to start listening after `app_process`.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const CONNECT_RETRY: Duration = Duration::from_millis(100);
/// Flush a batch to the frontend at least at this size.
const MAX_BATCH: usize = 4 * 1024 * 1024;
/// Server output kept for error messages.
const LOG_LIMIT: usize = 16 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorOptions {
    pub video_codec: VideoCodec,
    /// Limit of the long side in pixels; 0 keeps the native resolution.
    pub max_size: u32,
    /// Bits per second.
    pub video_bit_rate: u32,
    /// 0 means no limit.
    pub max_fps: u32,
    /// Forward device audio (Android 11+) as raw PCM.
    pub audio: bool,
    pub show_touches: bool,
    pub stay_awake: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorInfo {
    pub session_id: u64,
    pub device_name: String,
    pub video_codec: VideoCodec,
    /// Audio was requested; the stream may still turn out to be disabled.
    pub audio: bool,
    pub scrcpy_version: &'static str,
}

/// Events besides the binary stream.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum MirrorEvent {
    /// The device clipboard changed (`clipboard_autosync`) or was requested.
    Clipboard { text: String },
    /// Audio could not be captured; video keeps going.
    AudioDisabled,
    /// The session ended on its own (device gone, server exited, error).
    Stopped { error: Option<AppError> },
}

pub type DataSink = Arc<dyn Fn(Vec<u8>) + Send + Sync>;
pub type EventSink = Arc<dyn Fn(MirrorEvent) + Send + Sync>;

/// A connected session. `run` drives it; dropping `run` ends it.
pub struct Running {
    pub info: MirrorInfo,
    pub control: UnboundedSender<Vec<u8>>,
    pub run: Pin<Box<dyn Future<Output = AppResult<()>> + Send>>,
}

/// The `app_process` command line for the pinned server version.
pub fn server_command(scid: u32, o: &MirrorOptions) -> String {
    let mut args = vec![
        format!("CLASSPATH={SERVER_DEVICE_PATH}"),
        "app_process".into(),
        "/".into(),
        "com.genymobile.scrcpy.Server".into(),
        SCRCPY_VERSION.into(),
        format!("scid={scid:08x}"),
        "log_level=info".into(),
        "tunnel_forward=true".into(),
        "video=true".into(),
        format!("video_codec={}", o.video_codec.option()),
        format!("audio={}", o.audio),
        "control=true".into(),
        format!("video_bit_rate={}", o.video_bit_rate.max(100_000)),
        format!("show_touches={}", o.show_touches),
        format!("stay_awake={}", o.stay_awake),
        "clipboard_autosync=true".into(),
        "send_frame_meta=true".into(),
    ];
    if o.max_size > 0 {
        args.push(format!("max_size={}", o.max_size));
    }
    if o.max_fps > 0 {
        args.push(format!("max_fps={}", o.max_fps));
    }
    if o.audio {
        args.push("audio_codec=raw".into());
    }
    args.join(" ")
}

/// A random 31-bit session id, so two clients never share a socket name.
pub fn new_scid() -> u32 {
    let seed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    (RandomState::new().hash_one(seed) as u32) & 0x7FFF_FFFF
}

/// Aborts the wrapped task when dropped.
struct AbortOnDrop<T>(JoinHandle<T>);

impl<T> Drop for AbortOnDrop<T> {
    fn drop(&mut self) {
        self.0.abort();
    }
}

type Log = Arc<Mutex<String>>;

/// Pushes and starts the server, connects all sockets and returns once the
/// video stream is announced. Errors carry the server's own message.
pub async fn start(
    server: AdbServer,
    serial: &str,
    session_id: u64,
    jar: &[u8],
    options: &MirrorOptions,
    on_data: DataSink,
    on_event: EventSink,
) -> AppResult<Running> {
    push::push(&server, serial, jar, SERVER_DEVICE_PATH, 0o644).await?;

    let scid = new_scid();
    let shell = server
        .open_device(serial, &format!("shell:{}", server_command(scid, options)))
        .await?;
    let log: Log = Arc::default();
    let mut shell_task = AbortOnDrop(tokio::spawn(collect_output(shell, log.clone())));

    let socket = format!("localabstract:scrcpy_{scid:08x}");
    let mut video = connect_first(&server, serial, &socket, &shell_task, &log).await?;

    // The server accepts every socket before it writes anything else.
    let audio = if options.audio {
        Some(server.open_device(serial, &socket).await?)
    } else {
        None
    };
    let control = server.open_device(serial, &socket).await?;

    let mut name = [0u8; protocol::DEVICE_NAME_LEN];
    video
        .read_exact(&mut name)
        .await
        .map_err(|_| server_error(&log, "the server closed the connection"))?;
    let device_name = protocol::parse_device_name(&name);

    let codec_id = video
        .read_u32()
        .await
        .map_err(|_| server_error(&log, "the server closed the video stream"))?;
    let codec = match protocol::parse_stream_start(codec_id, VideoCodec::from_id) {
        StreamStart::Codec(codec) => codec,
        StreamStart::Disabled | StreamStart::Error => {
            return Err(server_error(
                &log,
                "the device could not start the video encoder",
            ));
        }
        StreamStart::Unknown(id) => {
            return Err(AppError::Protocol(format!(
                "unknown video codec {id:#010x}"
            )));
        }
    };

    let (control_tx, control_rx) = mpsc::unbounded_channel();
    let (control_read, control_write) = control.into_split();

    let info = MirrorInfo {
        session_id,
        device_name,
        video_codec: codec,
        audio: options.audio,
        scrcpy_version: SCRCPY_VERSION,
    };

    let run = async move {
        let audio_loop = async {
            match audio {
                Some(stream) => audio_loop(stream, &on_data, &on_event).await,
                None => std::future::pending().await,
            }
        };
        let result = tokio::select! {
            r = video_loop(video, codec, &on_data) => r,
            r = audio_loop => r,
            r = control_writer(control_write, control_rx) => r,
            r = control_reader(control_read, &on_event) => r,
            _ = &mut shell_task.0 => Err(server_error(&log, "the server exited")),
        };
        // Stream ends usually mean the server or device went away; prefer
        // the server's own explanation when it printed one.
        result.map_err(|e| match e {
            AppError::Io(_) => server_error(&log, "the device closed the stream"),
            e => e,
        })
    };

    Ok(Running {
        info,
        control: control_tx,
        run: Box::pin(run),
    })
}

/// Opens the first socket, retrying until the server listens. With a
/// forward tunnel the open succeeds or fails at the device; only the dummy
/// byte proves the server accepted us.
async fn connect_first(
    server: &AdbServer,
    serial: &str,
    socket: &str,
    shell: &AbortOnDrop<()>,
    log: &Log,
) -> AppResult<TcpStream> {
    let deadline = Instant::now() + CONNECT_TIMEOUT;
    loop {
        if shell.0.is_finished() {
            return Err(server_error(log, "the server exited during startup"));
        }
        match server.open_device(serial, socket).await {
            Ok(mut stream) => {
                let byte = tokio::time::timeout_at(deadline.into(), stream.read_u8()).await;
                if let Ok(Ok(_)) = byte {
                    return Ok(stream);
                }
            }
            Err(AppError::AdbFailure(m)) if m.contains("not found") || m.contains("offline") => {
                return Err(AppError::AdbFailure(m));
            }
            Err(e @ AppError::ServerUnreachable(_)) => return Err(e),
            Err(_) => {}
        }
        if Instant::now() >= deadline {
            return Err(server_error(log, "the server did not start in time"));
        }
        tokio::time::sleep(CONNECT_RETRY).await;
    }
}

/// Reads the server's stdout/stderr until it exits.
async fn collect_output(shell: TcpStream, log: Log) {
    let mut lines = BufReader::new(shell).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let mut log = lock(&log);
        log.push_str(&line);
        log.push('\n');
        if log.len() > LOG_LIMIT {
            let cut = log.len() - LOG_LIMIT / 2;
            let cut = (cut..log.len())
                .find(|&i| log.is_char_boundary(i))
                .unwrap_or(log.len());
            log.drain(..cut);
        }
    }
}

/// Explains a failure with the server's ERROR lines, if any.
fn server_error(log: &Log, fallback: &str) -> AppError {
    let log = lock(log);
    AppError::Device(describe_failure(&log, fallback))
}

pub fn describe_failure(log: &str, fallback: &str) -> String {
    let errors: Vec<&str> = log
        .lines()
        .filter_map(|l| l.strip_prefix("[server] ERROR: "))
        .collect();
    if errors.is_empty() {
        let tail: Vec<&str> = log.lines().rev().take(3).collect();
        if tail.is_empty() {
            format!("Mirroring failed: {fallback}.")
        } else {
            let tail: Vec<&str> = tail.into_iter().rev().collect();
            format!("Mirroring failed: {fallback}. {}", tail.join(" "))
        }
    } else {
        format!("Mirroring failed: {}", errors.join(" "))
    }
}

/// Reads one packet header and payload, or `None` on a clean end.
async fn read_packet<R: AsyncRead + Unpin>(
    r: &mut R,
    payload: &mut Vec<u8>,
) -> AppResult<Option<Header>> {
    let mut head = [0u8; HEADER_LEN];
    match r.read_exact(&mut head).await {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e.into()),
    }
    let header = protocol::parse_header(&head);
    payload.clear();
    if let Header::Media { size, .. } = header {
        let size = size as usize;
        if size > protocol::MAX_PACKET {
            return Err(AppError::Protocol(format!("packet too large: {size}")));
        }
        payload.resize(size, 0);
        r.read_exact(payload).await?;
    }
    Ok(Some(header))
}

/// Converts the video stream into frontend records, batching every packet
/// that is already buffered into one channel message.
pub async fn video_loop<R: AsyncRead + Unpin>(
    stream: R,
    codec: VideoCodec,
    on_data: &DataSink,
) -> AppResult<()> {
    let mut reader = BufReader::with_capacity(1 << 20, stream);
    let mut converter = VideoConverter::new(codec);
    let mut payload = Vec::new();
    let mut batch = Vec::new();
    loop {
        let Some(header) = read_packet(&mut reader, &mut payload).await? else {
            // Mapped to the server's explanation by `start`.
            return Err(std::io::Error::from(std::io::ErrorKind::UnexpectedEof).into());
        };
        converter.convert(header, &payload, &mut batch)?;
        let flush =
            batch.len() >= MAX_BATCH || protocol::buffered_packet_len(reader.buffer()).is_none();
        if flush && !batch.is_empty() {
            on_data(std::mem::take(&mut batch));
        }
    }
}

/// Stateful packet → record conversion (keeps the config for in-band use).
pub struct VideoConverter {
    codec: VideoCodec,
    config: Option<DecoderConfig>,
    config_packet: Vec<u8>,
}

impl VideoConverter {
    pub fn new(codec: VideoCodec) -> Self {
        Self {
            codec,
            config: None,
            config_packet: Vec::new(),
        }
    }

    pub fn convert(&mut self, header: Header, payload: &[u8], out: &mut Vec<u8>) -> AppResult<()> {
        match header {
            Header::Session { width, height } => {
                let mut size = [0u8; 8];
                size[..4].copy_from_slice(&width.to_be_bytes());
                size[4..].copy_from_slice(&height.to_be_bytes());
                write_record(out, record::SESSION, 0, 0, &size);
            }
            Header::Media { config: true, .. } => {
                let config = match self.codec {
                    VideoCodec::H264 => codec::h264_config(payload),
                    VideoCodec::H265 => codec::h265_config(payload),
                    VideoCodec::Av1 => Some(codec::av1_config(payload)),
                }
                .ok_or_else(|| AppError::Protocol("unreadable codec config packet".into()))?;
                let mut body =
                    Vec::with_capacity(1 + config.codec.len() + config.description.len());
                body.push(config.codec.len() as u8);
                body.extend_from_slice(config.codec.as_bytes());
                body.extend_from_slice(&config.description);
                write_record(out, record::VIDEO_CONFIG, 0, 0, &body);
                self.config_packet = payload.to_vec();
                self.config = Some(config);
            }
            Header::Media { key_frame, pts, .. } => {
                // Frames before the first config cannot be decoded.
                let Some(config) = &self.config else {
                    return Ok(());
                };
                let flags = if key_frame { record::FLAG_KEY } else { 0 };
                if config.length_prefixed {
                    let frame = codec::to_length_prefixed(payload);
                    write_record(out, record::VIDEO_FRAME, flags, pts, &frame);
                } else if config.inband_config && key_frame {
                    let mut frame = self.config_packet.clone();
                    frame.extend_from_slice(payload);
                    write_record(out, record::VIDEO_FRAME, flags, pts, &frame);
                } else {
                    write_record(out, record::VIDEO_FRAME, flags, pts, payload);
                }
            }
        }
        Ok(())
    }
}

/// Raw PCM audio; the codec id comes first, like on the video socket.
async fn audio_loop(stream: TcpStream, on_data: &DataSink, on_event: &EventSink) -> AppResult<()> {
    let mut reader = BufReader::with_capacity(256 * 1024, stream);
    let id = reader.read_u32().await?;
    match protocol::parse_stream_start(id, |id| (id == protocol::AUDIO_CODEC_RAW).then_some(())) {
        StreamStart::Codec(()) => {}
        StreamStart::Disabled | StreamStart::Error | StreamStart::Unknown(_) => {
            on_event(MirrorEvent::AudioDisabled);
            return std::future::pending().await;
        }
    }
    let mut payload = Vec::new();
    let mut batch = Vec::new();
    loop {
        let Some(header) = read_packet(&mut reader, &mut payload).await? else {
            on_event(MirrorEvent::AudioDisabled);
            return std::future::pending().await;
        };
        if let Header::Media {
            config: false, pts, ..
        } = header
        {
            write_record(&mut batch, record::AUDIO, 0, pts, &payload);
        }
        if protocol::buffered_packet_len(reader.buffer()).is_none() && !batch.is_empty() {
            on_data(std::mem::take(&mut batch));
        }
    }
}

async fn control_writer(
    mut stream: OwnedWriteHalf,
    mut rx: UnboundedReceiver<Vec<u8>>,
) -> AppResult<()> {
    while let Some(message) = rx.recv().await {
        stream.write_all(&message).await?;
    }
    std::future::pending().await
}

async fn control_reader(stream: OwnedReadHalf, on_event: &EventSink) -> AppResult<()> {
    let mut reader = BufReader::new(stream);
    loop {
        if let DeviceMessage::Clipboard(text) = protocol::read_device_message(&mut reader).await? {
            on_event(MirrorEvent::Clipboard { text });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options() -> MirrorOptions {
        MirrorOptions {
            video_codec: VideoCodec::H264,
            max_size: 1920,
            video_bit_rate: 8_000_000,
            max_fps: 60,
            audio: false,
            show_touches: true,
            stay_awake: false,
        }
    }

    #[test]
    fn command_line() {
        let cmd = server_command(0x1234_abcd, &options());
        assert_eq!(
            cmd,
            "CLASSPATH=/data/local/tmp/scrcpy-server.jar app_process / \
             com.genymobile.scrcpy.Server 5.0.1 scid=1234abcd log_level=info \
             tunnel_forward=true video=true video_codec=h264 audio=false \
             control=true video_bit_rate=8000000 show_touches=true \
             stay_awake=false clipboard_autosync=true send_frame_meta=true \
             max_size=1920 max_fps=60"
        );
        let mut o = options();
        o.max_size = 0;
        o.max_fps = 0;
        o.audio = true;
        o.video_codec = VideoCodec::H265;
        let cmd = server_command(1, &o);
        assert!(cmd.contains("scid=00000001"));
        assert!(cmd.contains("video_codec=h265"));
        assert!(cmd.ends_with("audio_codec=raw"));
        assert!(!cmd.contains("max_size") && !cmd.contains("max_fps"));
    }

    #[test]
    fn scid_is_31_bit() {
        for _ in 0..100 {
            assert!(new_scid() <= 0x7FFF_FFFF);
        }
    }

    #[test]
    fn failure_uses_server_errors() {
        let log = "[server] INFO: Device: [Google] sdk (Android 16)\n\
                   [server] ERROR: Could not find encoder for av1\n\
                   [server] ERROR: Video encoding failed\n";
        assert_eq!(
            describe_failure(log, "x"),
            "Mirroring failed: Could not find encoder for av1 Video encoding failed"
        );
        assert_eq!(
            describe_failure("", "the server exited"),
            "Mirroring failed: the server exited."
        );
        assert_eq!(
            describe_failure("Aborted\n", "the server exited"),
            "Mirroring failed: the server exited. Aborted"
        );
    }

    fn packet(head: u64, payload: &[u8]) -> Vec<u8> {
        let mut out = head.to_be_bytes().to_vec();
        out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        out.extend_from_slice(payload);
        out
    }

    #[tokio::test]
    async fn video_stream_is_converted_and_batched() {
        let mut stream = Vec::new();
        // Session 720x1280.
        stream.extend_from_slice(&[0x80, 0, 0, 0, 0, 0, 0x02, 0xD0, 0, 0, 0x05, 0x00]);
        // Config: SPS + PPS.
        let config = [
            0, 0, 0, 1, 0x67, 0x42, 0xC0, 0x1F, 0xAA, 0, 0, 0, 1, 0x68, 0xCE,
        ];
        stream.extend(packet(1 << 62, &config));
        // Key frame (IDR) and a P frame.
        stream.extend(packet((1 << 61) | 1000, &[0, 0, 0, 1, 0x65, 1, 2, 3]));
        stream.extend(packet(2000, &[0, 0, 0, 1, 0x41, 9]));

        let batches = Arc::new(Mutex::new(Vec::<Vec<u8>>::new()));
        let sink_batches = batches.clone();
        let sink: DataSink = Arc::new(move |b| lock(&sink_batches).push(b));
        let err = video_loop(&stream[..], VideoCodec::H264, &sink)
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Io(_)));

        let batches = lock(&batches);
        assert_eq!(batches.len(), 1, "everything was buffered: one message");
        let data = &batches[0];

        // Walk the records.
        let mut kinds = Vec::new();
        let mut at = 0;
        while at < data.len() {
            let len = u32::from_be_bytes(data[at + 4..at + 8].try_into().unwrap()) as usize;
            let pts = u64::from_be_bytes(data[at + 8..at + 16].try_into().unwrap());
            kinds.push((
                data[at],
                data[at + 1],
                pts,
                data[at + 16..at + 16 + len].to_vec(),
            ));
            at += 16 + len;
        }
        assert_eq!(kinds.len(), 4);
        assert_eq!(kinds[0].0, record::SESSION);
        assert_eq!(kinds[0].3, [0, 0, 2, 0xD0, 0, 0, 5, 0]);
        assert_eq!(kinds[1].0, record::VIDEO_CONFIG);
        let codec_len = kinds[1].3[0] as usize;
        assert_eq!(&kinds[1].3[1..1 + codec_len], b"avc1.42C01F");
        assert_eq!(kinds[1].3[1 + codec_len], 1); // avcC version
        assert_eq!(
            kinds[2],
            (
                record::VIDEO_FRAME,
                record::FLAG_KEY,
                1000,
                vec![0, 0, 0, 4, 0x65, 1, 2, 3]
            )
        );
        assert_eq!(
            kinds[3],
            (record::VIDEO_FRAME, 0, 2000, vec![0, 0, 0, 2, 0x41, 9])
        );
    }

    #[test]
    fn hevc_key_frames_carry_config() {
        let mut conv = VideoConverter::new(VideoCodec::H265);
        let config = [
            0, 0, 0, 1, 0x42, 0x01, 0x01, 0x01, 0x60, 0, 0, 0, 0x90, 0, 0, 0, 0, 0, 0x5D, 0xA0,
        ];
        let mut out = Vec::new();
        conv.convert(
            Header::Media {
                config: true,
                key_frame: false,
                pts: 0,
                size: config.len() as u32,
            },
            &config,
            &mut out,
        )
        .unwrap();
        out.clear();
        let frame = [0, 0, 0, 1, 0x26, 0x01, 0xAF];
        conv.convert(
            Header::Media {
                config: false,
                key_frame: true,
                pts: 5,
                size: frame.len() as u32,
            },
            &frame,
            &mut out,
        )
        .unwrap();
        assert_eq!(&out[16..16 + config.len()], &config);
        assert_eq!(&out[16 + config.len()..], &frame);
    }

    #[test]
    fn frames_before_config_are_dropped() {
        let mut conv = VideoConverter::new(VideoCodec::H264);
        let mut out = Vec::new();
        conv.convert(
            Header::Media {
                config: false,
                key_frame: true,
                pts: 1,
                size: 2,
            },
            &[0x65, 0],
            &mut out,
        )
        .unwrap();
        assert!(out.is_empty());
    }
}
