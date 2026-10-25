//! Finds an existing adb executable on the machine.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tokio::process::Command;

#[cfg(windows)]
const ADB_EXE: &str = "adb.exe";
#[cfg(not(windows))]
const ADB_EXE: &str = "adb";

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
    let mut dirs = Vec::new();
    let home = env.home.as_deref();

    if cfg!(target_os = "macos") {
        if let Some(h) = home {
            dirs.push(h.join("Library/Android/sdk/platform-tools"));
        }
        dirs.push("/opt/homebrew/bin".into());
        dirs.push("/usr/local/bin".into());
    } else if cfg!(windows) {
        if let Some(l) = &env.local_app_data {
            dirs.push(l.join(r"Android\Sdk\platform-tools"));
            dirs.push(l.join(r"Microsoft\WinGet\Links"));
        }
        if let Some(h) = home {
            dirs.push(h.join(r"scoop\shims"));
        }
    } else {
        if let Some(h) = home {
            dirs.push(h.join("Android/Sdk/platform-tools"));
        }
        dirs.push("/usr/bin".into());
        dirs.push("/usr/local/bin".into());
    }
    dirs
}

/// Returns the first existing adb from [`candidates`] with its version.
pub async fn locate(env: &LocatorEnv) -> Option<AdbInstall> {
    let (path, source) = candidates(env)
        .into_iter()
        .find(|(p, _)| is_executable(p))?;
    let version = adb_version(&path).await;
    Some(AdbInstall {
        path,
        source,
        version,
    })
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
