//! Finds an existing adb executable on the machine.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tokio::process::Command;

#[cfg(windows)]
pub(crate) const ADB_EXE: &str = "adb.exe";
#[cfg(not(windows))]
pub(crate) const ADB_EXE: &str = "adb";

/// Where a candidate adb binary came from, in lookup priority order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AdbSource {
    Settings,
    Path,
    AndroidHome,
    KnownLocation,
    Bundled,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdbInstall {
    pub path: PathBuf,
    pub source: AdbSource,
    /// Platform-tools version, e.g. `37.0.1-15733141`.
    pub version: Option<String>,
}

/// Inputs for the lookup, captured from the process environment so tests can
/// supply their own.
#[derive(Debug, Default, Clone)]
pub struct LocatorEnv {
    pub settings_path: Option<PathBuf>,
    pub path_var: Option<OsString>,
    pub android_home: Option<PathBuf>,
    pub android_sdk_root: Option<PathBuf>,
    pub home: Option<PathBuf>,
    pub local_app_data: Option<PathBuf>,
    /// Directory where the app keeps its own downloaded platform-tools.
    pub app_data: Option<PathBuf>,
}

impl LocatorEnv {
    pub fn from_process(settings_path: Option<PathBuf>, app_data: Option<PathBuf>) -> Self {
        let var = |name| std::env::var_os(name).filter(|v| !v.is_empty());
        Self {
            settings_path,
            path_var: var("PATH"),
            android_home: var("ANDROID_HOME").map(PathBuf::from),
            android_sdk_root: var("ANDROID_SDK_ROOT").map(PathBuf::from),
            home: std::env::home_dir(),
            local_app_data: var("LOCALAPPDATA").map(PathBuf::from),
            app_data,
        }
    }
}

/// Lists every place adb may live, highest priority first. Duplicates are
/// kept; [`locate`] stops at the first existing one anyway.
pub fn candidates(env: &LocatorEnv) -> Vec<(PathBuf, AdbSource)> {
    let mut out = Vec::new();

    if let Some(p) = &env.settings_path {
        out.push((p.clone(), AdbSource::Settings));
    }
    if let Some(path_var) = &env.path_var {
        for dir in std::env::split_paths(path_var) {
            out.push((dir.join(ADB_EXE), AdbSource::Path));
        }
    }
    for sdk in [&env.android_home, &env.android_sdk_root]
        .into_iter()
        .flatten()
    {
        out.push((
            sdk.join("platform-tools").join(ADB_EXE),
            AdbSource::AndroidHome,
        ));
    }
    for dir in known_dirs(env) {
        out.push((dir.join(ADB_EXE), AdbSource::KnownLocation));
    }
    if let Some(app_data) = &env.app_data {
        out.push((
            app_data.join("platform-tools").join(ADB_EXE),
            AdbSource::Bundled,
        ));
    }
    out
}

fn known_dirs(env: &LocatorEnv) -> Vec<PathBuf> {
    known_locations(env)
        .into_iter()
        .map(|(_, dir)| dir)
        .collect()
}

/// OS-specific places adb usually lives, grouped by where it came from.
fn known_locations(env: &LocatorEnv) -> Vec<(CheckKind, PathBuf)> {
    let mut dirs = Vec::new();
    let home = env.home.as_deref();

    if cfg!(target_os = "macos") {
        if let Some(h) = home {
            dirs.push((
                CheckKind::StudioSdk,
                h.join("Library/Android/sdk/platform-tools"),
            ));
        }
        dirs.push((CheckKind::Homebrew, "/opt/homebrew/bin".into()));
        dirs.push((CheckKind::Homebrew, "/usr/local/bin".into()));
    } else if cfg!(windows) {
        if let Some(l) = &env.local_app_data {
            dirs.push((CheckKind::StudioSdk, l.join(r"Android\Sdk\platform-tools")));
            dirs.push((CheckKind::Winget, l.join(r"Microsoft\WinGet\Links")));
        }
        if let Some(h) = home {
            dirs.push((CheckKind::Scoop, h.join(r"scoop\shims")));
        }
    } else {
        if let Some(h) = home {
            dirs.push((CheckKind::StudioSdk, h.join("Android/Sdk/platform-tools")));
        }
        dirs.push((CheckKind::System, "/usr/bin".into()));
        dirs.push((CheckKind::System, "/usr/local/bin".into()));
    }
    dirs
}

