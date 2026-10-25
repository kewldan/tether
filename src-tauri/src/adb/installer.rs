//! Downloads Android platform-tools from Google into the app data directory.
//!
//! The binaries are never shipped with the app: the user accepts the SDK
//! license in the UI and the archive comes straight from `dl.google.com`.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::io::AsyncWriteExt;

use super::locator::ADB_EXE;
use crate::error::{AppError, AppResult};

const DOWNLOAD_DIR: &str = ".platform-tools-download";
const INSTALL_DIR: &str = "platform-tools";
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum InstallEvent {
    Downloading { downloaded: u64, total: Option<u64> },
    Extracting,
}

/// Official "latest" archive for the current OS, if Google publishes one.
/// The Linux build is x86_64 only.
pub fn download_url() -> AppResult<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", _) => {
            Ok("https://dl.google.com/android/repository/platform-tools-latest-darwin.zip")
        }
        ("windows", _) => {
            Ok("https://dl.google.com/android/repository/platform-tools-latest-windows.zip")
        }
        ("linux", "x86_64") => {
            Ok("https://dl.google.com/android/repository/platform-tools-latest-linux.zip")
        }
        (os, arch) => Err(AppError::UnsupportedPlatform(format!("{os} {arch}"))),
    }
}

/// Downloads and unpacks platform-tools into `<app_data>/platform-tools`,
/// replacing a previous copy. Returns the path to the adb executable.
pub async fn install(
    app_data: &Path,
    cancel: &AtomicBool,
    on_event: impl FnMut(InstallEvent),
) -> AppResult<PathBuf> {
    let url = download_url()?;
    let work_dir = app_data.join(DOWNLOAD_DIR);
    let result = install_into(url, app_data, &work_dir, cancel, on_event).await;
    let _ = tokio::fs::remove_dir_all(&work_dir).await;
    result
}

async fn install_into(
    url: &str,
    app_data: &Path,
    work_dir: &Path,
    cancel: &AtomicBool,
    mut on_event: impl FnMut(InstallEvent),
) -> AppResult<PathBuf> {
    let _ = tokio::fs::remove_dir_all(work_dir).await;
    tokio::fs::create_dir_all(work_dir).await?;

    let archive = work_dir.join("platform-tools.zip");
    download(url, &archive, cancel, &mut on_event).await?;

    on_event(InstallEvent::Extracting);
    let app_data = app_data.to_owned();
    let work_dir = work_dir.to_owned();
    tokio::task::spawn_blocking(move || unpack(&archive, &work_dir, &app_data))
        .await
        .map_err(|e| AppError::Extract(e.to_string()))?
}

async fn download(
    url: &str,
    dest: &Path,
    cancel: &AtomicBool,
    on_event: &mut impl FnMut(InstallEvent),
) -> AppResult<()> {
    let download_err = |e: reqwest::Error| AppError::Download(e.to_string());

    let mut response = reqwest::get(url)
        .await
        .and_then(|r| r.error_for_status())
        .map_err(download_err)?;
    let total = response.content_length();
    let mut file = tokio::fs::File::create(dest).await?;
    let mut downloaded = 0u64;
    let mut last_report = Instant::now();

    on_event(InstallEvent::Downloading { downloaded, total });
    while let Some(chunk) = response.chunk().await.map_err(download_err)? {
        if cancel.load(Ordering::Relaxed) {
            return Err(AppError::Cancelled);
        }
        file.write_all(&chunk).await?;
        downloaded += chunk.len() as u64;
        if last_report.elapsed() >= PROGRESS_INTERVAL {
            last_report = Instant::now();
            on_event(InstallEvent::Downloading { downloaded, total });
        }
    }
    file.flush().await?;
    on_event(InstallEvent::Downloading { downloaded, total });
    Ok(())
}

/// Extracts `archive` (which holds a top-level `platform-tools/` folder) into
/// `work_dir`, then swaps it into `<app_data>/platform-tools`.
fn unpack(archive: &Path, work_dir: &Path, app_data: &Path) -> AppResult<PathBuf> {
    let extract_err = |e: zip::result::ZipError| AppError::Extract(e.to_string());

    let unpacked = work_dir.join("unpacked");
    let file = std::fs::File::open(archive)?;
    // `extract` rejects entries escaping the target dir and restores unix
    // permissions, so adb stays executable.
    zip::ZipArchive::new(file)
        .and_then(|mut zip| zip.extract(&unpacked))
        .map_err(extract_err)?;

    let fresh = unpacked.join(INSTALL_DIR);
    if !fresh.join(ADB_EXE).is_file() {
        return Err(AppError::Extract(format!("{ADB_EXE} is missing")));
    }

    let target = app_data.join(INSTALL_DIR);
    let previous = work_dir.join("previous");
    if target.exists() {
        std::fs::rename(&target, &previous)?;
    }
    if let Err(e) = std::fs::rename(&fresh, &target) {
        if previous.exists() {
            let _ = std::fs::rename(&previous, &target);
        }
        return Err(e.into());
    }
    Ok(target.join(ADB_EXE))
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use zip::write::SimpleFileOptions;

    use super::*;

    fn write_archive(path: &Path, entries: &[(&str, &[u8])]) {
        let mut zip = zip::ZipWriter::new(std::fs::File::create(path).unwrap());
        let options = SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored)
            .unix_permissions(0o755);
        for (name, data) in entries {
            zip.start_file(*name, options).unwrap();
            zip.write_all(data).unwrap();
        }
        zip.finish().unwrap();
    }

    #[test]
    fn unpacks_and_replaces_previous_copy() {
        let root = tempfile::tempdir().unwrap();
        let app_data = root.path();
        let work_dir = app_data.join(DOWNLOAD_DIR);
        std::fs::create_dir_all(app_data.join("platform-tools")).unwrap();
        std::fs::write(app_data.join("platform-tools/stale"), b"old").unwrap();
        std::fs::create_dir_all(&work_dir).unwrap();

        let archive = work_dir.join("pt.zip");
        let adb_entry = format!("platform-tools/{ADB_EXE}");
        write_archive(
            &archive,
            &[
                (&adb_entry, b"#!/bin/sh\n"),
                ("platform-tools/NOTICE.txt", b"n"),
            ],
        );

        let adb = unpack(&archive, &work_dir, app_data).unwrap();
        assert_eq!(adb, app_data.join("platform-tools").join(ADB_EXE));
        assert!(adb.is_file());
        assert!(!app_data.join("platform-tools/stale").exists());

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&adb).unwrap().permissions().mode();
            assert_ne!(mode & 0o111, 0, "adb must stay executable");
        }
    }

    #[test]
    fn rejects_archive_without_adb_and_keeps_existing_copy() {
        let root = tempfile::tempdir().unwrap();
        let app_data = root.path();
        let work_dir = app_data.join(DOWNLOAD_DIR);
        std::fs::create_dir_all(app_data.join("platform-tools")).unwrap();
        std::fs::create_dir_all(&work_dir).unwrap();

        let archive = work_dir.join("pt.zip");
        write_archive(&archive, &[("platform-tools/fastboot", b"x")]);

        assert!(matches!(
            unpack(&archive, &work_dir, app_data),
            Err(AppError::Extract(_))
        ));
        assert!(app_data.join("platform-tools").is_dir());
    }

    #[test]
    fn rejects_corrupt_archive() {
        let root = tempfile::tempdir().unwrap();
        let archive = root.path().join("pt.zip");
        std::fs::write(&archive, b"not a zip").unwrap();

        assert!(matches!(
            unpack(&archive, root.path(), root.path()),
            Err(AppError::Extract(_))
        ));
    }
}
