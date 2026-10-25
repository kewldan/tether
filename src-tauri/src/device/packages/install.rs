//! Streaming installs through package installer sessions, the same way
//! `adb install-multiple` does: `install-create`, one `install-write -S
//! <size> <session> <name> -` per APK with the bytes on stdin, then
//! `install-commit`. Works for single APKs and split sets alike.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;

use super::actions;
use crate::adb::server::AdbServer;
use crate::device::apk::file::{self, ApkPart, PackageFile};
use crate::device::packages::{check_package, quote};
use crate::error::{AppError, AppResult};

const CHUNK: usize = 256 * 1024;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallOptions {
    /// `-r`: replace an existing app, keeping its data.
    pub reinstall: bool,
    /// `-d`: allow a lower versionCode (debuggable builds or userdebug).
    pub downgrade: bool,
    /// `-g`: grant all runtime permissions.
    pub grant_all: bool,
    /// `-t`: allow `android:testOnly` packages.
    pub test_only: bool,
    /// `--bypass-low-target-sdk-block` (Android 14+).
    pub bypass_low_target_sdk: bool,
    /// Start the launcher activity afterwards.
    pub launch: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Stage {
    Preparing,
    Uploading,
    Committing,
    Launching,
}

/// Install failure: the `INSTALL_FAILED_*` code (the frontend maps it to a
/// human message and an action) and the raw output for "Details".
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallFailure {
    pub code: Option<String>,
    pub message: String,
    pub raw: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum InstallEvent {
    Stage {
        serial: String,
        stage: Stage,
    },
    Progress {
        serial: String,
        sent: u64,
        total: u64,
    },
    Done {
        serial: String,
        elapsed_ms: u64,
    },
    Failed {
        serial: String,
        error: InstallFailure,
    },
    Cancelled {
        serial: String,
    },
}

impl InstallFailure {
    fn plain(message: impl Into<String>) -> Self {
        let message = message.into();
        Self {
            code: None,
            raw: message.clone(),
            message,
        }
    }
}

impl From<AppError> for InstallFailure {
    fn from(e: AppError) -> Self {
        Self::plain(e.to_string())
    }
}

/// Parses `Failure [INSTALL_FAILED_VERSION_DOWNGRADE: Downgrade detected…]`,
/// `Error: …`, or an exception from `install-create` / `install-commit`.
pub fn parse_failure(output: &str) -> InstallFailure {
    let raw = output.trim().to_owned();
    let mut code = None;
    let mut message = raw.lines().next().unwrap_or("").trim().to_owned();
    if let Some(start) = raw.find("Failure [") {
        let inner = &raw[start + "Failure [".len()..];
        let inner = inner.rsplit_once(']').map_or(inner, |(a, _)| a);
        let (c, detail) = inner.split_once(':').unwrap_or((inner, ""));
        code = Some(c.trim().to_owned());
        message = detail.trim().to_owned();
    } else if let Some(c) = find_code(&raw) {
        code = Some(c);
    }
    if message.is_empty() {
        message.clone_from(&raw);
    }
    InstallFailure { code, message, raw }
}

/// Finds a bare `INSTALL_…` / `INSTALL_PARSE_FAILED_…` token anywhere.
fn find_code(text: &str) -> Option<String> {
    let at = text.find("INSTALL_")?;
    let code: String = text[at..]
        .chars()
        .take_while(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || *c == '_')
        .collect();
    (code.len() > "INSTALL_".len()).then_some(code)
}

/// `Success: created install session [1234]` → 1234.
pub fn parse_session(output: &str) -> Option<u32> {
    let start = output.find('[')? + 1;
    let end = start + output[start..].find(']')?;
    output[start..end].trim().parse().ok()
}

/// ABI tokens used in split names (`config.arm64_v8a`, `base-x86_64.apk`).
const ABIS: [&str; 7] = [
    "arm64_v8a",
    "armeabi_v7a",
    "armeabi",
    "x86_64",
    "x86",
    "mips64",
    "mips",
];

/// Drops ABI splits the device cannot run; density and language splits are
/// all kept (the installer accepts them and picks what it needs).
pub fn select_parts<'a>(parts: &'a [ApkPart], abilist: &str) -> Vec<&'a ApkPart> {
    let device: Vec<String> = abilist
        .split(',')
        .map(|a| a.trim().replace('-', "_"))
        .filter(|a| !a.is_empty())
        .collect();
    if device.is_empty() {
        return parts.iter().collect();
    }
    let abi_of = |part: &ApkPart| -> Option<&'static str> {
        let name = part
            .split
            .as_deref()
            .or(part.entry.as_deref())
            .unwrap_or_default();
        let name: String = name
            .to_ascii_lowercase()
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
            .collect();
        let padded = format!("_{name}_");
        // ABIS lists longer names first (x86_64 before x86).
        ABIS.iter()
            .copied()
            .find(|abi| padded.contains(&format!("_{abi}_")))
    };
    let has_matching = parts
        .iter()
        .any(|p| abi_of(p).is_some_and(|abi| device.iter().any(|d| d == abi)));
    parts
        .iter()
        .filter(|p| match abi_of(p) {
            None => true,
            Some(abi) => !has_matching || device.iter().any(|d| d == abi),
        })
        .collect()
}

