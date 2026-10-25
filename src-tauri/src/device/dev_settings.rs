//! Developer toggles: read and change `settings`, `wm`, `cmd uimode`,
//! debug properties, demo mode and radios.
//!
//! Reading is one `exec:` round trip; every change is a short command
//! sequence followed by a fresh read, so the UI always shows what the
//! device actually reports.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::adb::server::AdbServer;
use crate::device::overview::{Size, parse_wm_density, parse_wm_size};
use crate::device::props::parse_getprop;
use crate::device::sections;
use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevSettings {
    pub dark_theme: Option<bool>,
    /// Window animation scale; transition and animator are set together.
    pub animation_scale: Option<f32>,
    pub font_scale: Option<f32>,
    pub physical_size: Option<Size>,
    /// `wm size` override, `None` when the physical size is used.
    pub screen_size: Option<Size>,
    pub physical_density: Option<u32>,
    pub density: Option<u32>,
    pub show_touches: Option<bool>,
    pub pointer_location: Option<bool>,
    pub layout_bounds: Option<bool>,
    pub gpu_profiling: Option<bool>,
    pub stay_awake: Option<bool>,
    pub demo_mode: Option<bool>,
    pub wifi: Option<bool>,
    pub mobile_data: Option<bool>,
    pub airplane: Option<bool>,
    /// System locale (read only: there is no supported shell command to
    /// change it live).
    pub locale: Option<String>,
}

/// One change requested by the UI, e.g. `{ "key": "darkTheme", "value": true }`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "key", content = "value", rename_all = "camelCase")]
pub enum DevChange {
    DarkTheme(bool),
    AnimationScale(f32),
    FontScale(f32),
    /// `None` resets to the physical size.
    ScreenSize(Option<Size>),
    /// `None` resets to the physical density.
    Density(Option<u32>),
    ShowTouches(bool),
    PointerLocation(bool),
    LayoutBounds(bool),
    GpuProfiling(bool),
    StayAwake(bool),
    DemoMode(bool),
    Wifi(bool),
    MobileData(bool),
    Airplane(bool),
}

/// `key=value` lines of `settings list <namespace>`.
pub fn parse_settings_list(output: &str) -> HashMap<String, String> {
    output
        .lines()
        .filter_map(|l| {
            let (k, v) = l.split_once('=')?;
            Some((k.trim().to_owned(), v.trim().to_owned()))
        })
        .collect()
}

/// `Night mode: yes` → `Some(true)`; `auto`/`custom` count as off.
pub fn parse_night_mode(output: &str) -> Option<bool> {
    let value = output
        .lines()
        .find_map(|l| l.trim().strip_prefix("Night mode:"))?;
    Some(value.trim() == "yes")
}

fn flag(map: &HashMap<String, String>, key: &str, default: bool) -> Option<bool> {
    match map.get(key).map(String::as_str) {
        None | Some("null") => Some(default),
        Some(v) => v.parse::<i64>().ok().map(|n| n != 0),
    }
}

fn scale(map: &HashMap<String, String>, key: &str) -> Option<f32> {
    match map.get(key).map(String::as_str) {
        None | Some("null") => Some(1.0),
        Some(v) => v.parse().ok(),
    }
}

fn prop_flag(value: Option<&String>) -> Option<bool> {
    let v = value
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default();
    Some(matches!(
        v.as_str(),
        "true" | "1" | "visual_bars" | "visual_lines"
    ))
}

/// Builds the settings from the outputs of [`READ_SECTIONS`].
pub fn from_sections(out: &HashMap<String, String>) -> DevSettings {
    let section = |name: &str| out.get(name).map(String::as_str).unwrap_or("");
    let global = parse_settings_list(section("global"));
    let system = parse_settings_list(section("system"));
    let props = parse_getprop(section("props"));
    let (physical_size, screen_size) = parse_wm_size(section("wmsize"));
    let (physical_density, density) = parse_wm_density(section("wmdensity"));

    // wifi_on: 1 on, 2 on while in airplane mode, 0/3 off.
    let wifi = global
        .get("wifi_on")
        .and_then(|v| v.parse::<i64>().ok())
        .map(|v| v == 1 || v == 2);

    DevSettings {
        dark_theme: parse_night_mode(section("night")),
        animation_scale: scale(&global, "window_animation_scale"),
        font_scale: scale(&system, "font_scale"),
        physical_size,
        screen_size,
        physical_density,
        density,
        show_touches: flag(&system, "show_touches", false),
        pointer_location: flag(&system, "pointer_location", false),
        layout_bounds: prop_flag(props.get("debug.layout")),
        gpu_profiling: prop_flag(props.get("debug.hwui.profile")),
        stay_awake: flag(&global, "stay_on_while_plugged_in", false),
        demo_mode: flag(&global, "sysui_tuner_demo_on", false),
        wifi,
        mobile_data: flag(&global, "mobile_data", false),
        airplane: flag(&global, "airplane_mode_on", false),
        locale: ["persist.sys.locale", "ro.product.locale"]
            .iter()
            .find_map(|k| props.get(*k).filter(|v| !v.is_empty()))
            .cloned(),
    }
}

