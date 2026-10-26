//! Captures gallery: local screenshots and recordings.

use std::path::Path;

use serde::Serialize;
use tauri::AppHandle;
use tauri::ipc::{InvokeBody, Request, Response};

use crate::commands::overview::captures_root;
use crate::device::captures::{self, Capture};
use crate::error::{AppError, AppResult};

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

/// Raw bytes of a screenshot, so the annotation canvas can read its pixels
/// (an asset-protocol image would taint the canvas).
#[tauri::command]
pub async fn read_capture(app: AppHandle, path: String) -> AppResult<Response> {
    let root = captures_root(&app)?;
    Ok(Response::new(
        captures::read(&root, Path::new(&path)).await?,
    ))
}

/// Saves an annotated screenshot. The body is the PNG; headers carry the
/// original's path (`x-path`, URI-encoded) and `x-overwrite: 1` to replace
/// the original instead of writing `<name>_annotated.png` next to it.
#[tauri::command]
pub async fn save_annotated(app: AppHandle, request: Request<'_>) -> AppResult<Capture> {
    let InvokeBody::Raw(png) = request.body() else {
        return Err(AppError::InvalidInput("expected PNG bytes".into()));
    };
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned)
    };
    let path = header("x-path")
        .map(|p| percent_decode(&p))
        .transpose()?
        .ok_or_else(|| AppError::InvalidInput("missing x-path".into()))?;
    let overwrite = header("x-overwrite").as_deref() == Some("1");
    let root = captures_root(&app)?;
    captures::save_annotated(&root, Path::new(&path), png, overwrite).await
}

/// Decodes `encodeURIComponent` output (header values must be ASCII).
fn percent_decode(text: &str) -> AppResult<String> {
    let bad = || AppError::InvalidInput(format!("bad encoded path {text:?}"));
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = text.get(i + 1..i + 3).ok_or_else(bad)?;
            out.push(u8::from_str_radix(hex, 16).map_err(|_| bad())?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| bad())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_uri_components() {
        assert_eq!(
            percent_decode("%2FUsers%2Fme%2FPictures%2FTether%2F%D0%A2%D0%B5%D1%81%D1%82%20A.png")
                .unwrap(),
            "/Users/me/Pictures/Tether/Тест A.png"
        );
        assert_eq!(percent_decode("C%3A%5Cx.png").unwrap(), "C:\\x.png");
        assert!(percent_decode("%zz").is_err());
        assert!(percent_decode("%2").is_err());
    }
}
