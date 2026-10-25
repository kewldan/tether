//! Captures gallery: local screenshots and recordings.

use std::path::Path;

use serde::Serialize;
use tauri::AppHandle;

use crate::commands::overview::captures_root;
use crate::device::captures::{self, Capture};
use crate::error::AppResult;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureList {
    pub dir: String,
    pub captures: Vec<Capture>,
}

#[tauri::command]
pub async fn list_captures(app: AppHandle) -> AppResult<CaptureList> {
    let root = captures_root(&app)?;
    Ok(CaptureList {
        captures: captures::list(&root).await?,
        dir: root.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub async fn delete_capture(app: AppHandle, path: String) -> AppResult<()> {
    let root = captures_root(&app)?;
    captures::delete(&root, Path::new(&path)).await
}
