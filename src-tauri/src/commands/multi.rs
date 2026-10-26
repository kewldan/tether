//! Multi-device grid: live thumbnails, "Screenshot all" into one folder
//! and a composed grid image. Shell commands, input, installs and
//! developer toggles reuse the per-device commands.

use std::path::{Path, PathBuf};
use std::time::Instant;

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::commands::overview::captures_root;
use crate::device::actions;
use crate::device::captures::{self, Capture};
use crate::device::thumbnail;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// Grid image height cap, px.
const COMPOSE_MAX_HEIGHT: u32 = 1600;
const COMPOSE_GAP: u32 = 32;
/// `--bg` of the dark theme.
const COMPOSE_BACKGROUND: [u8; 3] = [0x0d, 0x0e, 0x11];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Thumbnail {
    /// `data:image/png;base64,…` of the scaled screen.
    pub data_url: String,
    /// Real screen size in pixels (taps are mapped onto it).
    pub screen_width: u32,
    pub screen_height: u32,
}

/// One scaled-down `screencap`, at most `max_width` px wide.
#[tauri::command]
pub async fn multi_thumbnail(
    state: State<'_, AppState>,
    serial: String,
    max_width: u32,
) -> AppResult<Thumbnail> {
    let png = actions::screenshot(&state.server, &serial).await?;
    let max_width = max_width.clamp(64, 720);
    tauri::async_runtime::spawn_blocking(move || {
        let full = thumbnail::decode_png(&png)?;
        let small = thumbnail::fit(&full, max_width, max_width * 3);
        let encoded = thumbnail::encode_png(&small)?;
        Ok(Thumbnail {
            data_url: format!(
                "data:image/png;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(encoded)
            ),
            screen_width: full.width,
            screen_height: full.height,
        })
    })
    .await
    .map_err(|e| AppError::Device(e.to_string()))?
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShotTarget {
    pub serial: String,
    /// Display name, used as the file name.
    pub name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Shot {
    pub serial: String,
    pub capture: Option<Capture>,
    pub error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MultiCapture {
    /// The folder all screenshots went into.
    pub dir: String,
    pub shots: Vec<Shot>,
    /// From the first request to the last screenshot saved.
    pub elapsed_ms: u64,
}

/// Screenshots every device at once into `<captures>/Grid_<stamp>/`, one
/// `<device name>.png` each.
#[tauri::command]
pub async fn multi_screenshot(
    app: AppHandle,
    state: State<'_, AppState>,
    targets: Vec<ShotTarget>,
    stamp: String,
) -> AppResult<MultiCapture> {
    let stamp = captures::validate_stamp(&stamp)?.to_owned();
    if targets.is_empty() {
        return Err(AppError::InvalidInput("no devices selected".into()));
    }
    let root = captures_root(&app)?;
    let folder = format!("Grid_{stamp}");
    let started = Instant::now();
    let server = state.server;

    let tasks: Vec<_> = targets
        .into_iter()
        .map(|target| {
            let root = root.clone();
            let folder = folder.clone();
            tauri::async_runtime::spawn(async move {
                let result = async {
                    let png = actions::screenshot(&server, &target.serial).await?;
                    let stem = captures::sanitize_component(&target.name);
                    captures::save(&root, &folder, &stem, "png", &png).await
                }
                .await;
                match result {
                    Ok(capture) => Shot {
                        serial: target.serial,
                        capture: Some(capture),
                        error: None,
                    },
                    Err(e) => Shot {
                        serial: target.serial,
                        capture: None,
                        error: Some(e.to_string()),
                    },
                }
            })
        })
        .collect();

    let mut shots = Vec::with_capacity(tasks.len());
    for task in tasks {
        shots.push(task.await.map_err(|e| AppError::Device(e.to_string()))?);
    }
    Ok(MultiCapture {
        dir: root.join(&folder).display().to_string(),
        shots,
        elapsed_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
    })
}

/// Places saved screenshots side by side in `Grid.png` next to the first
/// one.
#[tauri::command]
pub async fn multi_compose(paths: Vec<String>) -> AppResult<Capture> {
    let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    let Some(dir) = paths
        .first()
        .and_then(|p| p.parent())
        .map(Path::to_path_buf)
    else {
        return Err(AppError::InvalidInput("no screenshots to compose".into()));
    };
    for p in &paths {
        let png = p.extension().is_some_and(|e| e.eq_ignore_ascii_case("png"));
        if !png || !p.is_file() {
            return Err(AppError::InvalidInput(format!(
                "not a screenshot: {}",
                p.display()
            )));
        }
    }
    let out = {
        let dir = dir.clone();
        tauri::async_runtime::spawn_blocking(move || -> AppResult<PathBuf> {
            let images = paths
                .iter()
                .map(|p| thumbnail::decode_png(&std::fs::read(p)?))
                .collect::<AppResult<Vec<_>>>()?;
            let grid = thumbnail::compose_row(
                &images,
                COMPOSE_MAX_HEIGHT,
                COMPOSE_GAP,
                COMPOSE_BACKGROUND,
            );
            let path = captures::unique_path(&dir, "Grid", "png");
            std::fs::write(&path, thumbnail::encode_png(&grid)?)?;
            Ok(path)
        })
        .await
        .map_err(|e| AppError::Device(e.to_string()))??
    };
    let folder = dir.file_name().map(|n| n.to_string_lossy().into_owned());
    captures::describe(&out, folder)
        .await
        .ok_or_else(|| AppError::Device("the grid image was not saved".into()))
}
