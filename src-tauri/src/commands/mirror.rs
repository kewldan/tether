//! Screen mirroring: sessions, moving them between windows (pop-out) and
//! recording them to the captures folder.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::path::BaseDirectory;
use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, State, WebviewUrl, WebviewWindowBuilder,
    Window, WindowEvent,
};

use crate::commands::overview::captures_root;
use crate::device::captures::{self, Capture};
use crate::error::{AppError, AppResult};
use crate::mirror::control::ControlMessage;
use crate::mirror::record::{Progress, Recorder, Tap};
use crate::mirror::session::{self, MirrorEvent, MirrorInfo, MirrorOptions};
use crate::mirror::{MirrorState, SERVER_RESOURCE, SessionHandle, Viewer, ViewerSlot};
use crate::state::{AppState, lock};

static NEXT_SESSION: AtomicU64 = AtomicU64::new(1);

/// A session nobody watches (and nobody records) is stopped after this,
/// so a remount, a retry or a pop-out returning can take it over first.
const GRACE: Duration = Duration::from_secs(3);

/// Labels of pop-out windows; `capabilities/mirror-popout.json` matches
/// `mirror-popout-*`.
const POPOUT_PREFIX: &str = "mirror-popout-";

type Sessions = Arc<Mutex<HashMap<String, SessionHandle>>>;

fn not_mirrored() -> AppError {
    AppError::Device("the device is not being mirrored".into())
}

/// Starts mirroring `serial` for the calling window. If the same stream
/// is already running (the page remounted, a retry, the pop-out came
/// back), the window takes it over instead of starting a second server;
/// different options replace it. Binary records (see
/// `mirror::protocol::record`) go to `on_video`, everything else to
/// `on_event`. Resolves once the video stream is announced.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn mirror_start(
    app: AppHandle,
    window: Window,
    state: State<'_, AppState>,
    mirror: State<'_, MirrorState>,
    serial: String,
    options: MirrorOptions,
    on_video: Channel<InvokeResponseBody>,
    on_event: Channel<MirrorEvent>,
) -> AppResult<MirrorInfo> {
    // One start at a time: two servers racing for the same jar path would
    // break each other.
    let _starting = mirror.starting.lock().await;
    let viewer = Viewer {
        window: window.label().to_owned(),
        video: on_video,
        events: on_event,
    };
    let viewer = match attach(&mirror.sessions, &serial, Some(&options), viewer) {
        Ok(info) => return Ok(info),
        Err(viewer) => viewer,
    };
    stop_session(&mirror, &serial, None);

    let jar_path = app
        .path()
        .resolve(SERVER_RESOURCE, BaseDirectory::Resource)
        .map_err(|e| AppError::Device(format!("scrcpy-server resource not found: {e}")))?;
    let jar = tokio::fs::read(&jar_path).await.map_err(|e| {
        AppError::Device(format!(
            "scrcpy-server resource is missing ({}): {e}",
            jar_path.display()
        ))
    })?;

    let id = NEXT_SESSION.fetch_add(1, Ordering::Relaxed);
    let slot: ViewerSlot = Arc::new(Mutex::new(Some(viewer)));
    let tap = Arc::new(Tap::default());
    let video = slot.clone();
    let events = slot.clone();
    let running = session::start(
        state.server,
        &serial,
        id,
        &jar,
        &options,
        Arc::new(move |batch| {
            if let Some(v) = lock(&video).as_ref() {
                let _ = v.video.send(InvokeResponseBody::Raw(batch));
            }
        }),
        Arc::new(move |event| {
            if let Some(v) = lock(&events).as_ref() {
                let _ = v.events.send(event);
            }
        }),
        tap.clone(),
    )
    .await?;

    let info = running.info.clone();
    let sessions = mirror.sessions.clone();
    // Spawn while holding the map lock so the task cannot try to remove
    // its entry before it is inserted.
    let mut map = lock(&mirror.sessions);
    let task_serial = serial.clone();
    let task_slot = slot.clone();
    let task = tauri::async_runtime::spawn(async move {
        let result = running.run.await;
        {
            let mut map = lock(&sessions);
            if map.get(&task_serial).is_some_and(|h| h.id == id) {
                map.remove(&task_serial);
            }
        }
        if let Some(v) = lock(&task_slot).as_ref() {
            let _ = v.events.send(MirrorEvent::Stopped {
                error: result.err(),
            });
        }
    });
    if let Some(previous) = map.insert(
        serial,
        SessionHandle {
            id,
            info: info.clone(),
            options,
            control: running.control,
            viewer: slot,
            tap,
            popout: None,
            task,
        },
    ) {
        previous.task.abort();
    }
    Ok(info)
}

