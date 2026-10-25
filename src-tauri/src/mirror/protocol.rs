//! Wire format of scrcpy v5.0.1 (`doc/develop.md`, `Streamer.java`,
//! `DesktopConnection.java`, `DeviceMessageWriter.java`) and the binary
//! records we forward to the frontend.

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt};

use crate::error::{AppError, AppResult};

/// Size of the zero-padded UTF-8 device name sent on the first socket.
pub const DEVICE_NAME_LEN: usize = 64;
/// Session and media packet headers are both 12 bytes.
pub const HEADER_LEN: usize = 12;

const FLAG_SESSION: u64 = 1 << 63;
const FLAG_CONFIG: u64 = 1 << 62;
const FLAG_KEY_FRAME: u64 = 1 << 61;
const PTS_MASK: u64 = FLAG_KEY_FRAME - 1;

/// Upper bound for one media packet; a sane encoder stays far below.
pub const MAX_PACKET: usize = 32 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VideoCodec {
    H264,
    H265,
    Av1,
}

impl VideoCodec {
    /// Value of the `video_codec=` server option.
    pub fn option(self) -> &'static str {
        match self {
            Self::H264 => "h264",
            Self::H265 => "h265",
            Self::Av1 => "av1",
        }
    }

    /// The codec id the server writes first on the video socket.
    pub fn id(self) -> u32 {
        match self {
            Self::H264 => 0x6832_3634,
            Self::H265 => 0x6832_3635,
            Self::Av1 => 0x0061_7631,
        }
    }

    pub fn from_id(id: u32) -> Option<Self> {
        [Self::H264, Self::H265, Self::Av1]
            .into_iter()
            .find(|c| c.id() == id)
    }
}

/// `raw` audio: 16-bit little-endian interleaved stereo PCM at 48 kHz.
pub const AUDIO_CODEC_RAW: u32 = 0x0072_6177;

/// What the server writes instead of a codec id when a stream is unusable.
#[derive(Debug, PartialEq, Eq)]
pub enum StreamStart<C> {
    Codec(C),
    /// Code 0: stream explicitly disabled (e.g. no audio capture before
    /// Android 11); mirroring continues without it.
    Disabled,
    /// Code 1: configuration error, the server is stopping.
    Error,
    Unknown(u32),
}

pub fn parse_stream_start<C>(id: u32, codec: impl Fn(u32) -> Option<C>) -> StreamStart<C> {
    match id {
        0 => StreamStart::Disabled,
        1 => StreamStart::Error,
        id => codec(id).map_or(StreamStart::Unknown(id), StreamStart::Codec),
    }
}