/// Installs `pkg` (already inspected) onto one device. Reports through
/// `emit`; returns when the install finished, failed or was cancelled.
pub async fn install_on(
    server: AdbServer,
    serial: String,
    pkg: Arc<PackageFile>,
    options: InstallOptions,
    cancel: Arc<AtomicBool>,
    emit: impl Fn(InstallEvent) + Send + Sync,
) {
    let started = Instant::now();
    emit(InstallEvent::Stage {
        serial: serial.clone(),
        stage: Stage::Preparing,
    });
    let result = run_install(&server, &serial, &pkg, options, &cancel, &emit).await;
    let event = match result {
        Ok(()) => InstallEvent::Done {
            serial,
            elapsed_ms: started.elapsed().as_millis() as u64,
        },
        Err(Outcome::Cancelled) => InstallEvent::Cancelled { serial },
        Err(Outcome::Failed(error)) => InstallEvent::Failed { serial, error },
    };
    emit(event);
}

enum Outcome {
    Cancelled,
    Failed(InstallFailure),
}

impl From<AppError> for Outcome {
    fn from(e: AppError) -> Self {
        match e {
            AppError::Cancelled => Self::Cancelled,
            other => Self::Failed(other.into()),
        }
    }
}

async fn run_install(
    server: &AdbServer,
    serial: &str,
    pkg: &PackageFile,
    options: InstallOptions,
    cancel: &AtomicBool,
    emit: &(impl Fn(InstallEvent) + Send + Sync),
) -> Result<(), Outcome> {
    let props = server
        .exec_text(
            serial,
            "getprop ro.build.version.sdk; getprop ro.product.cpu.abilist",
        )
        .await?;
    let mut lines = props.lines();
    let sdk: u32 = lines
        .next()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0);
    let abilist = lines.next().unwrap_or("").trim().to_owned();
    if let Some(min) = pkg.min_sdk
        && sdk != 0
        && sdk < min
    {
        return Err(Outcome::Failed(InstallFailure {
            code: Some("INSTALL_FAILED_OLDER_SDK".into()),
            message: format!("Requires API {min}, device has API {sdk}"),
            raw: String::new(),
        }));
    }
    // `cmd` is much faster than the `pm` script but needs Android 7.
    let pm = if sdk >= 24 { "cmd package" } else { "pm" };
    let parts = select_parts(&pkg.parts, &abilist);
    let total: u64 = parts.iter().map(|p| p.size).sum();

    let mut flags = String::new();
    for (on, flag) in [
        (options.reinstall, " -r"),
        (options.downgrade, " -d"),
        (options.grant_all && sdk >= 23, " -g"),
        (options.test_only, " -t"),
        (
            options.bypass_low_target_sdk && sdk >= 34,
            " --bypass-low-target-sdk-block",
        ),
    ] {
        if on {
            flags.push_str(flag);
        }
    }
    let created = server
        .exec_text(
            serial,
            &format!("{pm} install-create{flags} -S {total} 2>&1"),
        )
        .await?;
    let session =
        parse_session(&created).ok_or_else(|| Outcome::Failed(parse_failure(&created)))?;

    let abandon = || async {
        let _ = server
            .exec_text(serial, &format!("{pm} install-abandon {session}"))
            .await;
    };

    emit(InstallEvent::Stage {
        serial: serial.to_owned(),
        stage: Stage::Uploading,
    });
    let path = PathBuf::from(&pkg.path);
    let mut sent = 0u64;
    for (index, part) in parts.iter().enumerate() {
        let name = match &part.split {
            Some(split) => format!("{index}_{split}.apk"),
            None => format!("{index}_base.apk"),
        };
        let name: String = name
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || "._-".contains(c) {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        let result = write_part(
            server,
            serial,
            pm,
            session,
            &name,
            &path,
            part,
            cancel,
            |n| {
                sent += n;
                emit(InstallEvent::Progress {
                    serial: serial.to_owned(),
                    sent,
                    total,
                });
            },
        )
        .await;
        if let Err(e) = result {
            abandon().await;
            return Err(e);
        }
    }
    if cancel.load(Ordering::Relaxed) {
        abandon().await;
        return Err(Outcome::Cancelled);
    }

    emit(InstallEvent::Stage {
        serial: serial.to_owned(),
        stage: Stage::Committing,
    });
    let committed = server
        .exec_text(serial, &format!("{pm} install-commit {session} 2>&1"))
        .await?;
    if !committed.lines().any(|l| l.trim().starts_with("Success")) {
        return Err(Outcome::Failed(parse_failure(&committed)));
    }

    if !pkg.obbs.is_empty() {
        push_obbs(server, serial, pkg, cancel).await?;
    }
    if options.launch {
        emit(InstallEvent::Stage {
            serial: serial.to_owned(),
            stage: Stage::Launching,
        });
        // The app is installed either way; a missing launcher is not fatal.
        let _ = actions::launch(server, serial, &pkg.package).await;
    }
    Ok(())
}

