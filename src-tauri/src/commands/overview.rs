//! Overview page: live snapshot, reboot, screenshot, screen recording.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use tokio::sync::watch;

use crate::device::actions::{self, RebootTarget};
use crate::device::captures::{self, Capture};
use crate::device::overview::{self, CpuTimes, DeviceSnapshot};
use crate::error::{AppError, AppResult};
use crate::state::{AppState, lock};

/// A CPU sample older than this is not used for the load delta.
const CPU_SAMPLE_TTL: Duration = Duration::from_secs(20);

struct ActiveRecording {
    pid: u32,
    remote: String,
    started: Instant,
    /// Flips to `true` once screenrecord has exited.
    done: watch::Receiver<bool>,
    output: std::sync::Arc<Mutex<String>>,
}

#[derive(Default)]
pub struct OverviewState {
    cpu: Mutex<HashMap<String, (Instant, Vec<CpuTimes>)>>,
    recordings: Mutex<HashMap<String, ActiveRecording>>,
}

pub fn captures_root(app: &AppHandle) -> AppResult<PathBuf> {
    let pictures = app
        .path()
        .picture_dir()
        .or_else(|_| app.path().home_dir())
        .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))?;
    Ok(pictures.join("Tether"))
}

#[tauri::command]
pub async fn device_snapshot(
    state: State<'_, AppState>,
    overview: State<'_, OverviewState>,
    serial: String,
) -> AppResult<DeviceSnapshot> {
    let prev = lock(&overview.cpu)
        .get(&serial)
        .filter(|(at, _)| at.elapsed() < CPU_SAMPLE_TTL)
        .map(|(_, sample)| sample.clone());
    let (snapshot, sample) = overview::snapshot(&state.server, &serial, prev).await?;
    lock(&overview.cpu).insert(serial, (Instant::now(), sample));
    Ok(snapshot)
}

#[tauri::command]
pub async fn reboot_device(
    state: State<'_, AppState>,
    serial: String,
    target: RebootTarget,
) -> AppResult<()> {
    actions::reboot(&state.server, &serial, target).await
}

/// Saves a screenshot to `~/Pictures/Tether/<device>/Screenshot_<stamp>.png`.
#[tauri::command]
pub async fn take_screenshot(
    app: AppHandle,
    state: State<'_, AppState>,
    serial: String,
    device_name: String,
    stamp: String,
) -> AppResult<Capture> {
    let stamp = captures::validate_stamp(&stamp)?;
    let png = actions::screenshot(&state.server, &serial).await?;
    let root = captures_root(&app)?;
    captures::save(
        &root,
        &device_name,
        &format!("Screenshot_{stamp}"),
        "png",
        &png,
    )
    .await
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum RecordingEvent {
    /// screenrecord exited on its own (time limit, error); call
    /// `stop_recording` to fetch the file.
    Ended { message: Option<String> },
}

/// Starts `screenrecord` into `/data/local/tmp`. Only one recording per
/// device at a time.
#[tauri::command]
pub async fn start_recording(
    state: State<'_, AppState>,
    overview: State<'_, OverviewState>,
    serial: String,
    on_event: Channel<RecordingEvent>,
) -> AppResult<()> {
    if lock(&overview.recordings).contains_key(&serial) {
        return Err(AppError::InvalidInput(
            "a recording is already running on this device".into(),
        ));
    }
    let remote = format!("/data/local/tmp/tether-rec-{}.mp4", overview::now_ms());
    let mut process = actions::start_recording(&state.server, &serial, &remote).await?;
    let pid = process.pid;
    let (tx, rx) = watch::channel(false);
    let output = std::sync::Arc::new(Mutex::new(String::new()));
    let output_slot = output.clone();
    tauri::async_runtime::spawn(async move {
        let text = actions::wait_recording(&mut process).await;
        let message = (!text.trim().is_empty()).then(|| text.trim().to_owned());
        *lock(&output_slot) = text;
        let _ = tx.send(true);
        let _ = on_event.send(RecordingEvent::Ended { message });
    });
    lock(&overview.recordings).insert(
        serial,
        ActiveRecording {
            pid,
            remote,
            started: Instant::now(),
            done: rx,
            output,
        },
    );
    Ok(())
}

/// Stops the recording, pulls the mp4 into the captures folder and removes
/// it from the device.
#[tauri::command]
pub async fn stop_recording(
    app: AppHandle,
    state: State<'_, AppState>,
    overview: State<'_, OverviewState>,
    serial: String,
    device_name: String,
    stamp: String,
) -> AppResult<Capture> {
    let stamp = captures::validate_stamp(&stamp)?.to_owned();
    let mut recording = lock(&overview.recordings)
        .remove(&serial)
        .ok_or_else(|| AppError::InvalidInput("no recording is running".into()))?;
    let server = state.server;

    if !*recording.done.borrow() {
        actions::interrupt(&server, &serial, recording.pid).await?;
    }
    // screenrecord needs a moment to write the moov atom.
    let _ = tokio::time::timeout(
        Duration::from_secs(15),
        recording.done.wait_for(|done| *done),
    )
    .await;

    let result = async {
        let root = captures_root(&app)?;
        let dir = captures::device_dir(&root, &device_name).await?;
        let dest = captures::unique_path(&dir, &format!("Recording_{stamp}"), "mp4");
        let never = AtomicBool::new(false);
        let size = actions::pull(
            &server,
            &serial,
            &recording.remote,
            &dest,
            &never,
            |_, _| {},
        )
        .await
        .map_err(|e| {
            let output = lock(&recording.output).trim().to_owned();
            if output.is_empty() {
                e
            } else {
                AppError::Device(output)
            }
        })?;
        if size == 0 {
            let _ = tokio::fs::remove_file(&dest).await;
            return Err(AppError::Device("the recording is empty".into()));
        }
        captures::describe(&dest, Some(captures::sanitize_component(&device_name)))
            .await
            .ok_or_else(|| AppError::Device("recording was not saved".into()))
    }
    .await;
    let _ = actions::remove_remote(&server, &serial, &recording.remote).await;
    result
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingStatus {
    pub elapsed_ms: u64,
    pub running: bool,
}

/// Whether a recording is in progress on the device (survives page
/// reloads of the UI).
#[tauri::command]
pub fn recording_status(
    overview: State<'_, OverviewState>,
    serial: String,
) -> Option<RecordingStatus> {
    lock(&overview.recordings)
        .get(&serial)
        .map(|r| RecordingStatus {
            elapsed_ms: r.started.elapsed().as_millis() as u64,
            running: !*r.done.borrow(),
        })
}
