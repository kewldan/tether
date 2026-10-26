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
use crate::localfs::{self, LocalListing, LocalPlace};
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

// ------------------------------------------------- computer side (two-pane) --

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| AppError::InvalidInput(e.to_string()))?
}

/// Lists a folder on the computer.
#[tauri::command]
pub async fn files_local_list(path: String) -> AppResult<LocalListing> {
    blocking(move || localfs::list(&PathBuf::from(path))).await
}

/// Resolves a typed local path (`~`, relative to `base`).
#[tauri::command]
pub fn files_local_resolve(app: AppHandle, base: String, input: String) -> String {
    let home = app.path().home_dir().ok();
    localfs::resolve(&PathBuf::from(base), &input, home.as_deref())
        .to_string_lossy()
        .into_owned()
}

/// Home and the usual user folders that exist, then disks and volumes.
#[tauri::command]
pub async fn files_local_places(app: AppHandle) -> AppResult<Vec<LocalPlace>> {
    let resolver = app.path();
    let known: Vec<(&'static str, PathBuf)> = [
        ("home", resolver.home_dir()),
        ("desktop", resolver.desktop_dir()),
        ("documents", resolver.document_dir()),
        ("downloads", resolver.download_dir()),
        ("pictures", resolver.picture_dir()),
        ("videos", resolver.video_dir()),
        ("music", resolver.audio_dir()),
    ]
    .into_iter()
    .filter_map(|(key, dir)| dir.ok().map(|d| (key, d)))
    .collect();
    blocking(move || {
        let mut places: Vec<LocalPlace> = Vec::new();
        for (key, dir) in known {
            let path = dir.to_string_lossy().into_owned();
            if dir.is_dir() && !places.iter().any(|p| p.path == path) {
                places.push(LocalPlace {
                    key: key.into(),
                    label: dir
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_else(|| path.clone()),
                    path,
                });
            }
        }
        places.extend(localfs::volumes());
        Ok(places)
    })
    .await
}

/// A fresh, empty staging folder for one drag-out. The pull itself goes
/// through `files_pull` like any other download.
#[tauri::command]
pub async fn files_drag_stage(id: String) -> AppResult<String> {
    blocking(move || {
        localfs::create_stage(&localfs::stage_root(), &id, localfs::STAGE_MAX_AGE)
            .map(|p| p.to_string_lossy().into_owned())
    })
    .await
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DragOutcome {
    pub dropped: bool,
}

/// Fallback drag image when the UI sends none.
const DRAG_ICON: &[u8] = include_bytes!("../../icons/32x32.png");

/// Starts a native (OS) drag of local files, so they can be dropped onto
/// Finder, Explorer, the desktop or another app. Must be called while the
/// mouse button is still held; `on_event` reports how it ended.
#[tauri::command]
pub async fn files_start_drag(
    app: AppHandle,
    window: tauri::Window,
    paths: Vec<String>,
    icon: Option<String>,
    on_event: Channel<DragOutcome>,
) -> AppResult<()> {
    use base64::Engine;

    let files: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    if files.is_empty() {
        return Err(AppError::InvalidInput("nothing to drag".into()));
    }
    if let Some(bad) = files.iter().find(|p| !p.is_absolute() || !p.exists()) {
        return Err(AppError::InvalidInput(format!(
            "{} does not exist",
            bad.display()
        )));
    }
    let image = icon
        .as_deref()
        .and_then(|data| data.strip_prefix("data:image/png;base64,"))
        .and_then(|b64| base64::engine::general_purpose::STANDARD.decode(b64).ok())
        .unwrap_or_else(|| DRAG_ICON.to_vec());

    let (tx, rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let failed =
            |e: &dyn std::fmt::Display| AppError::Device(format!("could not start the drag: {e}"));
        #[cfg(any(
            target_os = "linux",
            target_os = "dragonfly",
            target_os = "freebsd",
            target_os = "openbsd",
            target_os = "netbsd"
        ))]
        let handle = window.gtk_window();
        #[cfg(not(any(
            target_os = "linux",
            target_os = "dragonfly",
            target_os = "freebsd",
            target_os = "openbsd",
            target_os = "netbsd"
        )))]
        let handle = tauri::Result::Ok(window);
        let result = match handle {
            Ok(handle) => drag::start_drag(
                &handle,
                drag::DragItem::Files(files),
                drag::Image::Raw(image),
                move |result, _cursor| {
                    let _ = on_event.send(DragOutcome {
                        dropped: matches!(result, drag::DragResult::Dropped),
                    });
                },
                drag::Options::default(),
            )
            .map_err(|e| failed(&e)),
            Err(e) => Err(failed(&e)),
        };
        let _ = tx.send(result);
    })
    .map_err(|e| AppError::Device(e.to_string()))?;
    rx.await
        .map_err(|_| AppError::Device("the drag did not start".into()))?
}
