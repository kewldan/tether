//! What the host OS sees on USB, independent of adb: used by diagnostics to
//! tell "no cable / charge-only cable" from "USB debugging is off".

use std::path::Path;

use serde::Serialize;
use tokio::process::Command;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsbDevice {
    pub vendor_id: u16,
    pub product_id: u16,
    pub manufacturer: Option<String>,
    pub product: Option<String>,
    pub serial: Option<String>,
    /// Bus/port description, e.g. `USB 3.1 Bus` or `1-4`.
    pub location: Option<String>,
    pub speed: Option<String>,
    /// Vendor name if the vendor id belongs to a known Android maker.
    pub android_vendor: Option<&'static str>,
}

/// USB vendor ids of Android device makers (Android's own list plus the
/// usual suspects from `51-android.rules`).
const ANDROID_VENDORS: &[(u16, &str)] = &[
    (0x18d1, "Google"),
    (0x04e8, "Samsung"),
    (0x2717, "Xiaomi"),
    (0x2a70, "OnePlus"),
    (0x22d9, "OPPO"),
    (0x2d95, "vivo"),
    (0x12d1, "Huawei"),
    (0x22b8, "Motorola"),
    (0x0fce, "Sony"),
    (0x1004, "LG"),
    (0x0bb4, "HTC"),
    (0x0b05, "Asus"),
    (0x17ef, "Lenovo"),
    (0x19d2, "ZTE"),
    (0x2e04, "HMD / Nokia"),
    (0x2ae5, "Fairphone"),
    (0x1949, "Amazon"),
    (0x2b4c, "Nothing"),
    (0x1ebf, "Coolpad"),
    (0x0e8d, "MediaTek"),
    (0x1782, "Spreadtrum"),
    (0x05c6, "Qualcomm"),
];

pub fn android_vendor(vendor_id: u16) -> Option<&'static str> {
    ANDROID_VENDORS
        .iter()
        .find(|(id, _)| *id == vendor_id)
        .map(|(_, name)| *name)
}

/// Result of a host USB scan.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsbScan {
    /// False where we cannot enumerate USB (Windows for now).
    pub supported: bool,
    pub devices: Vec<UsbDevice>,
}

pub async fn scan() -> UsbScan {
    if cfg!(target_os = "macos") {
        UsbScan {
            supported: true,
            devices: scan_macos().await,
        }
    } else if cfg!(target_os = "linux") {
        UsbScan {
            supported: true,
            devices: parse_sysfs(Path::new("/sys/bus/usb/devices")),
        }
    } else {
        UsbScan {
            supported: false,
            devices: Vec::new(),
        }
    }
}

async fn scan_macos() -> Vec<UsbDevice> {
    // macOS 14+ moved USB to SPUSBHostDataType; older ones only have
    // SPUSBDataType.
    for data_type in ["SPUSBHostDataType", "SPUSBDataType"] {
        let Ok(out) = Command::new("system_profiler")
            .args([data_type, "-json"])
            .output()
            .await
        else {
            continue;
        };
        let devices = parse_system_profiler(&String::from_utf8_lossy(&out.stdout));
        if !devices.is_empty() {
            return devices;
        }
    }
    Vec::new()
}

/// Parses `system_profiler SPUSBHostDataType -json` (and the older
/// `SPUSBDataType` layout): a tree of buses and devices under `_items`.
pub fn parse_system_profiler(json: &str) -> Vec<UsbDevice> {
    let Ok(root) = serde_json::from_str::<serde_json::Value>(json) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    if let Some(obj) = root.as_object() {
        for buses in obj.values() {
            for bus in buses.as_array().into_iter().flatten() {
                let bus_name = bus.get("_name").and_then(|v| v.as_str());
                walk(bus, bus_name, &mut out);
            }
        }
    }
    out
}

