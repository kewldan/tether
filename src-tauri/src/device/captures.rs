//! Screenshots and screen recordings saved on the host.
//!
//! Layout: `<root>/<device name>/<file>` (root is `~/Pictures/Tether`), so
//! Finder shows one folder per device and the gallery can group by it.
//! Files placed directly in the root are listed without a device.

use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use tokio::io::AsyncReadExt;

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptureKind {
    Screenshot,
    Recording,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capture {
    pub path: String,
    pub name: String,
    pub device: Option<String>,
    pub kind: CaptureKind,
    pub size_bytes: u64,
    /// Modification time, ms since the Unix epoch.
    pub modified: u64,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

pub fn kind_of(path: &Path) -> Option<CaptureKind> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    match ext.as_str() {
        "png" | "jpg" | "jpeg" | "webp" => Some(CaptureKind::Screenshot),
        "mp4" | "webm" | "mkv" => Some(CaptureKind::Recording),
        _ => None,
    }
}

/// Makes a device name safe as a single path component on every OS.
pub fn sanitize_component(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    let mut out: String = trimmed.chars().take(64).collect();
    if out.is_empty() {
        out = "Device".into();
    }
    out
}

/// A timestamp like `2026-10-25_22-38-12` supplied by the UI (it knows the
/// user's local time). Only digits, `-` and `_` are accepted.
pub fn validate_stamp(stamp: &str) -> AppResult<&str> {
    let ok = !stamp.is_empty()
        && stamp.len() <= 32
        && stamp
            .chars()
            .all(|c| c.is_ascii_digit() || c == '-' || c == '_');
    if ok {
        Ok(stamp)
    } else {
        Err(AppError::InvalidInput(format!("bad timestamp {stamp:?}")))
    }
}

/// Width and height from a PNG's IHDR chunk.
pub fn png_size(header: &[u8]) -> Option<(u32, u32)> {
    const MAGIC: &[u8] = b"\x89PNG\r\n\x1a\n";
    if header.len() < 24 || !header.starts_with(MAGIC) || &header[12..16] != b"IHDR" {
        return None;
    }
    let w = u32::from_be_bytes(header[16..20].try_into().ok()?);
    let h = u32::from_be_bytes(header[20..24].try_into().ok()?);
    Some((w, h))
}

pub fn is_png(bytes: &[u8]) -> bool {
    png_size(bytes).is_some()
}

/// Picks `<dir>/<stem>.<ext>`, or `<stem>-2.<ext>`… if it already exists.
pub fn unique_path(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let mut candidate = dir.join(format!("{stem}.{ext}"));
    let mut n = 2;
    while candidate.exists() {
        candidate = dir.join(format!("{stem}-{n}.{ext}"));
        n += 1;
    }
    candidate
}

/// Directory for one device's captures, created on demand.
pub async fn device_dir(root: &Path, device_name: &str) -> AppResult<PathBuf> {
    let dir = root.join(sanitize_component(device_name));
    tokio::fs::create_dir_all(&dir).await?;
    Ok(dir)
}

/// Writes `bytes` as a new capture and describes it.
pub async fn save(
    root: &Path,
    device_name: &str,
    stem: &str,
    ext: &str,
    bytes: &[u8],
) -> AppResult<Capture> {
    let dir = device_dir(root, device_name).await?;
    let path = unique_path(&dir, stem, ext);
    tokio::fs::write(&path, bytes).await?;
    describe(&path, Some(sanitize_component(device_name)))
        .await
        .ok_or_else(|| AppError::Device("capture was not saved".into()))
}

/// Metadata of one capture file, `None` if it is not a capture.
pub async fn describe(path: &Path, device: Option<String>) -> Option<Capture> {
    let kind = kind_of(path)?;
    let meta = tokio::fs::metadata(path).await.ok()?;
    if !meta.is_file() {
        return None;
    }
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let (width, height) = if kind == CaptureKind::Screenshot {
        read_png_size(path)
            .await
            .map_or((None, None), |(w, h)| (Some(w), Some(h)))
    } else {
        (None, None)
    };
    Some(Capture {
        path: path.to_string_lossy().into_owned(),
        name: path.file_name()?.to_string_lossy().into_owned(),
        device,
        kind,
        size_bytes: meta.len(),
        modified,
        width,
        height,
    })
}

async fn read_png_size(path: &Path) -> Option<(u32, u32)> {
    let mut file = tokio::fs::File::open(path).await.ok()?;
    let mut header = [0u8; 24];
    file.read_exact(&mut header).await.ok()?;
    png_size(&header)
}

/// All captures under `root` (one level of device folders), newest first.
/// A missing root is an empty gallery.
pub async fn list(root: &Path) -> AppResult<Vec<Capture>> {
    let mut out = Vec::new();
    let mut entries = match tokio::fs::read_dir(root).await {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
        Err(e) => return Err(e.into()),
    };
    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();
        let file_type = entry.file_type().await?;
        if file_type.is_dir() {
            let device = entry.file_name().to_string_lossy().into_owned();
            if device.starts_with('.') {
                continue;
            }
            let mut inner = tokio::fs::read_dir(&path).await?;
            while let Some(file) = inner.next_entry().await? {
                if let Some(c) = describe(&file.path(), Some(device.clone())).await {
                    out.push(c);
                }
            }
        } else if let Some(c) = describe(&path, None).await {
            out.push(c);
        }
    }
    out.sort_by(|a, b| b.modified.cmp(&a.modified).then(a.name.cmp(&b.name)));
    Ok(out)
}

