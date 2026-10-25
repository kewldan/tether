//! Small per-device facts for the All devices cards: battery, root, Wi-Fi
//! address. One `exec:` round trip.

use serde::Serialize;

use crate::adb::server::AdbServer;
use crate::adb::wireless::parse_inet;
use crate::error::AppResult;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceSummary {
    /// 0..=100.
    pub battery: Option<u8>,
    pub charging: bool,
    /// adbd runs as root (`adb root` on userdebug builds and emulators).
    pub root: bool,
    pub wifi_ip: Option<String>,
}

const SCRIPT: &str = "dumpsys battery; echo @@id; id; echo @@ip; ip -f inet addr show wlan0";

pub async fn device_summary(server: &AdbServer, serial: &str) -> AppResult<DeviceSummary> {
    // `exec:` runs the command through `sh -c` on the device.
    let out = server.exec_text(serial, SCRIPT).await?;
    Ok(parse(&out))
}

fn parse(out: &str) -> DeviceSummary {
    let (battery, rest) = out.split_once("@@id").unwrap_or((out, ""));
    let (id, ip) = rest.split_once("@@ip").unwrap_or((rest, ""));
    let (level, charging) = parse_battery(battery);
    DeviceSummary {
        battery: level,
        charging,
        root: id.trim_start().starts_with("uid=0("),
        wifi_ip: parse_inet(ip),
    }
}

/// `dumpsys battery`: `level`/`scale`, and `status: 2` (charging) or any
/// `… powered: true`.
pub fn parse_battery(text: &str) -> (Option<u8>, bool) {
    let mut level = None;
    let mut scale = 100u32;
    let mut charging = false;
    for line in text.lines() {
        let Some((key, value)) = line.trim().split_once(':') else {
            continue;
        };
        let value = value.trim();
        match key {
            "level" => level = value.parse::<u32>().ok(),
            "scale" => scale = value.parse().unwrap_or(100).max(1),
            "status" => charging |= value == "2" || value == "5",
            k if k.ends_with(" powered") => charging |= value == "true",
            _ => {}
        }
    }
    let pct = level.map(|l| u8::try_from((l * 100 / scale).min(100)).unwrap_or(100));
    (pct, charging)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Captured from the Android 16 emulator.
    const EMULATOR: &str = "Current Battery Service state:\n  AC powered: false\n  USB powered: false\n  \
        Wireless powered: false\n  Dock powered: false\n  Max charging current: 0\n \
        Time when the latest updated value of the Max charging current was sent via battery changed broadcast: +7s877ms\n  \
        Max charging voltage: 0\n  Charge counter: 10000\n  status: 4\n  health: 2\n  present: true\n  \
        level: 100\n  scale: 100\n  voltage: 5000\n  temperature: 250\n  technology: Li-ion\n\
        @@id\nuid=2000(shell) gid=2000(shell) groups=2000(shell),1004(input) context=u:r:shell:s0\n\
        @@ip\n16: wlan0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc noqueue state UP\n    \
        inet 10.0.2.16/24 brd 10.0.2.255 scope global wlan0\n";

    #[test]
    fn parses_emulator_summary() {
        assert_eq!(
            parse(EMULATOR),
            DeviceSummary {
                battery: Some(100),
                charging: false,
                root: false,
                wifi_ip: Some("10.0.2.16".into()),
            }
        );
    }

    #[test]
    fn charging_phone_as_root() {
        let out = "  AC powered: false\n  USB powered: true\n  status: 2\n  level: 41\n  scale: 50\n\
                   @@id\nuid=0(root) gid=0(root) groups=0(root) context=u:r:su:s0\n@@ip\n";
        let s = parse(out);
        assert_eq!(s.battery, Some(82));
        assert!(s.charging);
        assert!(s.root);
        assert_eq!(s.wifi_ip, None);
    }

    #[test]
    fn garbage_is_empty() {
        assert_eq!(parse("sh: dumpsys: not found"), DeviceSummary::default());
    }
}