const READ_SECTIONS: &[(&str, &str)] = &[
    ("night", "cmd uimode night"),
    ("global", "settings list global"),
    ("system", "settings list system"),
    ("wmsize", "wm size"),
    ("wmdensity", "wm density"),
    (
        "props",
        "for p in debug.layout debug.hwui.profile persist.sys.locale ro.product.locale; \
         do echo \"[$p]: [$(getprop $p)]\"; done",
    ),
];

pub async fn read(server: &AdbServer, serial: &str) -> AppResult<DevSettings> {
    let out = sections::run(server, serial, READ_SECTIONS).await?;
    Ok(from_sections(&out))
}

/// Shell commands implementing a change. Values are typed, so nothing
/// user-controlled is interpolated as text.
pub fn commands(change: &DevChange) -> AppResult<Vec<String>> {
    let on = |b: bool| if b { "1" } else { "0" };
    // Poke every app so it re-reads debug properties (SYSPROPS_TRANSACTION).
    const POKE: &str = "service call activity 1599295570";
    Ok(match *change {
        DevChange::DarkTheme(v) => {
            vec![format!("cmd uimode night {}", if v { "yes" } else { "no" })]
        }
        DevChange::AnimationScale(v) => {
            if !(0.0..=10.0).contains(&v) {
                return Err(AppError::InvalidInput(format!("animation scale {v}")));
            }
            [
                "window_animation_scale",
                "transition_animation_scale",
                "animator_duration_scale",
            ]
            .iter()
            .map(|k| format!("settings put global {k} {v}"))
            .collect()
        }
        DevChange::FontScale(v) => {
            if !(0.5..=3.0).contains(&v) {
                return Err(AppError::InvalidInput(format!("font scale {v}")));
            }
            vec![format!("settings put system font_scale {v}")]
        }
        DevChange::ScreenSize(None) => vec!["wm size reset".into()],
        DevChange::ScreenSize(Some(Size { width, height })) => {
            if !(100..=10_000).contains(&width) || !(100..=10_000).contains(&height) {
                return Err(AppError::InvalidInput(format!("size {width}x{height}")));
            }
            vec![format!("wm size {width}x{height}")]
        }
        DevChange::Density(None) => vec!["wm density reset".into()],
        DevChange::Density(Some(d)) => {
            if !(72..=1000).contains(&d) {
                return Err(AppError::InvalidInput(format!("density {d}")));
            }
            vec![format!("wm density {d}")]
        }
        DevChange::ShowTouches(v) => vec![format!("settings put system show_touches {}", on(v))],
        DevChange::PointerLocation(v) => {
            vec![format!("settings put system pointer_location {}", on(v))]
        }
        DevChange::LayoutBounds(v) => vec![
            format!("setprop debug.layout {}", if v { "true" } else { "false" }),
            POKE.into(),
        ],
        DevChange::GpuProfiling(v) => vec![
            format!(
                "setprop debug.hwui.profile {}",
                if v { "visual_bars" } else { "false" }
            ),
            POKE.into(),
        ],
        // 7 = AC | USB | wireless.
        DevChange::StayAwake(v) => vec![format!(
            "settings put global stay_on_while_plugged_in {}",
            if v { "7" } else { "0" }
        )],
        DevChange::DemoMode(true) => {
            let demo = |extra: &str| format!("am broadcast -a com.android.systemui.demo {extra}");
            vec![
                "settings put global sysui_demo_allowed 1".into(),
                "settings put global sysui_tuner_demo_on 1".into(),
                demo("-e command enter"),
                demo("-e command clock -e hhmm 1200"),
                demo("-e command battery -e level 100 -e plugged false"),
                demo("-e command network -e wifi show -e level 4"),
                demo("-e command network -e mobile show -e datatype none -e level 4"),
                demo("-e command notifications -e visible false"),
            ]
        }
        DevChange::DemoMode(false) => vec![
            "am broadcast -a com.android.systemui.demo -e command exit".into(),
            "settings put global sysui_tuner_demo_on 0".into(),
        ],
        DevChange::Wifi(v) => vec![format!("svc wifi {}", if v { "enable" } else { "disable" })],
        DevChange::MobileData(v) => {
            vec![format!("svc data {}", if v { "enable" } else { "disable" })]
        }
        DevChange::Airplane(v) => vec![format!(
            "cmd connectivity airplane-mode {}",
            if v { "enable" } else { "disable" }
        )],
    })
}