/// Resolves `path` and checks that it is a file inside `root`, so the UI
/// cannot be tricked into touching anything else.
pub fn contained(root: &Path, path: &Path) -> AppResult<PathBuf> {
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(AppError::InvalidInput("path escapes the folder".into()));
    }
    let root = std::fs::canonicalize(root)?;
    let path = std::fs::canonicalize(path)?;
    if !path.starts_with(&root) || path == root {
        return Err(AppError::InvalidInput(format!(
            "{} is outside {}",
            path.display(),
            root.display()
        )));
    }
    Ok(path)
}

/// Deletes one capture inside `root`.
pub async fn delete(root: &Path, path: &Path) -> AppResult<()> {
    let path = contained(root, path)?;
    if kind_of(&path).is_none() {
        return Err(AppError::InvalidInput("not a capture".into()));
    }
    tokio::fs::remove_file(path).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // First bytes of `screencap -p` from the Android 16 emulator
    // (1280 × 2856).
    const PNG_HEADER: &[u8] =
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR\x00\x00\x05\x00\x00\x00\x0b\x28";

    #[test]
    fn reads_png_size() {
        assert_eq!(png_size(PNG_HEADER), Some((1280, 2856)));
        assert_eq!(png_size(b"not a png at all, really......"), None);
    }

    #[test]
    fn sanitizes_device_names() {
        assert_eq!(sanitize_component("Pixel 8 Pro"), "Pixel 8 Pro");
        assert_eq!(
            sanitize_component("192.168.1.42:37115"),
            "192.168.1.42_37115"
        );
        assert_eq!(sanitize_component("../etc"), "_etc");
        assert_eq!(sanitize_component("  "), "Device");
    }

    #[test]
    fn validates_stamps() {
        assert!(validate_stamp("2026-10-25_22-38-12").is_ok());
        assert!(validate_stamp("../x").is_err());
        assert!(validate_stamp("").is_err());
    }

    #[tokio::test]
    async fn save_list_and_delete() {
        let root = tempfile::tempdir().unwrap();
        let mut png = PNG_HEADER.to_vec();
        png.extend_from_slice(&[0; 16]);

        let a = save(root.path(), "Pixel 8 Pro", "Screenshot_1", "png", &png)
            .await
            .unwrap();
        let b = save(root.path(), "Pixel 8 Pro", "Screenshot_1", "png", &png)
            .await
            .unwrap();
        assert_eq!(a.name, "Screenshot_1.png");
        assert_eq!(b.name, "Screenshot_1-2.png");
        assert_eq!(a.width, Some(1280));
        assert_eq!(a.device.as_deref(), Some("Pixel 8 Pro"));

        std::fs::write(root.path().join("clip.mp4"), b"....").unwrap();
        std::fs::write(root.path().join("notes.txt"), b"x").unwrap();

        let all = list(root.path()).await.unwrap();
        assert_eq!(all.len(), 3);
        let clip = all.iter().find(|c| c.name == "clip.mp4").unwrap();
        assert_eq!(clip.kind, CaptureKind::Recording);
        assert_eq!(clip.device, None);

        delete(root.path(), Path::new(&a.path)).await.unwrap();
        assert_eq!(list(root.path()).await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn refuses_paths_outside_root() {
        let root = tempfile::tempdir().unwrap();
        let other = tempfile::NamedTempFile::new().unwrap();
        assert!(delete(root.path(), other.path()).await.is_err());
        let sneaky = root.path().join("..").join("x.png");
        assert!(delete(root.path(), &sneaky).await.is_err());
    }

    #[tokio::test]
    async fn missing_root_is_empty() {
        let root = tempfile::tempdir().unwrap();
        let gone = root.path().join("nope");
        assert!(list(&gone).await.unwrap().is_empty());
    }
}
