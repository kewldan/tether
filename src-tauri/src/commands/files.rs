//! File manager commands: listings, file operations, previews and
//! streaming transfers.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, Response};
use tauri::{AppHandle, Manager, State};

use crate::device::files::{self, DirListing, StorageInfo};
use crate::device::transfer::{self, TransferControl, TransferEvent, TransferSummary};
use crate::error::{AppError, AppResult};
use crate::state::{AppState, lock};

/// Largest preview the UI may request (images); text asks for less.
const PREVIEW_MAX: usize = 16 * 1024 * 1024;

/// Running transfers by the id the frontend gave them.
#[derive(Default)]
pub struct FilesState {
    transfers: Mutex<HashMap<String, Arc<TransferControl>>>,
}

impl FilesState {
    fn register(&self, id: &str) -> AppResult<Arc<TransferControl>> {
        let mut transfers = lock(&self.transfers);
        if transfers.contains_key(id) {
            return Err(AppError::InvalidInput(format!(
                "transfer {id} is already running"
            )));
        }
        let control = Arc::new(TransferControl::default());
        transfers.insert(id.to_owned(), control.clone());
        Ok(control)
    }

    fn finish(&self, id: &str) {
        lock(&self.transfers).remove(id);
    }
}

#[tauri::command]
pub async fn files_list(
    state: State<'_, AppState>,
    serial: String,
    path: String,
) -> AppResult<DirListing> {
    files::list_dir(&state.server, &serial, &path).await
}

#[tauri::command]
pub async fn files_mkdir(
    state: State<'_, AppState>,
    serial: String,
    path: String,
) -> AppResult<()> {
    files::mkdir(&state.server, &serial, &path).await
}

#[tauri::command]
pub async fn files_rename(
    state: State<'_, AppState>,
    serial: String,
    from: String,
    to: String,
) -> AppResult<()> {
    files::rename(&state.server, &serial, &from, &to).await
}

#[tauri::command]
pub async fn files_delete(
    state: State<'_, AppState>,
    serial: String,
    paths: Vec<String>,
) -> AppResult<()> {
    files::delete(&state.server, &serial, &paths).await
}

#[tauri::command]
pub async fn files_chmod(
    state: State<'_, AppState>,
    serial: String,
    paths: Vec<String>,
    mode: String,
    recursive: bool,
) -> AppResult<()> {
    files::chmod(&state.server, &serial, &paths, &mode, recursive).await
}

#[tauri::command]
pub async fn files_storage(
    state: State<'_, AppState>,
    serial: String,
    path: String,
) -> AppResult<StorageInfo> {
    files::storage(&state.server, &serial, &path).await
}

/// The first `max_bytes` of a file as raw bytes (an `ArrayBuffer` in JS).
#[tauri::command]
pub async fn files_preview(
    state: State<'_, AppState>,
    serial: String,
    path: String,
    max_bytes: usize,
) -> AppResult<Response> {
    let data = files::read_head(&state.server, &serial, &path, max_bytes.min(PREVIEW_MAX)).await?;
    Ok(Response::new(data))
}

/// Where downloads go unless the user picks another folder.
#[tauri::command]
pub fn files_default_download_dir(app: AppHandle) -> AppResult<String> {
    let dir = app
        .path()
        .download_dir()
        .or_else(|_| app.path().home_dir())
        .map_err(|e| AppError::InvalidInput(e.to_string()))?;
    Ok(dir.to_string_lossy().into_owned())
}

#[derive(Debug, Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSummary {
    pub files: u64,
    pub folders: u64,
    pub bytes: u64,
}

/// Counts what dropping these local paths would upload.
#[tauri::command]
pub async fn files_local_summary(paths: Vec<String>) -> AppResult<LocalSummary> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut summary = LocalSummary::default();
        let mut stack: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
        let mut visited = 0usize;
        while let Some(path) = stack.pop() {
            visited += 1;
            // Huge trees: a rough count is enough for the overlay.
            if visited > 50_000 {
                break;
            }
            let Ok(meta) = std::fs::metadata(&path) else {
                continue;
            };
            if meta.is_dir() {
                summary.folders += 1;
                if let Ok(dir) = std::fs::read_dir(&path) {
                    stack.extend(dir.flatten().map(|e| e.path()));
                }
            } else {
                summary.files += 1;
                summary.bytes += meta.len();
            }
        }
        summary
    })
    .await
    .map_err(|e| AppError::InvalidInput(e.to_string()))
}

#[tauri::command]
pub async fn files_pull(
    state: State<'_, AppState>,
    files_state: State<'_, FilesState>,
    id: String,
    serial: String,
    paths: Vec<String>,
    local_dir: String,
    on_event: Channel<TransferEvent>,
) -> AppResult<TransferSummary> {
    let control = files_state.register(&id)?;
    let result = transfer::pull(
        &state.server,
        &serial,
        &paths,
        &PathBuf::from(local_dir),
        &control,
        |event| {
            let _ = on_event.send(event);
        },
    )
    .await;
    files_state.finish(&id);
    result
}

#[tauri::command]
pub async fn files_push(
    state: State<'_, AppState>,
    files_state: State<'_, FilesState>,
    id: String,
    serial: String,
    paths: Vec<String>,
    remote_dir: String,
    on_event: Channel<TransferEvent>,
) -> AppResult<TransferSummary> {
    let control = files_state.register(&id)?;
    let locals: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    let result = transfer::push(
        &state.server,
        &serial,
        &locals,
        &remote_dir,
        &control,
        |event| {
            let _ = on_event.send(event);
        },
    )
    .await;
    files_state.finish(&id);
    result
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransferAction {
    Cancel,
    Pause,
    Resume,
}

/// Cancels, pauses or resumes a running transfer. Unknown ids (already
/// finished) are ignored.
#[tauri::command]
pub fn files_transfer_control(
    files_state: State<'_, FilesState>,
    id: String,
    action: TransferAction,
) {
    if let Some(control) = lock(&files_state.transfers).get(&id) {
        match action {
            TransferAction::Cancel => control.cancel.store(true, Ordering::Relaxed),
            TransferAction::Pause => control.pause.store(true, Ordering::Relaxed),
            TransferAction::Resume => control.pause.store(false, Ordering::Relaxed),
        }
    }
}