fn walk(node: &serde_json::Value, bus: Option<&str>, out: &mut Vec<UsbDevice>) {
    for item in node
        .get("_items")
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
    {
        let s = |keys: &[&str]| {
            keys.iter()
                .find_map(|k| item.get(*k).and_then(|v| v.as_str()))
                .map(str::trim)
                .filter(|v| !v.is_empty())
        };
        let vendor = s(&["USBDeviceKeyVendorID", "vendor_id"]).and_then(parse_hex_id);
        let product = s(&["USBDeviceKeyProductID", "product_id"]).and_then(parse_hex_id);
        if let (Some(vendor_id), Some(product_id)) = (vendor, product) {
            // Old layout: "0x18d1  (Google Inc.)".
            let vendor_name = s(&["USBDeviceKeyVendorName", "manufacturer"]).map(str::to_owned);
            out.push(UsbDevice {
                vendor_id,
                product_id,
                manufacturer: vendor_name,
                product: s(&["_name"]).map(str::to_owned),
                serial: s(&["USBDeviceKeySerialNumber", "serial_num"]).map(str::to_owned),
                location: bus.map(str::to_owned),
                speed: s(&["USBDeviceKeyLinkSpeed", "device_speed"]).map(str::to_owned),
                android_vendor: android_vendor(vendor_id),
            });
        }
        walk(item, bus, out);
    }
}

fn parse_hex_id(s: &str) -> Option<u16> {
    let hex = s.split_whitespace().next()?;
    u16::from_str_radix(hex.trim_start_matches("0x"), 16).ok()
}

/// Reads `/sys/bus/usb/devices/<port>/{idVendor,idProduct,…}`.
pub fn parse_sysfs(root: &Path) -> Vec<UsbDevice> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut out: Vec<UsbDevice> = entries
        .flatten()
        .filter_map(|e| {
            let dir = e.path();
            let name = e.file_name().to_string_lossy().into_owned();
            // Interfaces look like `1-4:1.0`; root hubs like `usb1`.
            if name.contains(':') || name.starts_with("usb") {
                return None;
            }
            let read = |f: &str| {
                std::fs::read_to_string(dir.join(f))
                    .ok()
                    .map(|v| v.trim().to_owned())
                    .filter(|v| !v.is_empty())
            };
            let vendor_id = u16::from_str_radix(&read("idVendor")?, 16).ok()?;
            let product_id = u16::from_str_radix(&read("idProduct")?, 16).ok()?;
            Some(UsbDevice {
                vendor_id,
                product_id,
                manufacturer: read("manufacturer"),
                product: read("product"),
                serial: read("serial"),
                speed: read("speed").map(|s| format!("{s} Mb/s")),
                location: Some(name),
                android_vendor: android_vendor(vendor_id),
            })
        })
        .collect();
    out.sort_by(|a, b| a.location.cmp(&b.location));
    out
}

/// True if some udev rule mentions Android devices (the
/// `android-udev-rules` package, a hand-written `51-android.rules`, or
/// systemd's `uaccess` rules for adb).
pub fn udev_rules_present(dirs: &[&Path]) -> bool {
    dirs.iter().any(|dir| {
        std::fs::read_dir(dir)
            .into_iter()
            .flatten()
            .flatten()
            .any(|e| {
                let name = e.file_name().to_string_lossy().to_lowercase();
                if name.contains("android") || name.contains("adb") {
                    return true;
                }
                std::fs::read_to_string(e.path()).is_ok_and(|t| {
                    let t = t.to_lowercase();
                    t.contains("adb") && t.contains("18d1")
                })
            })
    })
}