/// Device name from the 64-byte metadata field.
pub fn parse_device_name(field: &[u8]) -> String {
    let end = field.iter().position(|&b| b == 0).unwrap_or(field.len());
    String::from_utf8_lossy(&field[..end]).into_owned()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Header {
    /// A new capture session (start, rotation, fold): frames that follow
    /// have this size, and touch events must use it as the screen size.
    Session { width: u32, height: u32 },
    Media {
        config: bool,
        key_frame: bool,
        pts: u64,
        size: u32,
    },
}

pub fn parse_header(raw: &[u8; HEADER_LEN]) -> Header {
    let head = u64::from_be_bytes([
        raw[0], raw[1], raw[2], raw[3], raw[4], raw[5], raw[6], raw[7],
    ]);
    let tail = u32::from_be_bytes([raw[8], raw[9], raw[10], raw[11]]);
    if head & FLAG_SESSION != 0 {
        Header::Session {
            width: (head & 0xFFFF_FFFF) as u32,
            height: tail,
        }
    } else {
        Header::Media {
            config: head & FLAG_CONFIG != 0,
            key_frame: head & FLAG_KEY_FRAME != 0,
            pts: head & PTS_MASK,
            size: tail,
        }
    }
}

/// Length of the first packet in `buf` if it is entirely buffered. Used to
/// batch packets that already arrived into one message to the frontend.
pub fn buffered_packet_len(buf: &[u8]) -> Option<usize> {
    let raw: &[u8; HEADER_LEN] = buf.get(..HEADER_LEN)?.try_into().ok()?;
    let len = match parse_header(raw) {
        Header::Session { .. } => HEADER_LEN,
        Header::Media { size, .. } => HEADER_LEN + size as usize,
    };
    (buf.len() >= len).then_some(len)
}

/// Messages the server sends on the control socket.
#[derive(Debug, PartialEq, Eq)]
pub enum DeviceMessage {
    Clipboard(String),
    AckClipboard(u64),
    UhidOutput,
}

const DEVICE_MSG_MAX: usize = 1 << 18;

pub async fn read_device_message<R: AsyncRead + Unpin>(r: &mut R) -> AppResult<DeviceMessage> {
    match r.read_u8().await? {
        0 => {
            let len = r.read_u32().await? as usize;
            if len > DEVICE_MSG_MAX {
                return Err(AppError::Protocol(format!("clipboard too long: {len}")));
            }
            let mut text = vec![0u8; len];
            r.read_exact(&mut text).await?;
            Ok(DeviceMessage::Clipboard(
                String::from_utf8_lossy(&text).into_owned(),
            ))
        }
        1 => Ok(DeviceMessage::AckClipboard(r.read_u64().await?)),
        2 => {
            let _id = r.read_u16().await?;
            let len = r.read_u16().await? as usize;
            let mut data = vec![0u8; len];
            r.read_exact(&mut data).await?;
            Ok(DeviceMessage::UhidOutput)
        }
        other => Err(AppError::Protocol(format!(
            "unknown device message {other}"
        ))),
    }
}

/// Kinds of the records in the binary stream to the frontend.
///
/// Each record: `kind u8 · flags u8 · reserved u16 · length u32 · pts u64`
/// (big-endian, 16 bytes) followed by `length` payload bytes. One channel
/// message carries one or more records back to back.
pub mod record {
    pub const HEADER_LEN: usize = 16;
    /// Payload: width u32, height u32.
    pub const SESSION: u8 = 1;
    /// Payload: codec string length u8, codec string, decoder description
    /// (avcC for H.264, av1C for AV1, empty for Annex-B H.265).
    pub const VIDEO_CONFIG: u8 = 2;
    /// Payload: one encoded frame in the format announced by the config.
    pub const VIDEO_FRAME: u8 = 3;
    /// Payload: raw PCM s16le stereo 48 kHz.
    pub const AUDIO: u8 = 4;

    pub const FLAG_KEY: u8 = 1;
}

pub fn write_record(out: &mut Vec<u8>, kind: u8, flags: u8, pts: u64, payload: &[u8]) {
    out.reserve(record::HEADER_LEN + payload.len());
    out.push(kind);
    out.push(flags);
    out.extend_from_slice(&[0, 0]);
    out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    out.extend_from_slice(&pts.to_be_bytes());
    out.extend_from_slice(payload);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_header() {
        // Flags 0x80000000 then width 1280, height 2856.
        let raw = [0x80, 0, 0, 0, 0, 0, 0x05, 0x00, 0, 0, 0x0B, 0x28];
        assert_eq!(
            parse_header(&raw),
            Header::Session {
                width: 1280,
                height: 2856
            }
        );
        // Client-resized flag is ignored.
        let raw = [0x80, 0, 0, 1, 0, 0, 0x05, 0x00, 0, 0, 0x0B, 0x28];
        assert!(matches!(
            parse_header(&raw),
            Header::Session { width: 1280, .. }
        ));
    }

    #[test]
    fn config_header() {
        let raw = [0x40, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x1C];
        assert_eq!(
            parse_header(&raw),
            Header::Media {
                config: true,
                key_frame: false,
                pts: 0,
                size: 28
            }
        );
    }

    #[test]
    fn key_frame_header() {
        let mut raw = [0u8; 12];
        raw[..8].copy_from_slice(&((1u64 << 61) | 123_456_789).to_be_bytes());
        raw[8..].copy_from_slice(&70_000u32.to_be_bytes());
        assert_eq!(
            parse_header(&raw),
            Header::Media {
                config: false,
                key_frame: true,
                pts: 123_456_789,
                size: 70_000
            }
        );
    }

    #[test]
    fn buffered_len_needs_whole_packet() {
        let mut buf = vec![0u8; 12];
        buf[11] = 4;
        assert_eq!(buffered_packet_len(&buf), None);
        buf.extend_from_slice(&[1, 2, 3]);
        assert_eq!(buffered_packet_len(&buf), None);
        buf.extend_from_slice(&[4, 9]);
        assert_eq!(buffered_packet_len(&buf), Some(16));
        assert_eq!(buffered_packet_len(&[0x80; 11]), None);
        assert_eq!(buffered_packet_len(&[0x80; 12]), Some(12));
    }

    #[test]
    fn codec_ids() {
        assert_eq!(&VideoCodec::H264.id().to_be_bytes(), b"h264");
        assert_eq!(&VideoCodec::H265.id().to_be_bytes(), b"h265");
        assert_eq!(&VideoCodec::Av1.id().to_be_bytes(), b"\0av1");
        assert_eq!(&AUDIO_CODEC_RAW.to_be_bytes(), b"\0raw");
        assert_eq!(
            parse_stream_start(0x6832_3634, VideoCodec::from_id),
            StreamStart::Codec(VideoCodec::H264)
        );
        assert_eq!(
            parse_stream_start(0, VideoCodec::from_id),
            StreamStart::Disabled
        );
        assert_eq!(
            parse_stream_start(1, VideoCodec::from_id),
            StreamStart::Error
        );
        assert_eq!(
            parse_stream_start(0x0076_7038, VideoCodec::from_id),
            StreamStart::Unknown(0x0076_7038)
        );
    }

    #[test]
    fn device_name_is_nul_terminated() {
        let mut field = [0u8; DEVICE_NAME_LEN];
        field[..13].copy_from_slice(b"sdk_gphone64_");
        assert_eq!(parse_device_name(&field), "sdk_gphone64_");
        assert_eq!(parse_device_name(&[b'a'; 64]).len(), 64);
    }

    #[tokio::test]
    async fn device_messages() {
        let mut data: &[u8] = &[0, 0, 0, 0, 5, b'h', b'e', b'l', b'l', b'o'];
        assert_eq!(
            read_device_message(&mut data).await.unwrap(),
            DeviceMessage::Clipboard("hello".into())
        );
        let mut data: &[u8] = &[1, 0, 0, 0, 0, 0, 0, 0, 42];
        assert_eq!(
            read_device_message(&mut data).await.unwrap(),
            DeviceMessage::AckClipboard(42)
        );
        let mut data: &[u8] = &[2, 0, 1, 0, 2, 9, 9];
        assert_eq!(
            read_device_message(&mut data).await.unwrap(),
            DeviceMessage::UhidOutput
        );
        let mut data: &[u8] = &[7];
        assert!(read_device_message(&mut data).await.is_err());
    }

    #[test]
    fn record_layout() {
        let mut out = Vec::new();
        write_record(
            &mut out,
            record::VIDEO_FRAME,
            record::FLAG_KEY,
            0x0102,
            b"abc",
        );
        assert_eq!(
            out,
            [
                3, 1, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 1, 2, b'a', b'b', b'c'
            ]
        );
    }
}
