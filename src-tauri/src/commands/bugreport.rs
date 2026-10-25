//! Bugreport: generate on the device, pull the zip, list past reports.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use crate::device::actions;
use crate::device::bugreport::{self, BugreportFile, ZipSummary};
use crate::device::captures;
use crate::error::{AppError, AppResult};
use crate::state::{AppState, lock};

/// Cancellation flags of running bugreports, by serial.
#[derive(Default)]
pub struct BugreportState {
    running: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum BugreportEvent {
    /// dumpstate progress in its own units (sections done / expected).
    Progress { done: u64, total: u64 },
    /// The zip is ready on the device and is being copied.
    Pulling { received: u64, total: Option<u64> },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BugreportResult {
    pub file: BugreportFile,
    pub summary: Option<ZipSummary>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BugreportList {
    pub dir: String,
    pub reports: Vec<BugreportFile>,
}

fn reports_dir(app: &AppHandle) -> AppResult<PathBuf> {
    let docs = app
        .path()
        .document_dir()
        .or_else(|_| app.path().home_dir())
        .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))?;
    Ok(docs.join("Tether").join("bugreports"))
}

#[tauri::command]
pub async fn create_bugreport(
    app: AppHandle,
    state: State<'_, AppState>,
    reports: State<'_, BugreportState>,
    serial: String,
    on_event: Channel<BugreportEvent>,
) -> AppResult<BugreportResult> {
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut running = lock(&reports.running);
        if running.contains_key(&serial) {
            return Err(AppError::InvalidInput(
                "a bugreport is already running for this device".into(),
            ));
        }
        running.insert(serial.clone(), cancel.clone());
    }
    let result = run(&app, &state, &serial, &cancel, &on_event).await;
    lock(&reports.running).remove(&serial);
    result
}

async fn run(
    app: &AppHandle,
    state: &AppState,
    serial: &str,
    cancel: &AtomicBool,
    on_event: &Channel<BugreportEvent>,
) -> AppResult<BugreportResult> {
    let server = state.server;
    let remote = bugreport::generate(&server, serial, cancel, |done, total| {
        let _ = on_event.send(BugreportEvent::Progress { done, total });
    })
    .await?;

    let dir = reports_dir(app)?;
    tokio::fs::create_dir_all(&dir).await?;
    let dest = bugreport::unique(&dir, &bugreport::local_name(&remote)?);
    actions::pull(
        &server,
        serial,
        &remote,
        &dest,
        cancel,
        |received, total| {
            let _ = on_event.send(BugreportEvent::Pulling { received, total });
        },
    )
    .await?;
    // The copy on the device only takes space now.
    let _ = server
        .exec(serial, &bugreport::cleanup_command(&remote))
        .await;

    let meta = tokio::fs::metadata(&dest).await?;
    let file = bugreport::describe(&dest, &meta);
    let summary = tokio::task::spawn_blocking(move || bugreport::summarize(&dest).ok())
        .await
        .ok()
        .flatten();
    Ok(BugreportResult { file, summary })
}

#[tauri::command]
pub fn cancel_bugreport(reports: State<'_, BugreportState>, serial: String) {
    if let Some(flag) = lock(&reports.running).get(&serial) {
        flag.store(true, Ordering::Relaxed);
    }
}

#[tauri::command]
pub async fn list_bugreports(app: AppHandle) -> AppResult<BugreportList> {
    let dir = reports_dir(&app)?;
    Ok(BugreportList {
        reports: bugreport::list(&dir).await?,
        dir: dir.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub async fn delete_bugreport(app: AppHandle, path: String) -> AppResult<()> {
    let dir = reports_dir(&app)?;
    let path = captures::contained(&dir, Path::new(&path))?;
    if path.extension().and_then(|e| e.to_str()) != Some("zip") {
        return Err(AppError::InvalidInput("not a bugreport".into()));
    }
    tokio::fs::remove_file(path).await?;
    Ok(())
}