pub const UDEV_DIRS: &[&str] = &[
    "/etc/udev/rules.d",
    "/lib/udev/rules.d",
    "/usr/lib/udev/rules.d",
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_macos_host_data_type() {
        // Captured from macOS 27 (`system_profiler SPUSBHostDataType -json`),
        // with a Pixel added next to the real DisplayPort adapter.
        let json = r#"{
          "SPUSBHostDataType" : [
            { "_name" : "USB 3.1 Bus", "Driver" : "AppleT8132USBXHCI",
              "USBKeyHardwareType" : "Built-in", "USBKeyLocationID" : "0x02000000" },
            { "_items" : [
                { "_name" : "USB-C To DP Cable", "USBDeviceKeyLinkSpeed" : "12 Mb/s",
                  "USBDeviceKeyProductID" : "0x7213", "USBDeviceKeyProductVersion" : "0x3216",
                  "USBDeviceKeySerialNumber" : "CH7213D", "USBDeviceKeyVendorID" : "0x0639",
                  "USBDeviceKeyVendorName" : "Chrontel", "USBKeyHardwareType" : "Removable",
                  "USBKeyLocationID" : "0x00100000" },
                { "_name" : "Pixel 8 Pro", "USBDeviceKeyLinkSpeed" : "480 Mb/s",
                  "USBDeviceKeyProductID" : "0x4ee7", "USBDeviceKeySerialNumber" : "38121FDJH00A4B",
                  "USBDeviceKeyVendorID" : "0x18d1", "USBDeviceKeyVendorName" : "Google" }
              ],
              "_name" : "USB 3.1 Bus", "Driver" : "AppleT8132USBXHCI",
              "USBKeyHardwareType" : "Built-in", "USBKeyLocationID" : "0x00000000" }
          ]
        }"#;
        let devices = parse_system_profiler(json);
        assert_eq!(devices.len(), 2);
        assert_eq!(devices[0].vendor_id, 0x0639);
        assert_eq!(devices[0].android_vendor, None);
        let pixel = &devices[1];
        assert_eq!((pixel.vendor_id, pixel.product_id), (0x18d1, 0x4ee7));
        assert_eq!(pixel.android_vendor, Some("Google"));
        assert_eq!(pixel.serial.as_deref(), Some("38121FDJH00A4B"));
        assert_eq!(pixel.location.as_deref(), Some("USB 3.1 Bus"));
    }

    #[test]
    fn parses_legacy_usb_data_type() {
        let json = r#"{ "SPUSBDataType" : [ { "_name" : "USB31Bus", "_items" : [
            { "_name" : "USB3.1 Hub", "vendor_id" : "0x2109  (VIA Labs, Inc.)", "product_id" : "0x0817",
              "_items" : [ { "_name" : "SM-S911B", "manufacturer" : "SAMSUNG",
                "product_id" : "0x6860", "vendor_id" : "0x04e8  (Samsung Electronics Co., Ltd.)",
                "serial_num" : "R5CW30ABCDE", "location_id" : "0x01110000 / 3" } ] } ] } ] }"#;
        let devices = parse_system_profiler(json);
        assert_eq!(devices.len(), 2);
        assert_eq!(devices[1].vendor_id, 0x04e8);
        assert_eq!(devices[1].android_vendor, Some("Samsung"));
        assert_eq!(devices[1].manufacturer.as_deref(), Some("SAMSUNG"));
    }

    #[test]
    fn empty_or_broken_json() {
        assert!(parse_system_profiler(r#"{ "SPUSBDataType" : [ ] }"#).is_empty());
        assert!(parse_system_profiler("not json").is_empty());
    }

    // Sysfs interface dirs are named like `1-4:1.0`; Windows forbids `:` in
    // file names, and sysfs only exists on Linux anyway.
    #[cfg(unix)]
    #[test]
    fn reads_linux_sysfs() {
        let root = tempfile::tempdir().unwrap();
        let dev = root.path().join("1-4");
        std::fs::create_dir_all(&dev).unwrap();
        for (f, v) in [
            ("idVendor", "18d1\n"),
            ("idProduct", "4ee7\n"),
            ("manufacturer", "Google\n"),
            ("product", "Pixel 8 Pro\n"),
            ("serial", "38121FDJH00A4B\n"),
            ("speed", "480\n"),
        ] {
            std::fs::write(dev.join(f), v).unwrap();
        }
        std::fs::create_dir_all(root.path().join("1-4:1.0")).unwrap();
        std::fs::create_dir_all(root.path().join("usb1")).unwrap();

        let devices = parse_sysfs(root.path());
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].product.as_deref(), Some("Pixel 8 Pro"));
        assert_eq!(devices[0].speed.as_deref(), Some("480 Mb/s"));
        assert_eq!(devices[0].location.as_deref(), Some("1-4"));
    }

    #[test]
    fn detects_udev_rules() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!udev_rules_present(&[dir.path()]));
        std::fs::write(
            dir.path().join("70-mine.rules"),
            "SUBSYSTEM==\"usb\", ATTR{idVendor}==\"18d1\", MODE=\"0660\", GROUP=\"adbusers\"\n",
        )
        .unwrap();
        assert!(udev_rules_present(&[dir.path()]));
    }
}