/// A group of places shown as one row of the onboarding search list.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckKind {
    Settings,
    Path,
    AndroidHome,
    StudioSdk,
    Homebrew,
    Winget,
    Scoop,
    System,
    Bundled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckStatus {
    Found,
    Missing,
    /// The environment variable behind this group is not set.
    NotSet,
}

/// Result of looking for adb in one group of places.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocationCheck {
    pub kind: CheckKind,
    pub source: AdbSource,
    /// Every adb path that was tried, in order.
    pub paths: Vec<PathBuf>,
    pub found: Option<PathBuf>,
    pub status: CheckStatus,
}

/// Checks every group of places in priority order, without stopping at the
/// first hit, so the onboarding screen can show where it looked.
pub fn scan(env: &LocatorEnv) -> Vec<LocationCheck> {
    let mut groups: Vec<(CheckKind, AdbSource, Vec<PathBuf>, bool)> = Vec::new();

    if let Some(p) = &env.settings_path {
        groups.push((
            CheckKind::Settings,
            AdbSource::Settings,
            vec![p.clone()],
            true,
        ));
    }
    let path_dirs: Vec<PathBuf> = env
        .path_var
        .as_ref()
        .map(|v| std::env::split_paths(v).map(|d| d.join(ADB_EXE)).collect())
        .unwrap_or_default();
    groups.push((
        CheckKind::Path,
        AdbSource::Path,
        path_dirs,
        env.path_var.is_some(),
    ));
    let sdks: Vec<PathBuf> = [&env.android_home, &env.android_sdk_root]
        .into_iter()
        .flatten()
        .map(|sdk| sdk.join("platform-tools").join(ADB_EXE))
        .collect();
    let sdk_set = !sdks.is_empty();
    groups.push((
        CheckKind::AndroidHome,
        AdbSource::AndroidHome,
        sdks,
        sdk_set,
    ));
    for (kind, dir) in known_locations(env) {
        let path = dir.join(ADB_EXE);
        match groups.last_mut() {
            Some((k, _, paths, _)) if *k == kind => paths.push(path),
            _ => groups.push((kind, AdbSource::KnownLocation, vec![path], true)),
        }
    }
    if let Some(app_data) = &env.app_data {
        groups.push((
            CheckKind::Bundled,
            AdbSource::Bundled,
            vec![app_data.join("platform-tools").join(ADB_EXE)],
            true,
        ));
    }

    groups
        .into_iter()
        .map(|(kind, source, paths, set)| {
            let found = paths.iter().find(|p| is_executable(p)).cloned();
            let status = match (&found, set) {
                (Some(_), _) => CheckStatus::Found,
                (None, false) => CheckStatus::NotSet,
                (None, true) => CheckStatus::Missing,
            };
            LocationCheck {
                kind,
                source,
                paths,
                found,
                status,
            }
        })
        .collect()
}

/// Returns the first existing adb from [`candidates`] with its version.
pub async fn locate(env: &LocatorEnv) -> Option<AdbInstall> {
    let (path, source) = candidates(env)
        .into_iter()
        .find(|(p, _)| is_executable(p))?;
    Some(inspect(path, source).await)
}

/// Validates a user-chosen adb binary: it must exist, be executable and
/// answer `adb version`.
pub async fn inspect_custom(path: PathBuf) -> Option<AdbInstall> {
    if !is_executable(&path) {
        return None;
    }
    let install = inspect(path, AdbSource::Settings).await;
    install.version.is_some().then_some(install)
}

/// Describes a known adb binary, querying its version.
pub async fn inspect(path: PathBuf, source: AdbSource) -> AdbInstall {
    let version = adb_version(&path).await;
    AdbInstall {
        path,
        source,
        version,
    }
}

fn is_executable(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.is_file() && meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        meta.is_file()
    }
}

async fn adb_version(path: &Path) -> Option<String> {
    let output = Command::new(path).arg("version").output().await.ok()?;
    parse_version(&String::from_utf8_lossy(&output.stdout))
}