/// Output of a settings/wm/cmd call that signals failure.
pub fn failure(output: &str) -> Option<String> {
    let text = output.trim();
    let failed = text.contains("Exception")
        || text.starts_with("Error")
        || text.contains("Unknown command")
        || text.contains("not found")
        || text.contains("Permission denial")
        || text.contains("Can't find service");
    failed.then(|| text.lines().take(3).collect::<Vec<_>>().join("\n"))
}

/// Applies one change and returns the settings read back afterwards.
pub async fn apply(server: &AdbServer, serial: &str, change: &DevChange) -> AppResult<DevSettings> {
    for command in commands(change)? {
        // stderr is merged so errors are visible; broadcasts print noise
        // on success, which `failure` ignores.
        let out = server.exec_text(serial, &format!("{command} 2>&1")).await?;
        if let Some(message) = failure(&out) {
            return Err(AppError::Device(message));
        }
    }
    read(server, serial).await
}

#[cfg(test)]
mod tests {
    use super::*;

    // Android 16 emulator.
    const GLOBAL: &str = include_str!("testdata/emu36/settings_global.txt");
    const SYSTEM: &str = include_str!("testdata/emu36/settings_system.txt");

    fn sections_from_emulator() -> HashMap<String, String> {
        [
            ("night", "Night mode: yes\n"),
            ("global", GLOBAL),
            ("system", SYSTEM),
            ("wmsize", "Physical size: 1280x2856\n"),
            (
                "wmdensity",
                "Physical density: 480\nOverride density: 420\n",
            ),
            (
                "props",
                "[debug.layout]: []\n[debug.hwui.profile]: [visual_bars]\n\
                 [persist.sys.locale]: []\n[ro.product.locale]: [en-US]\n",
            ),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_owned(), v.to_owned()))
        .collect()
    }

    #[test]
    fn reads_emulator_settings() {
        let s = from_sections(&sections_from_emulator());
        assert_eq!(s.dark_theme, Some(true));
        assert_eq!(s.animation_scale, Some(1.0));
        assert_eq!(s.font_scale, Some(1.0));
        assert_eq!(s.show_touches, Some(false));
        assert_eq!(s.pointer_location, Some(false));
        assert_eq!(s.stay_awake, Some(true));
        assert_eq!(s.wifi, Some(true));
        assert_eq!(s.mobile_data, Some(true));
        assert_eq!(s.airplane, Some(false));
        assert_eq!(s.demo_mode, Some(false));
        assert_eq!(s.layout_bounds, Some(false));
        assert_eq!(s.gpu_profiling, Some(true));
        assert_eq!(s.screen_size, None);
        assert_eq!(s.density, Some(420));
        assert_eq!(s.physical_density, Some(480));
        assert_eq!(s.locale.as_deref(), Some("en-US"));
    }

    #[test]
    fn night_mode_values() {
        assert_eq!(parse_night_mode("Night mode: no\n"), Some(false));
        assert_eq!(parse_night_mode("Night mode: auto\n"), Some(false));
        assert_eq!(parse_night_mode(""), None);
    }

    #[test]
    fn changes_from_json() {
        let c: DevChange = serde_json::from_str(r#"{"key":"darkTheme","value":false}"#).unwrap();
        assert_eq!(c, DevChange::DarkTheme(false));
        let c: DevChange =
            serde_json::from_str(r#"{"key":"screenSize","value":{"width":1080,"height":2400}}"#)
                .unwrap();
        assert_eq!(
            c,
            DevChange::ScreenSize(Some(Size {
                width: 1080,
                height: 2400
            }))
        );
        let c: DevChange = serde_json::from_str(r#"{"key":"density","value":null}"#).unwrap();
        assert_eq!(c, DevChange::Density(None));
    }

    #[test]
    fn builds_commands() {
        assert_eq!(
            commands(&DevChange::AnimationScale(0.5)).unwrap(),
            vec![
                "settings put global window_animation_scale 0.5",
                "settings put global transition_animation_scale 0.5",
                "settings put global animator_duration_scale 0.5",
            ]
        );
        assert_eq!(
            commands(&DevChange::ScreenSize(None)).unwrap(),
            vec!["wm size reset"]
        );
        assert_eq!(
            commands(&DevChange::LayoutBounds(true)).unwrap()[0],
            "setprop debug.layout true"
        );
        assert!(commands(&DevChange::FontScale(9.0)).is_err());
        assert!(commands(&DevChange::Density(Some(5))).is_err());
    }

    #[test]
    fn detects_failures() {
        assert!(failure("").is_none());
        assert!(failure("Broadcasting: Intent { act=com.android.systemui.demo flg=0x400000 (has extras) }\nBroadcast completed: result=0\n").is_none());
        assert!(
            failure("Exception occurred while executing 'put':\njava.lang.SecurityException: …")
                .is_some()
        );
    }
}
