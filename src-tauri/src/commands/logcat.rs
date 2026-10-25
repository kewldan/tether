use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::async_runtime::JoinHandle;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use crate::device::logcat::{self, LogEntry, Package, PackageProcesses, StreamOptions};
use crate::error::{AppError, AppResult};
use crate::state::{AppState, lock};

/// Running logcat streams keyed by session id. Several can run at once
/// (one per device or window).
#[derive(Default)]
pub struct LogcatSessions {
    next_id: AtomicU32,
    tasks: Arc<Mutex<HashMap<u32, JoinHandle<()>>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum LogcatEvent {
    Batch {
        entries: Vec<LogEntry>,
    },
    /// The stream stopped on its own: the device disconnected or logcat
    /// exited. Not sent after `logcat_stop`.
    Ended {
        error: Option<AppError>,
    },
}

/// Starts streaming logcat of `serial` to `on_event` and returns the
/// session id for `logcat_stop`.
#[tauri::command]
pub async fn logcat_start(
    state: State<'_, AppState>,
    sessions: State<'_, LogcatSessions>,
    serial: String,
    options: StreamOptions,
    on_event: Channel<LogcatEvent>,
) -> AppResult<u32> {
    // Reject bad options before spawning, so the caller gets the error.
    logcat::stream_command(&options)?;
    let server = state.server;
    let id = sessions.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let tasks = sessions.tasks.clone();

    // Hold the lock while spawning so the task cannot remove itself before
    // it is registered.
    let mut guard = lock(&sessions.tasks);
    let handle = tauri::async_runtime::spawn(async move {
        let result = logcat::stream(&server, &serial, &options, |entries| {
            let _ = on_event.send(LogcatEvent::Batch { entries });
        })
        .await;
        let _ = on_event.send(LogcatEvent::Ended {
            error: result.err(),
        });
        lock(&tasks).remove(&id);
    });
    guard.insert(id, handle);
    Ok(id)
}

/// Stops a stream; closing the connection makes adbd kill logcat.
#[tauri::command]
pub fn logcat_stop(sessions: State<'_, LogcatSessions>, session: u32) {
    if let Some(handle) = lock(&sessions.tasks).remove(&session) {
        handle.abort();
    }
}

/// `logcat -c`: clears the given buffers on the device.
#[tauri::command]
pub async fn logcat_clear(
    state: State<'_, AppState>,
    serial: String,
    buffers: Vec<String>,
) -> AppResult<()> {
    logcat::clear(&state.server, &serial, &buffers).await
}

/// Installed packages for the package filter, user apps first.
#[tauri::command]
pub async fn logcat_packages(
    state: State<'_, AppState>,
    serial: String,
) -> AppResult<Vec<Package>> {
    logcat::packages(&state.server, &serial).await
}

/// Uid and running processes of a package, to filter by it and follow it
/// across restarts.
#[tauri::command]
pub async fn logcat_package_processes(
    state: State<'_, AppState>,
    serial: String,
    package: String,
) -> AppResult<PackageProcesses> {
    logcat::package_processes(&state.server, &serial, &package).await
}

/// Writes exported log text to the user's Downloads folder and returns the
/// full path.
#[tauri::command]
pub async fn logcat_export(
    app: AppHandle,
    file_name: String,
    contents: String,
) -> AppResult<String> {
    let valid = !file_name.is_empty()
        && file_name.len() <= 128
        && !file_name.starts_with('.')
        && file_name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    if !valid {
        return Err(AppError::InvalidInput(format!(
            "bad file name {file_name:?}"
        )));
    }
    let dir: PathBuf = app
        .path()
        .download_dir()
        .or_else(|_| app.path().home_dir())
        .map_err(|e| AppError::Device(e.to_string()))?;
    let path = unique_path(&dir, &file_name);
    tokio::fs::write(&path, contents).await?;
    Ok(path.to_string_lossy().into_owned())
}

/// `name.txt`, then `name (2).txt`, … so earlier exports are kept.
fn unique_path(dir: &std::path::Path, file_name: &str) -> PathBuf {
    let first = dir.join(file_name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = file_name
        .rsplit_once('.')
        .map_or((file_name, ""), |(s, e)| (s, e));
    (2..1000)
        .map(|n| {
            if ext.is_empty() {
                dir.join(format!("{stem} ({n})"))
            } else {
                dir.join(format!("{stem} ({n}).{ext}"))
            }
        })
        .find(|p| !p.exists())
        .unwrap_or(first)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unique_path_skips_existing_files() {
        let dir = tempfile::tempdir().unwrap();
        let a = unique_path(dir.path(), "logcat.txt");
        assert_eq!(a, dir.path().join("logcat.txt"));
        std::fs::write(&a, "x").unwrap();
        assert_eq!(
            unique_path(dir.path(), "logcat.txt"),
            dir.path().join("logcat (2).txt")
        );
    }
}
