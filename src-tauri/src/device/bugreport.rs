//! Bugreports via `bugreportz -p` (Android 7+).
//!
//! `bugreportz -p` prints `BEGIN:<path>`, then `PROGRESS:<done>/<total>`
//! lines and finally `OK:<path>` or `FAIL:<reason>`. The device keeps
//! printing progress after `OK:`, so the stream is read until it closes.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, UNIX_EPOCH};

use serde::Serialize;
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::adb::server::AdbServer;
use crate::device::actions::shell_quote;
use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Line {
    Begin(String),
    Progress { done: u64, total: u64 },
    Ok(String),
    Fail(String),
    Other(String),
}

pub fn parse_line(line: &str) -> Line {
    let line = line.trim();
    if let Some(path) = line.strip_prefix("BEGIN:") {
        Line::Begin(path.to_owned())
    } else if let Some(path) = line.strip_prefix("OK:") {
        Line::Ok(path.to_owned())
    } else if let Some(reason) = line.strip_prefix("FAIL:") {
        Line::Fail(reason.to_owned())
    } else if let Some(progress) = line.strip_prefix("PROGRESS:") {
        progress
            .split_once('/')
            .and_then(|(d, t)| {
                Some(Line::Progress {
                    done: d.trim().parse().ok()?,
                    total: t.trim().parse().ok()?,
                })
            })
            .unwrap_or_else(|| Line::Other(line.to_owned()))
    } else {
        Line::Other(line.to_owned())
    }
}