/// Streams one APK into the session. File reading runs on a blocking
/// thread (zip entries are synchronous readers) and feeds the socket.
#[allow(clippy::too_many_arguments)]
async fn write_part(
    server: &AdbServer,
    serial: &str,
    pm: &str,
    session: u32,
    name: &str,
    path: &Path,
    part: &ApkPart,
    cancel: &AtomicBool,
    mut on_sent: impl FnMut(u64),
) -> Result<(), Outcome> {
    let command = format!(
        "exec:{pm} install-write -S {} {session} {name} -",
        part.size
    );
    let mut stream = server.open_device(serial, &command).await?;
    stream_file(
        path,
        part.entry.as_deref(),
        part.size,
        &mut stream,
        cancel,
        &mut on_sent,
    )
    .await?;

    let mut out = Vec::new();
    stream.read_to_end(&mut out).await.map_err(AppError::from)?;
    let out = String::from_utf8_lossy(&out);
    if out.contains("Success") {
        Ok(())
    } else {
        Err(Outcome::Failed(parse_failure(&out)))
    }
}

/// Copies `size` bytes of a file (or bundle entry) into an async writer,
/// reporting progress at most every [`PROGRESS_INTERVAL`].
async fn stream_file<W: AsyncWriteExt + Unpin>(
    path: &Path,
    entry: Option<&str>,
    size: u64,
    out: &mut W,
    cancel: &AtomicBool,
    on_sent: &mut impl FnMut(u64),
) -> Result<(), Outcome> {
    let (tx, mut rx) = mpsc::channel::<std::io::Result<Vec<u8>>>(4);
    let path = path.to_owned();
    let entry = entry.map(str::to_owned);
    let reader = tokio::task::spawn_blocking(move || {
        use std::io::Read;
        let mut source = match file::open_part(&path, entry.as_deref()) {
            Ok(s) => s,
            Err(e) => {
                let _ = tx.blocking_send(Err(std::io::Error::other(e.to_string())));
                return;
            }
        };
        loop {
            let mut buf = vec![0u8; CHUNK];
            match source.read(&mut buf) {
                Ok(0) => return,
                Ok(n) => {
                    buf.truncate(n);
                    if tx.blocking_send(Ok(buf)).is_err() {
                        return;
                    }
                }
                Err(e) => {
                    let _ = tx.blocking_send(Err(e));
                    return;
                }
            }
        }
    });

    let mut written = 0u64;
    let mut pending = 0u64;
    let mut last = Instant::now();
    while let Some(chunk) = rx.recv().await {
        if cancel.load(Ordering::Relaxed) {
            drop(rx);
            let _ = reader.await;
            return Err(Outcome::Cancelled);
        }
        let chunk = chunk.map_err(AppError::from)?;
        out.write_all(&chunk).await.map_err(AppError::from)?;
        written += chunk.len() as u64;
        pending += chunk.len() as u64;
        if last.elapsed() >= PROGRESS_INTERVAL {
            on_sent(pending);
            pending = 0;
            last = Instant::now();
        }
    }
    if pending > 0 {
        on_sent(pending);
    }
    let _ = reader.await;
    if written != size {
        return Err(Outcome::Failed(InstallFailure::plain(format!(
            "read {written} of {size} bytes from the package file"
        ))));
    }
    out.flush().await.map_err(AppError::from)?;
    Ok(())
}