/// Internal protocol version of an adb client binary (`41` for
/// "Android Debug Bridge version 1.0.41"); a server with a different one is
/// killed by that client on its next command.
pub async fn client_protocol_version(path: &Path) -> Option<u32> {
    let output = Command::new(path).arg("version").output().await.ok()?;
    parse_protocol_version(&String::from_utf8_lossy(&output.stdout))
}

fn parse_protocol_version(output: &str) -> Option<u32> {
    let line = output
        .lines()
        .find_map(|l| l.strip_prefix("Android Debug Bridge version "))?;
    line.trim().rsplit('.').next()?.parse().ok()
}

/// Extracts `37.0.1-15733141` from `adb version` output.
fn parse_version(output: &str) -> Option<String> {
    output
        .lines()
        .find_map(|line| line.strip_prefix("Version "))
        .map(|v| v.trim().to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_platform_tools_version() {
        let out = "Android Debug Bridge version 1.0.41\n\
                   Version 37.0.1-15733141\n\
                   Installed as /opt/homebrew/bin/adb\n";
        assert_eq!(parse_version(out).as_deref(), Some("37.0.1-15733141"));
        assert_eq!(parse_version("garbage"), None);
        assert_eq!(parse_protocol_version(out), Some(41));
        assert_eq!(parse_protocol_version("garbage"), None);
    }

    #[test]
    fn candidates_follow_priority_order() {
        let env = LocatorEnv {
            settings_path: Some("/custom/adb".into()),
            path_var: Some(std::env::join_paths(["/a", "/b"]).unwrap()),
            android_home: Some("/sdk".into()),
            app_data: Some("/data".into()),
            ..Default::default()
        };
        let sources: Vec<_> = candidates(&env).into_iter().map(|(_, s)| s).collect();

        assert_eq!(sources.first(), Some(&AdbSource::Settings));
        assert_eq!(sources[1..3], [AdbSource::Path, AdbSource::Path]);
        assert_eq!(sources[3], AdbSource::AndroidHome);
        assert_eq!(sources.last(), Some(&AdbSource::Bundled));
    }

    #[test]
    fn scan_reports_every_group() {
        let dir = tempfile::tempdir().unwrap();
        let sdk = dir.path().join("sdk");
        std::fs::create_dir_all(sdk.join("platform-tools")).unwrap();
        let adb = sdk.join("platform-tools").join(ADB_EXE);
        std::fs::write(&adb, b"#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&adb, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        let env = LocatorEnv {
            settings_path: Some(dir.path().join("missing/adb")),
            path_var: Some(std::env::join_paths([dir.path().join("a")]).unwrap()),
            android_home: Some(sdk),
            app_data: Some(dir.path().join("data")),
            ..Default::default()
        };
        let checks = scan(&env);
        let summary: Vec<_> = checks.iter().map(|c| (c.kind, c.status)).collect();

        assert_eq!(summary[0], (CheckKind::Settings, CheckStatus::Missing));
        assert_eq!(summary[1], (CheckKind::Path, CheckStatus::Missing));
        assert_eq!(summary[2], (CheckKind::AndroidHome, CheckStatus::Found));
        assert_eq!(checks[2].found.as_deref(), Some(adb.as_path()));
        assert_eq!(
            summary.last(),
            Some(&(CheckKind::Bundled, CheckStatus::Missing))
        );
    }

    #[test]
    fn scan_marks_unset_variables() {
        let checks = scan(&LocatorEnv::default());
        let home = checks
            .iter()
            .find(|c| c.kind == CheckKind::AndroidHome)
            .unwrap();
        assert_eq!(home.status, CheckStatus::NotSet);
        assert!(home.paths.is_empty());
        let path = checks.iter().find(|c| c.kind == CheckKind::Path).unwrap();
        assert_eq!(path.status, CheckStatus::NotSet);
    }

    #[tokio::test]
    async fn locate_skips_missing_files() {
        let env = LocatorEnv {
            settings_path: Some("/definitely/not/here/adb".into()),
            ..Default::default()
        };
        // Only the settings path and known system dirs are candidates; the
        // settings one must never be returned because it does not exist.
        let found = locate(&env).await;
        assert!(found.is_none_or(|f| f.source != AdbSource::Settings));
    }
}