/// Runs `bugreportz -p` and returns the device path of the finished zip.
/// `progress(done, total)` is called for every progress line.
pub async fn generate(
    server: &AdbServer,
    serial: &str,
    cancel: &AtomicBool,
    mut progress: impl FnMut(u64, u64),
) -> AppResult<String> {
    let stream = server.open_device(serial, "exec:bugreportz -p").await?;
    let mut lines = BufReader::new(stream).lines();
    let mut result: Option<String> = None;
    let mut other = Vec::new();
    loop {
        if cancel.load(Ordering::Relaxed) {
            // Dropping the stream kills bugreportz; dumpstate may still
            // finish in the background on the device.
            return Err(AppError::Cancelled);
        }
        // `next_line` is cancel safe, so polling with a timeout loses
        // nothing and lets us notice cancellation promptly.
        let line = match tokio::time::timeout(Duration::from_millis(250), lines.next_line()).await {
            Err(_) => continue,
            Ok(line) => line?,
        };
        let Some(line) = line else { break };
        match parse_line(&line) {
            Line::Progress { done, total } => progress(done, total),
            Line::Ok(path) => result = Some(path),
            Line::Fail(reason) => return Err(AppError::Device(reason)),
            Line::Begin(_) => {}
            Line::Other(text) if !text.is_empty() => other.push(text),
            Line::Other(_) => {}
        }
    }
    result.ok_or_else(|| {
        let detail = other.join("\n");
        AppError::Device(if detail.is_empty() {
            "bugreportz ended without a result".into()
        } else {
            detail
        })
    })
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZipSummary {
    pub anr_traces: u32,
    pub tombstones: u32,
}

/// Counts ANR traces and tombstones inside a bugreport zip.
pub fn summarize(path: &Path) -> AppResult<ZipSummary> {
    let file = std::fs::File::open(path)?;
    let archive =
        zip::ZipArchive::new(file).map_err(|e| AppError::Device(format!("bad zip: {e}")))?;
    let mut summary = ZipSummary::default();
    for name in archive.file_names() {
        let Ok(name) = name else { continue };
        if name.ends_with('/') {
            continue;
        }
        if let Some(file) = name.strip_prefix("FS/data/anr/") {
            if !file.is_empty() && !file.contains('/') {
                summary.anr_traces += 1;
            }
        } else if let Some(file) = name.strip_prefix("FS/data/tombstones/")
            && file.starts_with("tombstone_")
            && !file.ends_with(".pb")
        {
            summary.tombstones += 1;
        }
    }
    Ok(summary)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BugreportFile {
    pub path: String,
    pub name: String,
    /// Product name from the file name (`bugreport-<product>-<build>-…`).
    pub device: Option<String>,
    pub size_bytes: u64,
    pub modified: u64,
}

/// `bugreport-husky-AP4A.261005.002-2026-10-25-22-12-05.zip` → `husky`.
pub fn device_from_name(name: &str) -> Option<String> {
    let stem = name.strip_prefix("bugreport-")?.strip_suffix(".zip")?;
    // Drop the trailing `YYYY-MM-DD-HH-MM-SS` (19 chars) and its dash.
    let head = stem.get(..stem.len().checked_sub(20)?)?;
    let (device, _build) = head.rsplit_once('-')?;
    (!device.is_empty()).then(|| device.to_owned())
}

/// Zip files in `dir`, newest first. A missing folder is an empty list.
pub async fn list(dir: &Path) -> AppResult<Vec<BugreportFile>> {
    let mut out = Vec::new();
    let mut entries = match tokio::fs::read_dir(dir).await {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
        Err(e) => return Err(e.into()),
    };
    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("zip") {
            continue;
        }
        let Ok(meta) = entry.metadata().await else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        out.push(describe(&path, &meta));
    }
    out.sort_by_key(|b| std::cmp::Reverse(b.modified));
    Ok(out)
}

pub fn describe(path: &Path, meta: &std::fs::Metadata) -> BugreportFile {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    BugreportFile {
        path: path.to_string_lossy().into_owned(),
        device: device_from_name(&name),
        name,
        size_bytes: meta.len(),
        modified: meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
    }
}

/// Local file name for a remote bugreport path.
pub fn local_name(remote: &str) -> AppResult<String> {
    let name = remote.rsplit('/').next().unwrap_or_default();
    let safe = !name.is_empty()
        && name.ends_with(".zip")
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if safe {
        Ok(name.to_owned())
    } else {
        Err(AppError::Device(format!(
            "unexpected bugreport path {remote}"
        )))
    }
}

/// Removes the zip and dumpstate's log next to it from the device.
pub fn cleanup_command(remote: &str) -> String {
    let stem = remote.strip_suffix(".zip").unwrap_or(remote);
    format!(
        "rm -f {} {}-dumpstate_log-*.txt",
        shell_quote(remote),
        shell_quote(stem)
    )
}

pub fn unique(dir: &Path, name: &str) -> PathBuf {
    let stem = name.strip_suffix(".zip").unwrap_or(name);
    crate::device::captures::unique_path(dir, stem, "zip")
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use super::*;

    // `bugreportz -p` on the Android 16 emulator.
    const OUTPUT: &str = include_str!("testdata/emu36/bugreportz_p.txt");

    #[test]
    fn parses_progress_stream() {
        let lines: Vec<Line> = OUTPUT.lines().map(parse_line).collect();
        assert_eq!(
            lines[0],
            Line::Progress {
                done: 20,
                total: 1825
            }
        );
        assert!(matches!(&lines[1], Line::Begin(p) if p.ends_with("-2026-10-25-23-46-58.zip")));
        let ok = lines.iter().position(|l| matches!(l, Line::Ok(_))).unwrap();
        // Progress keeps coming after OK.
        assert!(ok < lines.len() - 1);
        assert_eq!(
            lines.last(),
            Some(&Line::Progress {
                done: 1825,
                total: 1825
            })
        );
    }

    #[test]
    fn parses_failure() {
        assert_eq!(
            parse_line("FAIL:Could not create zip file\r"),
            Line::Fail("Could not create zip file".into())
        );
        assert!(matches!(parse_line("PROGRESS:x/y"), Line::Other(_)));
    }

    #[test]
    fn device_and_local_names() {
        let remote = "/data/user_de/0/com.android.shell/files/bugreports/\
                      bugreport-sdk_gphone64_arm64-BE4B.251210.005-2026-10-25-23-46-58.zip";
        let name = local_name(remote).unwrap();
        assert_eq!(
            name,
            "bugreport-sdk_gphone64_arm64-BE4B.251210.005-2026-10-25-23-46-58.zip"
        );
        assert_eq!(
            device_from_name(&name).as_deref(),
            Some("sdk_gphone64_arm64")
        );
        assert_eq!(
            device_from_name("bugreport-husky-AP4A.261005.002-2026-10-25-22-12-05.zip").as_deref(),
            Some("husky")
        );
        assert_eq!(device_from_name("report.zip"), None);
        assert!(local_name("/x/../../etc/passwd").is_err());
    }

    #[test]
    fn cleanup_removes_zip_and_log() {
        assert_eq!(
            cleanup_command("/bugreports/bugreport-x-B-2026-10-25-23-56-39.zip"),
            "rm -f '/bugreports/bugreport-x-B-2026-10-25-23-56-39.zip' \
             '/bugreports/bugreport-x-B-2026-10-25-23-56-39'-dumpstate_log-*.txt"
        );
    }

    #[test]
    fn counts_anrs_and_tombstones() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("b.zip");
        let mut zip = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        // Entry names as found in an emulator bugreport.
        for name in [
            "version.txt",
            "FS/data/anr/anr_2026-10-23-16-44-13-049",
            "FS/data/tombstones/tombstone_17",
            "FS/data/tombstones/tombstone_17.pb",
            "FS/data/tombstones/tombstone_16",
        ] {
            zip.start_file(name, opts).unwrap();
            zip.write_all(b"x").unwrap();
        }
        zip.finish().unwrap();

        let s = summarize(&path).unwrap();
        assert_eq!(
            s,
            ZipSummary {
                anr_traces: 1,
                tombstones: 2
            }
        );
    }
}