/// Shows the running session of `serial` in the calling window (the
/// pop-out) without restarting it.
#[tauri::command]
pub fn mirror_attach(
    window: Window,
    mirror: State<'_, MirrorState>,
    serial: String,
    on_video: Channel<InvokeResponseBody>,
    on_event: Channel<MirrorEvent>,
) -> AppResult<MirrorInfo> {
    let viewer = Viewer {
        window: window.label().to_owned(),
        video: on_video,
        events: on_event,
    };
    attach(&mirror.sessions, &serial, None, viewer).map_err(|_| not_mirrored())
}

/// Moves a running session to `viewer`: the cached session size and codec
/// config go out first and the encoder is asked for a key frame, so the
/// new decoder starts at once. Gives the viewer back when there is no
/// matching session.
fn attach(
    sessions: &Sessions,
    serial: &str,
    options: Option<&MirrorOptions>,
    viewer: Viewer,
) -> Result<MirrorInfo, Viewer> {
    let map = lock(sessions);
    let Some(handle) = map.get(serial) else {
        return Err(viewer);
    };
    if options.is_some_and(|o| *o != handle.options) {
        return Err(viewer);
    }
    // Under the slot lock, so no frame reaches the new view before them.
    let mut slot = lock(&handle.viewer);
    let records = handle.tap.cached_records();
    if !records.is_empty() {
        let _ = viewer.video.send(InvokeResponseBody::Raw(records));
    }
    let window = viewer.window.clone();
    if let Some(old) = slot.replace(viewer)
        && old.window != window
    {
        let _ = old.events.send(MirrorEvent::Detached);
    }
    let _ = handle.control.send(ControlMessage::ResetVideo.encode());
    Ok(handle.info.clone())
}

/// The calling window stops showing `serial`. With `session_id`, only that
/// session is affected (a late cleanup must not touch its replacement).
/// The session ends after a grace period unless another view takes it
/// over or it is being recorded.
#[tauri::command]
pub fn mirror_stop(
    window: Window,
    mirror: State<'_, MirrorState>,
    serial: String,
    session_id: Option<u64>,
) {
    release(&mirror.sessions, &serial, session_id, window.label());
}

fn release(sessions: &Sessions, serial: &str, session_id: Option<u64>, window: &str) {
    let map = lock(sessions);
    let Some(handle) = map.get(serial) else {
        return;
    };
    if session_id.is_some_and(|id| id != handle.id) {
        return;
    }
    {
        let mut slot = lock(&handle.viewer);
        if slot.as_ref().is_some_and(|v| v.window != window) {
            return;
        }
        *slot = None;
    }
    let id = handle.id;
    drop(map);
    stop_if_orphaned_later(sessions.clone(), serial.to_owned(), id);
}

/// Stops session `id` after [`GRACE`] if by then nobody shows, holds or
/// records it.
fn stop_if_orphaned_later(sessions: Sessions, serial: String, id: u64) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(GRACE).await;
        let mut map = lock(&sessions);
        let orphaned = map.get(&serial).is_some_and(|h| {
            h.id == id && lock(&h.viewer).is_none() && h.popout.is_none() && !h.tap.is_recording()
        });
        if orphaned && let Some(handle) = map.remove(&serial) {
            handle.task.abort();
        }
    });
}

/// Sends one control message (touch, key, text, clipboard…) to the device.
#[tauri::command]
pub fn mirror_control(
    mirror: State<'_, MirrorState>,
    serial: String,
    message: ControlMessage,
) -> AppResult<()> {
    let map = lock(&mirror.sessions);
    let session = map.get(&serial).ok_or_else(not_mirrored)?;
    session
        .control
        .send(message.encode())
        .map_err(|_| AppError::Device("the mirroring session has ended".into()))
}

fn stop_session(mirror: &MirrorState, serial: &str, session_id: Option<u64>) {
    let mut map = lock(&mirror.sessions);
    let matches = map
        .get(serial)
        .is_some_and(|h| session_id.is_none_or(|id| id == h.id));
    if matches && let Some(handle) = map.remove(serial) {
        handle.task.abort();
    }
}

// --- Pop-out window -------------------------------------------------------

/// Window label for a serial: labels allow only `a-zA-Z0-9-/:_`.
fn popout_label(serial: &str) -> String {
    let hex: String = serial.bytes().map(|b| format!("{b:02x}")).collect();
    format!("{POPOUT_PREFIX}{hex}")
}

/// Percent-encodes everything but unreserved characters (RFC 3986).
fn encode_query(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                (b as char).to_string()
            }
            b => format!("%{b:02X}"),
        })
        .collect()
}

