//! Android Studio virtual devices: list `~/.android/avd/*.ini` and launch
//! them with the SDK's `emulator` binary.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde::Serialize;

use crate::error::{AppError, AppResult};

#[cfg(windows)]
const EMULATOR_EXE: &str = "emulator.exe";
#[cfg(not(windows))]
const EMULATOR_EXE: &str = "emulator";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Avd {
    /// AVD id passed to `emulator -avd`, e.g. `Pixel_10_Pro`.
    pub name: String,
    /// `avd.ini.displayname`, e.g. `Pixel 10 Pro`.
    pub display_name: String,
    /// API level from `target=android-36.1`.
    pub api: Option<String>,
    pub abi: Option<String>,
}

/// Directory with AVD definitions: `$ANDROID_AVD_HOME`, else
/// `$ANDROID_USER_HOME/avd`, else `~/.android/avd`.
pub fn avd_home() -> Option<PathBuf> {
    let var = |name| std::env::var_os(name).filter(|v| !v.is_empty());
    var("ANDROID_AVD_HOME")
        .map(PathBuf::from)
        .or_else(|| var("ANDROID_USER_HOME").map(|h| PathBuf::from(h).join("avd")))
        .or_else(|| std::env::home_dir().map(|h| h.join(".android/avd")))
}

pub fn parse_ini(text: &str) -> HashMap<String, String> {
    text.lines()
        .filter_map(|l| l.split_once('='))
        .map(|(k, v)| (k.trim().to_owned(), v.trim().to_owned()))
        .collect()
}

/// Reads every `<name>.ini` + `<path>/config.ini` pair in `home`.
pub fn list_in(home: &Path) -> Vec<Avd> {
    let Ok(entries) = std::fs::read_dir(home) else {
        return Vec::new();
    };
    let mut avds: Vec<Avd> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension()? != "ini" {
                return None;
            }
            let name = path.file_stem()?.to_string_lossy().into_owned();
            let ini = parse_ini(&std::fs::read_to_string(&path).ok()?);
            let dir = ini
                .get("path")
                .map(PathBuf::from)
                .filter(|p| p.is_dir())
                .unwrap_or_else(|| home.join(format!("{name}.avd")));
            let config = std::fs::read_to_string(dir.join("config.ini"))
                .map(|t| parse_ini(&t))
                .unwrap_or_default();
            let target = config.get("target").or_else(|| ini.get("target"));
            Some(Avd {
                display_name: config
                    .get("avd.ini.displayname")
                    .cloned()
                    .unwrap_or_else(|| name.replace('_', " ")),
                api: target
                    .and_then(|t| t.strip_prefix("android-"))
                    .map(str::to_owned),
                abi: config.get("abi.type").cloned(),
                name,
            })
        })
        .collect();
    avds.sort_by(|a, b| a.display_name.cmp(&b.display_name));
    avds
}

/// Finds the `emulator` binary next to an SDK: `$ANDROID_HOME`,
/// `$ANDROID_SDK_ROOT`, the SDK that holds `adb`, or Studio's default.
pub fn emulator_binary(adb: Option<&Path>) -> Option<PathBuf> {
    let var = |name| std::env::var_os(name).filter(|v| !v.is_empty());
    let mut sdks: Vec<PathBuf> = [var("ANDROID_HOME"), var("ANDROID_SDK_ROOT")]
        .into_iter()
        .flatten()
        .map(PathBuf::from)
        .collect();
    // <sdk>/platform-tools/adb
    if let Some(sdk) = adb.and_then(Path::parent).and_then(Path::parent) {
        sdks.push(sdk.to_owned());
    }
    if let Some(home) = std::env::home_dir() {
        if cfg!(target_os = "macos") {
            sdks.push(home.join("Library/Android/sdk"));
        } else if cfg!(windows) {
            if let Some(l) = var("LOCALAPPDATA") {
                sdks.push(PathBuf::from(l).join(r"Android\Sdk"));
            }
        } else {
            sdks.push(home.join("Android/Sdk"));
        }
    }
    sdks.into_iter()
        .map(|sdk| sdk.join("emulator").join(EMULATOR_EXE))
        .find(|p| p.is_file())
}

/// Starts an AVD detached; it shows up in track-devices once booted.
pub fn launch(emulator: &Path, name: &str) -> AppResult<()> {
    if name.is_empty() || name.starts_with('-') {
        return Err(AppError::InvalidInput(format!("bad AVD name {name:?}")));
    }
    std::process::Command::new(emulator)
        .arg("-avd")
        .arg(name)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(drop)
        .map_err(|e| AppError::Device(format!("failed to start the emulator: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_avds_from_ini_files() {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join("Pixel_10_Pro.avd");
        std::fs::create_dir_all(&dir).unwrap();
        // Captured from Android Studio's AVD manager.
        std::fs::write(
            home.path().join("Pixel_10_Pro.ini"),
            format!(
                "avd.ini.encoding=UTF-8\npath={}\npath.rel=avd/Pixel_10_Pro.avd\ntarget=android-36.1\n",
                dir.display()
            ),
        )
        .unwrap();
        std::fs::write(
            dir.join("config.ini"),
            "PlayStore.enabled=false\nabi.type=arm64-v8a\navd.ini.displayname=Pixel 10 Pro\n\
             hw.device.name=pixel_10_pro\nimage.sysdir.1=system-images/android-36.1/google_apis/arm64-v8a/\n\
             tag.id=google_apis\ntarget=android-36.1\n",
        )
        .unwrap();
        // A definition whose folder went missing still lists.
        std::fs::write(home.path().join("Old_Tablet.ini"), "target=android-34\n").unwrap();
        std::fs::write(home.path().join("notes.txt"), "x").unwrap();

        let avds = list_in(home.path());
        assert_eq!(
            avds,
            [
                Avd {
                    name: "Old_Tablet".into(),
                    display_name: "Old Tablet".into(),
                    api: Some("34".into()),
                    abi: None,
                },
                Avd {
                    name: "Pixel_10_Pro".into(),
                    display_name: "Pixel 10 Pro".into(),
                    api: Some("36.1".into()),
                    abi: Some("arm64-v8a".into()),
                },
            ]
        );
    }

    #[test]
    fn missing_home_lists_nothing() {
        assert!(list_in(Path::new("/definitely/not/here")).is_empty());
    }

    #[test]
    fn rejects_option_like_names() {
        assert!(launch(Path::new("/bin/true"), "-wipe-data").is_err());
    }
}
