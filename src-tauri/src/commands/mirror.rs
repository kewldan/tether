use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager, State};

use crate::error::{AppError, AppResult};
use crate::mirror::control::ControlMessage;
use crate::mirror::session::{self, MirrorEvent, MirrorInfo, MirrorOptions};
use crate::mirror::{MirrorState, SERVER_RESOURCE, SessionHandle};
use crate::state::{AppState, lock};

static NEXT_SESSION: AtomicU64 = AtomicU64::new(1);

/// Starts mirroring `serial`, replacing a running session for it. Binary
/// records (see `mirror::protocol::record`) go to `on_video`, everything
/// else to `on_event`. Resolves once the video stream is announced.
#[tauri::command]
pub async fn mirror_start(
    app: AppHandle,
    state: State<'_, AppState>,
    mirror: State<'_, MirrorState>,
    serial: String,
    options: MirrorOptions,
    on_video: Channel<InvokeResponseBody>,
    on_event: Channel<MirrorEvent>,
) -> AppResult<MirrorInfo> {
    // One start at a time: two servers racing for the same jar path (e.g.
    // React StrictMode remounts) would break each other.
    let _starting = mirror.starting.lock().await;
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
    let video = on_video.clone();
    let events = on_event.clone();
    let running = session::start(
        state.server,
        &serial,
        id,
        &jar,
        &options,
        Arc::new(move |batch| {
            let _ = video.send(InvokeResponseBody::Raw(batch));
        }),
        Arc::new(move |event| {
            let _ = events.send(event);
        }),
    )
    .await?;

    let info = running.info.clone();
    let sessions = mirror.sessions.clone();
    // Spawn while holding the map lock so the task cannot try to remove
    // its entry before it is inserted.
    let mut map = lock(&mirror.sessions);
    let task_serial = serial.clone();
    let task = tauri::async_runtime::spawn(async move {
        let result = running.run.await;
        {
            let mut map = lock(&sessions);
            if map.get(&task_serial).is_some_and(|h| h.id == id) {
                map.remove(&task_serial);
            }
        }
        let _ = on_event.send(MirrorEvent::Stopped {
            error: result.err(),
        });
    });
    if let Some(previous) = map.insert(
        serial,
        SessionHandle {
            id,
            control: running.control,
            task,
        },
    ) {
        previous.task.abort();
    }
    Ok(info)
}

/// Stops mirroring `serial`. With `session_id`, only that session is
/// stopped (a late cleanup must not kill its replacement).
#[tauri::command]
pub fn mirror_stop(mirror: State<'_, MirrorState>, serial: String, session_id: Option<u64>) {
    stop_session(&mirror, &serial, session_id);
}

/// Sends one control message (touch, key, text, clipboard…) to the device.
#[tauri::command]
pub fn mirror_control(
    mirror: State<'_, MirrorState>,
    serial: String,
    message: ControlMessage,
) -> AppResult<()> {
    let map = lock(&mirror.sessions);
    let session = map
        .get(&serial)
        .ok_or_else(|| AppError::Device("the device is not being mirrored".into()))?;
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
