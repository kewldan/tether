//! Sideload OTA: package checks and the `adb sideload` transfer.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::State;
use tauri::ipc::Channel;

use crate::adb::devices::DeviceState;
use crate::adb::sideload::{self, Progress, SideloadMode};
use crate::commands::connection::list_devices;
use crate::device::ota::{self, OtaPackage};
use crate::error::{AppError, AppResult};
use crate::state::{AppState, lock};

/// Progress events are sent at most this often (a 2 GB package is ~70k
/// blocks, each served about twice).
const PROGRESS_EVERY: Duration = Duration::from_millis(150);

/// Cancellation flags of running sideloads, by serial.
#[derive(Default)]
pub struct SideloadState {
    running: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum SideloadEvent {
    Progress {
        mode: SideloadMode,
        #[serde(flatten)]
        progress: Progress,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SideloadResult {
    pub mode: SideloadMode,
    pub elapsed_ms: u64,
}

#[tauri::command]
pub async fn sideload_inspect(path: String) -> AppResult<OtaPackage> {
    let path = PathBuf::from(path);
    tauri::async_runtime::spawn_blocking(move || ota::inspect(&path))
        .await
        .map_err(|e| AppError::Device(e.to_string()))?
}

/// Streams `path` to a device waiting in "Apply update from ADB". Refuses
/// to start unless the device is in the `sideload` state.
#[tauri::command]
pub async fn sideload_start(
    state: State<'_, AppState>,
    jobs: State<'_, SideloadState>,
    serial: String,
    path: String,
    on_event: Channel<SideloadEvent>,
) -> AppResult<SideloadResult> {
    let devices = list_devices(&state.server).await?;
    match devices
        .iter()
        .find(|d| d.serial == serial)
        .map(|d| &d.state)
    {
        Some(DeviceState::Sideload) => {}
        Some(_) => {
            return Err(AppError::InvalidInput(
                "the device is not waiting for a sideload; choose \"Apply update from ADB\" in \
                 recovery first"
                    .into(),
            ));
        }
        None => return Err(AppError::Device("device not found".into())),
    }

    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut running = lock(&jobs.running);
        if running.contains_key(&serial) {
            return Err(AppError::InvalidInput(
                "a sideload is already running for this device".into(),
            ));
        }
        running.insert(serial.clone(), cancel.clone());
    }

    let started = Instant::now();
    let mut last_sent: Option<(Instant, u8)> = None;
    let result = sideload::sideload(
        &state.server,
        &serial,
        &PathBuf::from(&path),
        &cancel,
        |mode, progress| {
            let due = last_sent
                .is_none_or(|(at, pct)| at.elapsed() >= PROGRESS_EVERY || pct != progress.percent);
            if due {
                last_sent = Some((Instant::now(), progress.percent));
                let _ = on_event.send(SideloadEvent::Progress { mode, progress });
            }
        },
    )
    .await;
    lock(&jobs.running).remove(&serial);

    let mode = result?;
    Ok(SideloadResult {
        mode,
        elapsed_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
    })
}

/// Stops serving the package. Unsafe once recovery started installing: the
/// UI asks first.
#[tauri::command]
pub fn sideload_cancel(jobs: State<'_, SideloadState>, serial: String) {
    if let Some(flag) = lock(&jobs.running).get(&serial) {
        flag.store(true, Ordering::Relaxed);
    }
}