/// Copies `.xapk` OBB files to `/sdcard/Android/obb/<pkg>/`.
async fn push_obbs(
    server: &AdbServer,
    serial: &str,
    pkg: &PackageFile,
    cancel: &AtomicBool,
) -> Result<(), Outcome> {
    let package = check_package(&pkg.package)?;
    let path = PathBuf::from(&pkg.path);
    for obb in &pkg.obbs {
        let Some(name) = obb.entry.rsplit('/').next().filter(|n| !n.is_empty()) else {
            continue;
        };
        let dir = format!("/sdcard/Android/obb/{package}");
        let target = quote(&format!("{dir}/{name}"));
        // `head -c` stops after exactly `size` bytes, so no EOF is needed.
        let command = format!("exec:mkdir -p {dir} && head -c {} > {target}", obb.size);
        let mut stream = server.open_device(serial, &command).await?;
        stream_file(
            &path,
            Some(&obb.entry),
            obb.size,
            &mut stream,
            cancel,
            &mut |_| {},
        )
        .await?;
        let mut sink = Vec::new();
        let _ = stream.read_to_end(&mut sink).await;
    }
    Ok(())
}

/// Version installed on a device, for the "Installed 2.14.0 → upgrade" line.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledVersion {
    pub version_name: Option<String>,
    pub version_code: u64,
    pub debuggable: bool,
}

pub async fn installed_version(
    server: &AdbServer,
    serial: &str,
    package: &str,
) -> AppResult<Option<InstalledVersion>> {
    let package = check_package(package)?;
    let out = server
        .exec_text(serial, &format!("dumpsys package {package}"))
        .await?;
    let dump = super::parse::parse_dumpsys_package(&out);
    Ok(dump
        .packages
        .into_iter()
        .find(|p| p.name == package && p.user(0).is_none_or(|u| u.installed))
        .map(|p| InstalledVersion {
            debuggable: p.has_flag("DEBUGGABLE"),
            version_name: p.version_name,
            version_code: p.version_code.unwrap_or(0),
        }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_install_failures() {
        let f = parse_failure(
            "Failure [INSTALL_FAILED_VERSION_DOWNGRADE: Downgrade detected: Update version code 2150 is older than current 2162]\n",
        );
        assert_eq!(f.code.as_deref(), Some("INSTALL_FAILED_VERSION_DOWNGRADE"));
        assert_eq!(
            f.message,
            "Downgrade detected: Update version code 2150 is older than current 2162"
        );

        let f = parse_failure(
            "Failure [INSTALL_PARSE_FAILED_NO_CERTIFICATES: Failed to collect certificates from /data/app/vmdl1.tmp/0_base.apk: Attempt to get length of null array]",
        );
        assert_eq!(
            f.code.as_deref(),
            Some("INSTALL_PARSE_FAILED_NO_CERTIFICATES")
        );

        let f = parse_failure("Failure [INSTALL_FAILED_TEST_ONLY]");
        assert_eq!(f.code.as_deref(), Some("INSTALL_FAILED_TEST_ONLY"));
        assert_eq!(f.message, "Failure [INSTALL_FAILED_TEST_ONLY]");

        let f = parse_failure(
            "Error: java.lang.IllegalArgumentException: INSTALL_FAILED_INSUFFICIENT_STORAGE",
        );
        assert_eq!(
            f.code.as_deref(),
            Some("INSTALL_FAILED_INSUFFICIENT_STORAGE")
        );

        let f = parse_failure("cmd: Can't find service: package\n");
        assert_eq!(f.code, None);
        assert_eq!(f.message, "cmd: Can't find service: package");
    }

    #[test]
    fn parses_session_ids() {
        assert_eq!(
            parse_session("Success: created install session [1840364713]\n"),
            Some(1_840_364_713)
        );
        assert_eq!(parse_session("Error: …"), None);
    }

    fn part(split: Option<&str>) -> ApkPart {
        ApkPart {
            entry: None,
            split: split.map(str::to_owned),
            size: 1,
        }
    }

    #[test]
    fn keeps_only_matching_abi_splits() {
        let parts = [
            part(None),
            part(Some("config.arm64_v8a")),
            part(Some("config.armeabi_v7a")),
            part(Some("config.x86_64")),
            part(Some("config.xxhdpi")),
            part(Some("config.en")),
        ];
        let names = |abilist: &str| -> Vec<Option<String>> {
            select_parts(&parts, abilist)
                .iter()
                .map(|p| p.split.clone())
                .collect()
        };
        assert_eq!(
            names("arm64-v8a,armeabi-v7a,armeabi"),
            [
                None,
                Some("config.arm64_v8a".into()),
                Some("config.armeabi_v7a".into()),
                Some("config.xxhdpi".into()),
                Some("config.en".into()),
            ]
        );
        assert_eq!(
            names("x86_64,x86"),
            [
                None,
                Some("config.x86_64".into()),
                Some("config.xxhdpi".into()),
                Some("config.en".into())
            ]
        );
        // No device info: install everything.
        assert_eq!(names("").len(), parts.len());
    }
}
