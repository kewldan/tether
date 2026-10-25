//! Copies installed APKs to the computer. A single APK becomes
//! `<pkg>-<version>.apk`; split apps become an `.apks` zip (stored) that
//! the installer here — and SAI / bundletool-style tools — can install back.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::{check_package, parse, quote, sh};
use crate::adb::server::AdbServer;
use crate::error::{AppError, AppResult};

const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum ExtractEvent {
    Progress {
        package: String,
        received: u64,
        total: u64,
    },
    Done {
        package: String,
        path: String,
    },
    Failed {
        package: String,
        message: String,
    },
}

/// File name for a package export: unsafe characters become `_`.
pub fn export_name(package: &str, version: Option<&str>, split: bool) -> String {
    let version: String = version
        .unwrap_or("")
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || "._-".contains(c) {
                c
            } else {
                '_'
            }
        })
        .collect();
    let ext = if split { "apks" } else { "apk" };
    if version.is_empty() {
        format!("{package}.{ext}")
    } else {
        format!("{package}-{version}.{ext}")
    }
}

/// Exports one package into `dest`, returning the written path.
pub async fn extract(
    server: &AdbServer,
    serial: &str,
    package: &str,
    dest: &Path,
    cancel: &AtomicBool,
    emit: &(impl Fn(ExtractEvent) + Sync),
) -> AppResult<PathBuf> {
    let package = check_package(package)?;
    let (paths, version) = tokio::join!(
        sh(server, serial, format!("pm path {package}")),
        sh(server, serial, format!("dumpsys package {package}")),
    );
    let apks: Vec<String> = paths?
        .lines()
        .filter_map(|l| l.trim().strip_prefix("package:").map(str::to_owned))
        .collect();
    if apks.is_empty() {
        return Err(AppError::Device(format!("{package} is not installed")));
    }
    let version_name = version
        .ok()
        .map(|v| parse::parse_dumpsys_package(&v))
        .and_then(|d| d.packages.into_iter().find(|p| p.name == package))
        .and_then(|p| p.version_name);

    let quoted: Vec<String> = apks.iter().map(|p| quote(p)).collect();
    let sizes = parse::parse_stat_sizes(
        &server
            .exec_text(
                serial,
                &format!("stat -c '%s %n' {} 2>/dev/null", quoted.join(" ")),
            )
            .await?,
    );
    let total: u64 = apks.iter().filter_map(|p| sizes.get(p)).sum();

    let split = apks.len() > 1;
    let target = dest.join(export_name(package, version_name.as_deref(), split));
    let partial = target.with_extension("part");
    let mut received = 0u64;
    let mut last = Instant::now();
    let mut report = |n: u64| {
        received += n;
        if last.elapsed() >= PROGRESS_INTERVAL || received == total {
            last = Instant::now();
            emit(ExtractEvent::Progress {
                package: package.to_owned(),
                received,
                total,
            });
        }
    };

    let result = if split {
        // Pull each APK, then pack them; APKs are already compressed.
        let tmp = tempdir_in(dest)?;
        let mut pulled = Vec::new();
        let mut outcome = Ok(());
        for apk in &apks {
            let name = apk.rsplit('/').next().unwrap_or("split.apk").to_owned();
            let local = tmp.join(&name);
            if let Err(e) = pull(server, serial, apk, &local, cancel, &mut report).await {
                outcome = Err(e);
                break;
            }
            pulled.push((name, local));
        }
        let outcome = match outcome {
            Ok(()) => {
                let partial = partial.clone();
                tokio::task::spawn_blocking(move || pack(&pulled, &partial))
                    .await
                    .map_err(|e| AppError::Device(e.to_string()))?
            }
            Err(e) => Err(e),
        };
        let _ = tokio::fs::remove_dir_all(&tmp).await;
        outcome
    } else {
        pull(server, serial, &apks[0], &partial, cancel, &mut report).await
    };

    if let Err(e) = result {
        let _ = tokio::fs::remove_file(&partial).await;
        return Err(e);
    }
    tokio::fs::rename(&partial, &target).await?;
    Ok(target)
}

fn tempdir_in(dest: &Path) -> AppResult<PathBuf> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = dest.join(format!(".tether-extract-{stamp}"));
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Streams a device file to `local` with `exec:cat`.
async fn pull(
    server: &AdbServer,
    serial: &str,
    remote: &str,
    local: &Path,
    cancel: &AtomicBool,
    report: &mut impl FnMut(u64),
) -> AppResult<()> {
    let mut stream = server
        .open_device(serial, &format!("exec:cat {}", quote(remote)))
        .await?;
    let mut file = tokio::fs::File::create(local).await?;
    let mut buf = vec![0u8; 256 * 1024];
    let mut first = true;
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(AppError::Cancelled);
        }
        let n = stream.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        // cat reports errors on stdout in exec mode; APKs start with "PK".
        if first && !buf[..n].starts_with(b"PK") {
            let text = String::from_utf8_lossy(&buf[..n.min(200)])
                .trim()
                .to_owned();
            return Err(AppError::Device(text));
        }
        first = false;
        file.write_all(&buf[..n]).await?;
        report(n as u64);
    }
    file.flush().await?;
    Ok(())
}

fn pack(files: &[(String, PathBuf)], out: &Path) -> AppResult<()> {
    let mut zip = zip::ZipWriter::new(std::fs::File::create(out)?);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Stored)
        .large_file(true);
    for (name, path) in files {
        zip.start_file(name.as_str(), options)
            .map_err(|e| AppError::Device(e.to_string()))?;
        let mut src = std::fs::File::open(path)?;
        std::io::copy(&mut src, &mut zip)?;
    }
    zip.finish().map_err(|e| AppError::Device(e.to_string()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_exports() {
        assert_eq!(
            export_name("com.x", Some("2.14.0"), false),
            "com.x-2.14.0.apk"
        );
        assert_eq!(
            export_name("com.x", Some("1.0 (beta)/2"), true),
            "com.x-1.0__beta__2.apks"
        );
        assert_eq!(export_name("com.x", None, false), "com.x.apk");
    }

    #[test]
    fn packs_stored_bundle() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("base.apk");
        std::fs::write(&a, b"PKbase").unwrap();
        let out = dir.path().join("x.apks");
        pack(&[("base.apk".into(), a)], &out).unwrap();
        let mut zip = zip::ZipArchive::new(std::fs::File::open(&out).unwrap()).unwrap();
        assert_eq!(zip.by_name("base.apk").unwrap().size(), 6);
    }
}
