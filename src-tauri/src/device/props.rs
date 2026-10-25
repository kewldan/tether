//! System properties from `getprop`.

use std::collections::HashMap;

use serde::Serialize;

use crate::adb::server::AdbServer;
use crate::error::AppResult;

/// Short device summary for list cards and the overview header.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub manufacturer: Option<String>,
    pub model: Option<String>,
    pub android_version: Option<String>,
    pub sdk: Option<u32>,
    pub security_patch: Option<String>,
    pub fingerprint: Option<String>,
    pub abi: Option<String>,
    /// AVD name of an emulator (`Pixel_10_Pro`), shown instead of the
    /// generic `sdk_gphone64_arm64` model.
    pub avd_name: Option<String>,
}

impl DeviceInfo {
    pub fn from_props(props: &HashMap<String, String>) -> Self {
        let get = |key: &str| props.get(key).filter(|v| !v.is_empty()).cloned();
        Self {
            manufacturer: get("ro.product.manufacturer"),
            model: get("ro.product.model"),
            android_version: get("ro.build.version.release"),
            sdk: get("ro.build.version.sdk").and_then(|v| v.parse().ok()),
            security_patch: get("ro.build.version.security_patch"),
            fingerprint: get("ro.build.fingerprint"),
            abi: get("ro.product.cpu.abi"),
            avd_name: get("ro.boot.qemu.avd_name").map(|n| n.replace('_', " ")),
        }
    }
}

pub async fn device_info(server: &AdbServer, serial: &str) -> AppResult<DeviceInfo> {
    let output = server.exec_text(serial, "getprop").await?;
    Ok(DeviceInfo::from_props(&parse_getprop(&output)))
}

/// Parses lines of the form `[ro.build.version.release]: [15]`.
pub fn parse_getprop(output: &str) -> HashMap<String, String> {
    output
        .lines()
        .filter_map(|line| {
            let (key, value) = line.split_once("]: [")?;
            let key = key.strip_prefix('[')?;
            let value = value.trim_end().strip_suffix(']')?;
            Some((key.to_owned(), value.to_owned()))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "\
[ro.build.fingerprint]: [google/husky/husky:15/AP4A.250105.002/12701944:user/release-keys]\r
[ro.build.version.release]: [15]\r
[ro.build.version.sdk]: [35]\r
[ro.build.version.security_patch]: [2025-01-05]\r
[ro.product.cpu.abi]: [arm64-v8a]\r
[ro.product.manufacturer]: [Google]\r
[ro.product.model]: [Pixel 8 Pro]\r
[persist.sys.empty]: []\r
garbage line\r
";

    #[test]
    fn parses_getprop_including_crlf_and_empty_values() {
        let props = parse_getprop(SAMPLE);
        assert_eq!(props["ro.product.model"], "Pixel 8 Pro");
        assert_eq!(props["persist.sys.empty"], "");
        assert_eq!(props.len(), 8);
    }

    #[test]
    fn builds_device_info() {
        let info = DeviceInfo::from_props(&parse_getprop(SAMPLE));
        assert_eq!(info.manufacturer.as_deref(), Some("Google"));
        assert_eq!(info.android_version.as_deref(), Some("15"));
        assert_eq!(info.sdk, Some(35));
        assert_eq!(info.abi.as_deref(), Some("arm64-v8a"));
    }
}