/// Opens (or focuses) a small always-on-top window that shows the running
/// session of `serial`. The pop-out takes the stream over with
/// `mirror_attach`; when it closes, `on_closed` fires so the main window
/// can take it back.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn mirror_popout(
    app: AppHandle,
    mirror: State<'_, MirrorState>,
    serial: String,
    name: String,
    width: f64,
    height: f64,
    on_closed: Channel<()>,
) -> AppResult<()> {
    let label = popout_label(&serial);
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.set_focus();
        return Ok(());
    }
    {
        let mut map = lock(&mirror.sessions);
        let handle = map.get_mut(&serial).ok_or_else(not_mirrored)?;
        handle.popout = Some(label.clone());
    }

    let url = WebviewUrl::App(
        format!(
            "index.html?popout={}&name={}",
            encode_query(&serial),
            encode_query(&name)
        )
        .into(),
    );
    let mut builder = WebviewWindowBuilder::new(&app, &label, url)
        .title(name)
        .inner_size(width.clamp(160.0, 1200.0), height.clamp(240.0, 1600.0))
        .min_inner_size(160.0, 240.0)
        .always_on_top(true)
        .decorations(false)
        .resizable(true)
        .focused(true);
    // Top-right corner of the main window, like a PiP overlay.
    if let Some(main) = app.get_webview_window("main")
        && let (Ok(pos), Ok(size), Ok(scale)) = (
            main.outer_position(),
            main.outer_size(),
            main.scale_factor(),
        )
    {
        let pos: LogicalPosition<f64> = pos.to_logical(scale);
        let size: LogicalSize<f64> = size.to_logical(scale);
        builder = builder.position(pos.x + size.width - width - 24.0, pos.y + 56.0);
    }
    let window = match builder.build() {
        Ok(window) => window,
        Err(e) => {
            if let Some(handle) = lock(&mirror.sessions).get_mut(&serial) {
                handle.popout = None;
            }
            return Err(AppError::Device(format!(
                "couldn't open the pop-out window: {e}"
            )));
        }
    };
    // Window event callbacks run inside the event loop while it holds its
    // window table, and the callbacks themselves are dropped there too.
    // Anything that talks to a webview (closing a window, a Channel
    // message, even dropping a Channel, which unregisters it in its
    // webview) must happen later, off the callback.
    // Closing the main window takes its pop-outs along.
    if let Some(main) = app.get_webview_window("main") {
        let popout = window.clone();
        main.on_window_event(move |event| {
            if let WindowEvent::Destroyed = event {
                let popout = popout.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = popout.close();
                });
            }
        });
    }
    let handle_app = app.clone();
    let on_closed = Mutex::new(Some(on_closed));
    window.on_window_event(move |event| {
        if let WindowEvent::Destroyed = event {
            let app = handle_app.clone();
            let label = label.clone();
            let on_closed = lock(&on_closed).take();
            tauri::async_runtime::spawn(async move {
                popout_closed(&app, &label);
                if let Some(channel) = on_closed {
                    let _ = channel.send(());
                }
            });
        }
    });
    Ok(())
}

/// The pop-out of `serial` closes; with `focus_main`, the main window comes
/// to the front (the pop-out's "back to main window").
#[tauri::command]
pub fn mirror_popout_close(app: AppHandle, serial: String, focus_main: bool) -> AppResult<()> {
    if focus_main && let Some(main) = app.get_webview_window("main") {
        let _ = main.unminimize();
        let _ = main.set_focus();
    }
    if let Some(window) = app.get_webview_window(&popout_label(&serial)) {
        window
            .close()
            .map_err(|e| AppError::Device(format!("couldn't close the window: {e}")))?;
    }
    Ok(())
}

/// Releases everything the closed pop-out `label` held.
fn popout_closed(app: &AppHandle, label: &str) {
    let mirror = app.state::<MirrorState>();
    let mut orphaned = Vec::new();
    {
        let mut map = lock(&mirror.sessions);
        for (serial, handle) in map.iter_mut() {
            let mut slot = lock(&handle.viewer);
            let watching = slot.as_ref().is_some_and(|v| v.window == label);
            if watching {
                *slot = None;
            }
            if handle.popout.as_deref() == Some(label) || watching {
                handle.popout = None;
                orphaned.push((serial.clone(), handle.id));
            }
        }
    }
    for (serial, id) in orphaned {
        stop_if_orphaned_later(mirror.sessions.clone(), serial, id);
    }
}

// --- Recording ------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingStarted {
    pub path: String,
    pub name: String,
    /// Folder for display, with `~` for the home directory.
    pub dir: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum RecordEvent {
    /// About once a second while frames arrive.
    Progress { bytes: u64, duration_ms: u64 },
    /// The recording ended without `mirror_record_stop` (the session went
    /// away); the file is saved if any frame was written.
    Ended {
        capture: Option<Capture>,
        error: Option<AppError>,
    },
}

