//! Screen mirroring through the official scrcpy-server (Apache 2.0, pinned
//! in `resources/scrcpy-server`, see `resources/SCRCPY-NOTICE`).
//!
//! The server jar is pushed with a minimal `sync:` SEND ([`push`]), started
//! with `app_process` over a long-lived `shell:` stream and reached through
//! `localabstract:scrcpy_<scid>` device sockets (`tunnel_forward=true`, so no
//! `adb forward`/`reverse` rules are created). The wire protocol of the
//! pinned version (`doc/develop.md` of scrcpy v5.0.1) lives in [`protocol`]
//! and [`control`]; [`codec`] turns the H.264/H.265/AV1 config packets into
//! what WebCodecs wants; [`session`] wires it all together; [`record`] and
//! [`mp4`] save the stream (video plus Opus audio, see [`opus`]) to a file
//! without re-encoding.

pub mod codec;
pub mod control;
pub mod mp4;
pub mod opus;
pub mod protocol;
pub mod push;
pub mod record;
pub mod session;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tauri::async_runtime::JoinHandle;
use tauri::ipc::{Channel, InvokeResponseBody};
use tokio::sync::mpsc::UnboundedSender;

use record::Tap;
use session::{MirrorEvent, MirrorInfo, MirrorOptions};

/// Version of the bundled server; the server refuses any other client
/// version, so it is passed as the first argument.
pub const SCRCPY_VERSION: &str = "5.0.1";

/// SHA-256 of `resources/scrcpy-server` (from the release's SHA256SUMS.txt).
pub const SERVER_SHA256: &str = "764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536";

/// Where the jar goes on the device. `/data/local/tmp` is writable by
/// `shell` but not world-writable. The server unlinks it once loaded.
pub const SERVER_DEVICE_PATH: &str = "/data/local/tmp/scrcpy-server.jar";

/// Path of the jar inside the app resources (`tauri.conf.json` bundle).
pub const SERVER_RESOURCE: &str = "resources/scrcpy-server";

/// Running mirroring sessions, one per device serial.
#[derive(Default)]
pub struct MirrorState {
    pub sessions: Arc<Mutex<HashMap<String, SessionHandle>>>,
    /// Serializes session starts (push + launch) across devices.
    pub starting: tokio::sync::Mutex<()>,
}

/// The window currently showing a session and its channels.
pub struct Viewer {
    pub window: String,
    pub video: Channel<InvokeResponseBody>,
    pub events: Channel<MirrorEvent>,
}

/// Swapped when the session moves between windows (pop-out and back);
/// `None` while nobody watches (recording in the background, or the
/// short grace period after a view goes away).
pub type ViewerSlot = Arc<Mutex<Option<Viewer>>>;

pub struct SessionHandle {
    /// Distinguishes a session from its replacement for the same serial.
    pub id: u64,
    pub info: MirrorInfo,
    pub options: MirrorOptions,
    /// Encoded control messages for the control socket.
    pub control: UnboundedSender<Vec<u8>>,
    pub viewer: ViewerSlot,
    /// Stream cache and recorder.
    pub tap: Arc<Tap>,
    /// Label of the pop-out window holding this session, if any.
    pub popout: Option<String>,
    /// The supervisor task; aborting it closes every socket, which makes
    /// the server exit on the device.
    pub task: JoinHandle<()>,
}
