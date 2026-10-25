use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use serde::Serialize;
use tauri::State;
use tauri::async_runtime::JoinHandle;
use tauri::ipc::Channel;

use crate::device::perf::{self, CpuInfo, PerfSample, Process, Sampler};
use crate::error::{AppError, AppResult};
use crate::state::{AppState, lock};

#[derive(Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum PerfEvent {
    /// Sent once when sampling starts.
    Info {
        cpu: CpuInfo,
    },
    Sample {
        sample: PerfSample,
    },
    /// Sampling stopped (device gone, adb error).
    Error {
        error: AppError,
    },
}

#[derive(Default)]
pub struct PerfSubscriptions {
    next_id: AtomicU32,
    tasks: Mutex<HashMap<u32, JoinHandle<()>>>,
}

const MIN_INTERVAL_MS: u64 = 250;

/// Samples the device every `interval_ms` (default 1 s) until
/// [`perf_unsubscribe`]. `package` adds frame rate and PSS of that app.
#[tauri::command]
pub fn perf_subscribe(
    state: State<'_, AppState>,
    subs: State<'_, PerfSubscriptions>,
    serial: String,
    package: Option<String>,
    interval_ms: Option<u64>,
    on_event: Channel<PerfEvent>,
) -> AppResult<u32> {
    let mut sampler = Sampler::new(package.filter(|p| !p.trim().is_empty()))?;
    let server = state.server;
    let interval = Duration::from_millis(interval_ms.unwrap_or(1000).max(MIN_INTERVAL_MS));

    let task = tauri::async_runtime::spawn(async move {
        if let Ok(cpu) = perf::cpu_info(&server, &serial).await {
            let _ = on_event.send(PerfEvent::Info { cpu });
        }
        let mut ticker = tokio::time::interval(interval);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;
            match sampler.sample(&server, &serial).await {
                Ok(sample) => {
                    if on_event.send(PerfEvent::Sample { sample }).is_err() {
                        break;
                    }
                }
                Err(error) => {
                    let _ = on_event.send(PerfEvent::Error { error });
                    break;
                }
            }
        }
    });

    let id = subs.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    lock(&subs.tasks).insert(id, task);
    Ok(id)
}

#[tauri::command]
pub fn perf_unsubscribe(subs: State<'_, PerfSubscriptions>, id: u32) {
    if let Some(task) = lock(&subs.tasks).remove(&id) {
        task.abort();
    }
}

#[tauri::command]
pub async fn perf_processes(state: State<'_, AppState>, serial: String) -> AppResult<Vec<Process>> {
    perf::processes(&state.server, &serial).await
}

/// Stops a process: `am force-stop` for app packages, `kill` otherwise.
#[tauri::command]
pub async fn perf_kill(
    state: State<'_, AppState>,
    serial: String,
    pid: u32,
    package: Option<String>,
) -> AppResult<()> {
    perf::kill(&state.server, &serial, pid, package.as_deref()).await
}

/// Writes exported samples to the Downloads folder and returns the path.
#[tauri::command]
pub async fn perf_export_csv(
    app: tauri::AppHandle,
    file_name: String,
    contents: String,
) -> AppResult<String> {
    use tauri::Manager;

    let valid = file_name.ends_with(".csv")
        && file_name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c));
    if !valid {
        return Err(AppError::InvalidInput(format!(
            "bad file name {file_name:?}"
        )));
    }
    let dir = app
        .path()
        .download_dir()
        .map_err(|e| AppError::Device(e.to_string()))?;
    let path = dir.join(file_name);
    tokio::fs::write(&path, contents).await?;
    Ok(path.to_string_lossy().into_owned())
}