/// `~/Pictures/Tether/Pixel 8/` for display.
fn display_dir(app: &AppHandle, dir: &Path) -> String {
    let home = app.path().home_dir().ok();
    let shown = match home.as_deref().and_then(|h| dir.strip_prefix(h).ok()) {
        Some(rest) => Path::new("~").join(rest),
        None => dir.to_path_buf(),
    };
    let mut text = shown.to_string_lossy().into_owned();
    if !text.ends_with(std::path::MAIN_SEPARATOR) {
        text.push(std::path::MAIN_SEPARATOR);
    }
    text
}

async fn describe_saved(path: &Path) -> AppResult<Capture> {
    let device = path
        .parent()
        .and_then(Path::file_name)
        .map(|n| n.to_string_lossy().into_owned());
    captures::describe(path, device)
        .await
        .ok_or_else(|| AppError::Device("the recording was not saved".into()))
}

/// Starts recording the mirrored stream of `serial` to
/// `~/Pictures/Tether/<device>/Recording_<stamp>.mp4` (the captures
/// folder), from the next key frame on.
#[tauri::command]
pub async fn mirror_record_start(
    app: AppHandle,
    mirror: State<'_, MirrorState>,
    serial: String,
    device_name: String,
    stamp: String,
    on_event: Channel<RecordEvent>,
) -> AppResult<RecordingStarted> {
    let stamp = captures::validate_stamp(&stamp)?.to_owned();
    let (codec, tap, control) = {
        let map = lock(&mirror.sessions);
        let handle = map.get(&serial).ok_or_else(not_mirrored)?;
        (
            handle.info.video_codec,
            handle.tap.clone(),
            handle.control.clone(),
        )
    };
    if tap.is_recording() {
        return Err(AppError::InvalidInput(
            "this device is already being recorded".into(),
        ));
    }
    let root = captures_root(&app)?;
    let dir = captures::device_dir(&root, &device_name).await?;
    let path = captures::unique_path(&dir, &format!("Recording_{stamp}"), "mp4");

    let progress = on_event.clone();
    let recorder = Recorder::start(
        codec,
        path.clone(),
        Box::new(move |p: Progress| {
            let _ = progress.send(RecordEvent::Progress {
                bytes: p.bytes,
                duration_ms: p.duration_ms,
            });
        }),
        Box::new(move |result| {
            tauri::async_runtime::spawn(async move {
                let event = match result {
                    Ok(saved) => match describe_saved(&saved.path).await {
                        Ok(capture) => RecordEvent::Ended {
                            capture: Some(capture),
                            error: None,
                        },
                        Err(e) => RecordEvent::Ended {
                            capture: None,
                            error: Some(e),
                        },
                    },
                    Err(e) => RecordEvent::Ended {
                        capture: None,
                        error: Some(e),
                    },
                };
                let _ = on_event.send(event);
            });
        }),
    )?;
    tap.attach(recorder)?;
    // A key frame now instead of at the next periodic one (~10 s).
    let _ = control.send(ControlMessage::ResetVideo.encode());

    Ok(RecordingStarted {
        name: path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        path: path.to_string_lossy().into_owned(),
        dir: display_dir(&app, &dir),
    })
}

/// Stops the recording of `serial` and returns the saved file.
#[tauri::command]
pub async fn mirror_record_stop(
    mirror: State<'_, MirrorState>,
    serial: String,
) -> AppResult<Capture> {
    let (recorder, id) = {
        let map = lock(&mirror.sessions);
        let handle = map.get(&serial).ok_or_else(not_mirrored)?;
        let recorder = handle
            .tap
            .detach()
            .ok_or_else(|| AppError::InvalidInput("the device is not being recorded".into()))?;
        (recorder, handle.id)
    };
    let saved = recorder.stop().await;
    // Recording may have been all that kept a hidden session alive.
    stop_if_orphaned_later(mirror.sessions.clone(), serial, id);
    describe_saved(&saved?.path).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn popout_labels_are_valid() {
        let label = popout_label("192.168.1.5:5555");
        assert!(label.starts_with(POPOUT_PREFIX));
        assert!(
            label
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "-/:_".contains(c))
        );
        assert_ne!(label, popout_label("192.168.1.5:5556"));
    }

    #[test]
    fn query_encoding() {
        assert_eq!(encode_query("emulator-5554"), "emulator-5554");
        assert_eq!(
            encode_query("adb-1A2B._adb-tls-connect._tcp"),
            "adb-1A2B._adb-tls-connect._tcp"
        );
        assert_eq!(encode_query("10.0.0.2:5555"), "10.0.0.2%3A5555");
        assert_eq!(encode_query("a b&c"), "a%20b%26c");
    }
}
