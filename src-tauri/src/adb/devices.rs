//! Device list parsing and `host:track-devices-l` streaming.

use std::collections::BTreeMap;

use serde::Serialize;

use super::server::{AdbServer, read_length_prefixed};
use crate::error::AppResult;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case", tag = "kind", content = "raw")]
pub enum DeviceState {
    Device,
    Unauthorized,
    Authorizing,
    Offline,
    Connecting,
    NoPermissions,
    Recovery,
    Rescue,
    Sideload,
    Bootloader,
    Host,
    Unknown(String),
}

impl DeviceState {
    fn parse(s: &str) -> Self {
        match s {
            "device" => Self::Device,
            "unauthorized" => Self::Unauthorized,
            "authorizing" => Self::Authorizing,
            "offline" => Self::Offline,
            "connecting" => Self::Connecting,
            "no" => Self::NoPermissions,
            "recovery" => Self::Recovery,
            "rescue" => Self::Rescue,
            "sideload" => Self::Sideload,
            "bootloader" => Self::Bootloader,
            "host" => Self::Host,
            other => Self::Unknown(other.to_owned()),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Transport {
    Usb,
    Wifi,
    Emulator,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub serial: String,
    pub state: DeviceState,
    pub transport: Transport,
    pub model: Option<String>,
    pub product: Option<String>,
    pub device: Option<String>,
    pub transport_id: Option<u32>,
}

/// Parses `devices -l` output, one device per line:
///
/// ```text
/// 38121FDJH00A4B  device usb:1-1 product:husky model:Pixel_8_Pro device:husky transport_id:1
/// R5CW30ABCDE     no permissions (missing udev rules?); see [http://...] usb:3-2 transport_id:4
/// ```
pub fn parse_devices(text: &str) -> Vec<Device> {
    text.lines().filter_map(parse_line).collect()
}

fn parse_line(line: &str) -> Option<Device> {
    let mut tokens = line.split_whitespace();
    let serial = tokens.next()?.to_owned();
    let state = DeviceState::parse(tokens.next()?);

    // The rest is `key:value` pairs, possibly mixed with free text (the
    // `no permissions` explanation), which is skipped.
    let props: BTreeMap<&str, &str> = tokens
        .filter_map(|t| t.split_once(':'))
        .filter(|(k, _)| k.chars().all(|c| c.is_ascii_lowercase() || c == '_'))
        .collect();
    let prop = |key| props.get(key).map(|v| v.replace('_', " "));

    Some(Device {
        transport: transport_of(&serial),
        state,
        model: prop("model"),
        product: props.get("product").map(|v| (*v).to_owned()),
        device: props.get("device").map(|v| (*v).to_owned()),
        transport_id: props.get("transport_id").and_then(|v| v.parse().ok()),
        serial,
    })
}

fn transport_of(serial: &str) -> Transport {
    if serial.starts_with("emulator-") {
        Transport::Emulator
    } else if serial.contains(':') || serial.contains("._adb-tls-connect._tcp") {
        Transport::Wifi
    } else {
        Transport::Usb
    }
}

/// Subscribes to device list changes. The server pushes the full list on
/// connect and after every change; `on_update` gets each snapshot. Returns
/// when the connection drops (server killed or restarted).
pub async fn track(server: &AdbServer, mut on_update: impl FnMut(Vec<Device>)) -> AppResult<()> {
    let mut stream = server.open("host:track-devices-l").await?;
    loop {
        let snapshot = read_length_prefixed(&mut stream).await?;
        on_update(parse_devices(&snapshot));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_usb_device_with_props() {
        let devices = parse_devices(
            "38121FDJH00A4B         device usb:1-1 product:husky model:Pixel_8_Pro \
             device:husky transport_id:1\n",
        );
        assert_eq!(
            devices,
            [Device {
                serial: "38121FDJH00A4B".into(),
                state: DeviceState::Device,
                transport: Transport::Usb,
                model: Some("Pixel 8 Pro".into()),
                product: Some("husky".into()),
                device: Some("husky".into()),
                transport_id: Some(1),
            }]
        );
    }

    #[test]
    fn parses_special_states_and_transports() {
        let devices = parse_devices(
            "emulator-5554 device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 transport_id:2\n\
             192.168.1.42:37115 unauthorized transport_id:3\n\
             R5CW30ABCDE no permissions (missing udev rules? user is in the plugdev group); \
             see [http://developer.android.com/tools/device.html] usb:3-2 transport_id:4\n\
             adb-R5CW30ABCDE-xyz._adb-tls-connect._tcp offline transport_id:5\n",
        );

        let summary: Vec<_> = devices
            .iter()
            .map(|d| (d.state.clone(), d.transport, d.transport_id))
            .collect();
        assert_eq!(
            summary,
            [
                (DeviceState::Device, Transport::Emulator, Some(2)),
                (DeviceState::Unauthorized, Transport::Wifi, Some(3)),
                (DeviceState::NoPermissions, Transport::Usb, Some(4)),
                (DeviceState::Offline, Transport::Wifi, Some(5)),
            ]
        );
    }

    #[test]
    fn empty_list_has_no_devices() {
        assert!(parse_devices("").is_empty());
    }
}
