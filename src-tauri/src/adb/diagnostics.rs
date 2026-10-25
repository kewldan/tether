//! "Can't see your device?" checks. Each check reports a status plus
//! parameters; the frontend owns the wording (it is translated).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tokio::process::Command;

use super::devices::{Device, DeviceState, Transport};
use super::usb::{self, UsbDevice, UsbScan};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Pass,
    Skip,
    Warn,
    Fail,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    /// Stable id, e.g. `server_running`; with `variant` it picks the text.
    pub id: &'static str,
    pub variant: &'static str,
    pub status: Status,
    pub params: BTreeMap<&'static str, String>,
    /// Raw output for "Show adb output".
    pub details: Option<String>,
}

impl Check {
    fn new(id: &'static str, variant: &'static str, status: Status) -> Self {
        Self {
            id,
            variant,
            status,
            params: BTreeMap::new(),
            details: None,
        }
    }

    fn param(mut self, key: &'static str, value: impl ToString) -> Self {
        self.params.insert(key, value.to_string());
        self
    }
}

/// The process listening on the adb port, as far as the OS tells us.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerProcess {
    pub pid: Option<u32>,
    pub binary: Option<PathBuf>,
    pub uptime_secs: Option<u64>,
}

/// Everything the checks are computed from; gathered by the command layer.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Facts {
    pub os: &'static str,
    pub adb_path: Option<PathBuf>,
    pub adb_version: Option<String>,
    /// Protocol version of our adb binary (`41`).
    pub client_version: Option<u32>,
    /// `host:version` of the running server; `None` if unreachable.
    pub server_version: Option<u32>,
    pub server_error: Option<String>,
    pub server_port: u16,
    pub process: ServerProcess,
    pub started_by_us: bool,
    /// Times the device stream lost the server in the last minute.
    pub server_drops: u32,
    pub server_log: Vec<String>,
    pub devices: Vec<Device>,
    pub usb: Option<UsbScan>,
    pub mdns: Option<String>,
    pub udev_rules: Option<bool>,
}

/// Turns facts into the ordered checklist of the Diagnostics board.
pub fn evaluate(f: &Facts) -> Vec<Check> {
    let mut checks = vec![server_check(f), conflict_check(f)];
    checks.extend(usb_checks(f));
    checks.extend(state_checks(f));
    checks.push(permissions_check(f));
    checks.push(drivers_check(f));
    checks.push(mdns_check(f));
    checks
}

fn server_check(f: &Facts) -> Check {
    match f.server_version {
        Some(version) => {
            let by = if f.started_by_us { "tether" } else { "other" };
            let mut c = Check::new("server_running", by, Status::Pass)
                .param("version", version)
                .param("address", format!("localhost:{}", f.server_port));
            if let Some(up) = f.process.uptime_secs {
                c = c.param("uptimeSecs", up);
            }
            c
        }
        None => {
            let mut c =
                Check::new("server_running", "down", Status::Fail).param("port", f.server_port);
            c.details = f.server_error.clone();
            c
        }
    }
}

fn conflict_check(f: &Facts) -> Check {
    let foreign_binary = match (&f.process.binary, &f.adb_path) {
        (Some(server), Some(ours)) => !same_file(server, ours),
        _ => false,
    };
    let mismatch = matches!(
        (f.server_version, f.client_version),
        (Some(s), Some(c)) if s != c
    );
    let details = (!f.server_log.is_empty()).then(|| f.server_log.join("\n"));

    let mut c = if f.server_drops >= 2 {
        Check::new("server_conflict", "restarts", Status::Warn).param("count", f.server_drops)
    } else if mismatch {
        Check::new("server_conflict", "mismatch", Status::Warn)
    } else if foreign_binary {
        // Same protocol, different binary (e.g. Android Studio's copy):
        // harmless until one of them updates.
        Check::new("server_conflict", "foreign", Status::Pass)
    } else if f.server_version.is_none() {
        Check::new("server_conflict", "unknown", Status::Skip)
    } else {
        Check::new("server_conflict", "none", Status::Pass)
    };
    if let Some(s) = f.server_version {
        c = c.param("serverVersion", s);
    }
    if let Some(v) = f.client_version {
        c = c.param("clientVersion", v);
    }
    if let Some(b) = &f.process.binary {
        c = c.param("serverBinary", b.display());
    }
    c.details = details;
    c
}

fn same_file(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

/// USB phones the host sees that adb does not list.
fn hidden_phones<'a>(f: &'a Facts, phones: &[&'a UsbDevice]) -> Vec<&'a UsbDevice> {
    phones
        .iter()
        .copied()
        .filter(|p| {
            !f.devices.iter().any(|d| {
                d.transport == Transport::Usb && p.serial.as_deref() == Some(d.serial.as_str())
            })
        })
        .collect()
}

fn usb_checks(f: &Facts) -> Vec<Check> {
    let Some(scan) = &f.usb else {
        return Vec::new();
    };
    if !scan.supported {
        return vec![Check::new("usb_visible", "unsupported", Status::Skip).param("os", f.os)];
    }
    let phones: Vec<&UsbDevice> = scan
        .devices
        .iter()
        .filter(|d| d.android_vendor.is_some())
        .collect();
    let adb_usb = f
        .devices
        .iter()
        .filter(|d| d.transport == Transport::Usb)
        .count();

    let Some(phone) = phones.first() else {
        if adb_usb > 0 {
            // adb sees it but the vendor is not on our list: fine.
            return vec![Check::new("usb_visible", "adb_only", Status::Pass)];
        }
        let wireless = f.devices.iter().any(|d| d.transport != Transport::Usb);
        let status = if wireless { Status::Skip } else { Status::Warn };
        return vec![
            Check::new("usb_visible", "none", status).param("count", scan.devices.len()),
            Check::new("usb_data", "unknown", Status::Skip),
        ];
    };

    let mut visible = Check::new("usb_visible", "found", Status::Pass)
        .param("vendor", phone.android_vendor.unwrap_or_default())
        .param("product", phone.product.clone().unwrap_or_default())
        .param(
            "id",
            format!("{:04x}:{:04x}", phone.vendor_id, phone.product_id),
        );
    if let Some(loc) = &phone.location {
        visible = visible.param("location", loc);
    }
    if phones.len() > 1 {
        visible = visible.param("more", phones.len() - 1);
    }
    let mut checks = vec![visible, Check::new("usb_data", "ok", Status::Pass)];

    let hidden = hidden_phones(f, &phones);
    if !hidden.is_empty() && adb_usb == 0 {
        checks.push(
            Check::new("usb_debugging", "off", Status::Fail)
                .param("product", hidden[0].product.clone().unwrap_or_default()),
        );
        checks.push(Check::new("usb_mode", "charging", Status::Warn));
    } else if !hidden.is_empty() {
        checks.push(
            Check::new("usb_debugging", "some_off", Status::Warn)
                .param("product", hidden[0].product.clone().unwrap_or_default()),
        );
    } else {
        checks.push(Check::new("usb_debugging", "on", Status::Pass));
    }
    checks
}

fn serials(f: &Facts, pred: impl Fn(&DeviceState) -> bool) -> Vec<String> {
    f.devices
        .iter()
        .filter(|d| pred(&d.state))
        .map(|d| d.model.clone().unwrap_or_else(|| d.serial.clone()))
        .collect()
}

fn state_checks(f: &Facts) -> Vec<Check> {
    let mut checks = Vec::new();
    let unauthorized = serials(f, |s| {
        matches!(s, DeviceState::Unauthorized | DeviceState::Authorizing)
    });
    if !unauthorized.is_empty() {
        checks.push(
            Check::new("authorization", "pending", Status::Warn)
                .param("devices", unauthorized.join(", ")),
        );
    } else if !f.devices.is_empty() {
        checks.push(Check::new("authorization", "ok", Status::Pass));
    }
    let offline = serials(f, |s| matches!(s, DeviceState::Offline));
    if !offline.is_empty() {
        checks
            .push(Check::new("offline", "some", Status::Warn).param("devices", offline.join(", ")));
    }
    checks
}

fn permissions_check(f: &Facts) -> Check {
    let no_perm = serials(f, |s| matches!(s, DeviceState::NoPermissions));
    if !no_perm.is_empty() {
        return Check::new("permissions", "denied", Status::Fail)
            .param("devices", no_perm.join(", "))
            .param("os", f.os);
    }
    Check::new("permissions", "ok", Status::Pass).param("os", f.os)
}

fn drivers_check(f: &Facts) -> Check {
    match f.os {
        "linux" => match f.udev_rules {
            Some(true) => Check::new("drivers", "udev_ok", Status::Pass),
            _ => Check::new("drivers", "udev_missing", Status::Warn),
        },
        "windows" => {
            if f.devices.iter().any(|d| d.transport == Transport::Usb) {
                Check::new("drivers", "windows_ok", Status::Pass)
            } else {
                Check::new("drivers", "windows_unknown", Status::Skip)
            }
        }
        _ => Check::new("drivers", "not_needed", Status::Skip).param("os", f.os),
    }
}

fn mdns_check(f: &Facts) -> Check {
    match &f.mdns {
        Some(version) => Check::new("mdns", "ok", Status::Pass).param("version", version),
        None if f.server_version.is_some() => Check::new("mdns", "off", Status::Warn),
        None => Check::new("mdns", "unknown", Status::Skip),
    }
}

/// Finds the process that listens on `port` (lsof on macOS/Linux,
/// netstat on Windows) and its binary and uptime.
pub async fn server_process(port: u16) -> ServerProcess {
    let Some(pid) = listener_pid(port).await else {
        return ServerProcess::default();
    };
    ServerProcess {
        pid: Some(pid),
        binary: process_binary(pid).await,
        uptime_secs: process_uptime(pid).await,
    }
}

async fn output(cmd: &str, args: &[&str]) -> Option<String> {
    let out = Command::new(cmd).args(args).output().await.ok()?;
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

async fn listener_pid(port: u16) -> Option<u32> {
    if cfg!(windows) {
        let text = output("netstat", &["-ano", "-p", "TCP"]).await?;
        return parse_netstat_pid(&text, port);
    }
    let addr = format!("-iTCP:{port}");
    let text = output("lsof", &["-nP", &addr, "-sTCP:LISTEN", "-Fp"]).await?;
    parse_lsof_pid(&text)
}

/// `lsof -F` output: one field per line, `p<pid>` first.
pub fn parse_lsof_pid(text: &str) -> Option<u32> {
    text.lines()
        .find_map(|l| l.strip_prefix('p'))
        .and_then(|p| p.trim().parse().ok())
}

/// `  TCP    127.0.0.1:5037    0.0.0.0:0    LISTENING    8424`.
pub fn parse_netstat_pid(text: &str, port: u16) -> Option<u32> {
    let suffix = format!(":{port}");
    text.lines().find_map(|line| {
        let cols: Vec<&str> = line.split_whitespace().collect();
        match cols.as_slice() {
            ["TCP", local, _, "LISTENING", pid] if local.ends_with(&suffix) => pid.parse().ok(),
            _ => None,
        }
    })
}

async fn process_binary(pid: u32) -> Option<PathBuf> {
    if cfg!(target_os = "linux") {
        return std::fs::read_link(format!("/proc/{pid}/exe")).ok();
    }
    if cfg!(windows) {
        return None;
    }
    let pid = pid.to_string();
    let text = output("lsof", &["-a", "-p", &pid, "-d", "txt", "-Fn"]).await?;
    text.lines()
        .find_map(|l| l.strip_prefix('n'))
        .map(PathBuf::from)
}

async fn process_uptime(pid: u32) -> Option<u64> {
    if cfg!(windows) {
        return None;
    }
    let pid = pid.to_string();
    parse_etime(&output("ps", &["-o", "etime=", "-p", &pid]).await?)
}

/// `ps -o etime` format: `[[dd-]hh:]mm:ss`.
pub fn parse_etime(text: &str) -> Option<u64> {
    let t = text.trim();
    let (days, rest) = match t.split_once('-') {
        Some((d, r)) => (d.parse::<u64>().ok()?, r),
        None => (0, t),
    };
    let parts: Vec<u64> = rest
        .split(':')
        .map(|p| p.parse().ok())
        .collect::<Option<_>>()?;
    let secs = match parts.as_slice() {
        [m, s] => m * 60 + s,
        [h, m, s] => h * 3600 + m * 60 + s,
        _ => return None,
    };
    Some(days * 86_400 + secs)
}

pub fn udev_rules() -> bool {
    let dirs: Vec<&Path> = usb::UDEV_DIRS.iter().map(Path::new).collect();
    usb::udev_rules_present(&dirs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adb::devices::parse_devices;

    fn facts() -> Facts {
        Facts {
            os: "macos",
            adb_path: Some("/sdk/platform-tools/adb".into()),
            client_version: Some(41),
            server_version: Some(41),
            server_port: 5037,
            usb: Some(UsbScan {
                supported: true,
                devices: Vec::new(),
            }),
            mdns: Some("mdns daemon version [adb discovery 0.0.0]".into()),
            ..Default::default()
        }
    }

    fn pixel() -> UsbDevice {
        UsbDevice {
            vendor_id: 0x18d1,
            product_id: 0x4ee7,
            manufacturer: Some("Google".into()),
            product: Some("Pixel 8 Pro".into()),
            serial: Some("38121FDJH00A4B".into()),
            location: Some("USB 3.1 Bus".into()),
            speed: None,
            android_vendor: Some("Google"),
        }
    }

    fn find<'a>(checks: &'a [Check], id: &str) -> &'a Check {
        checks.iter().find(|c| c.id == id).unwrap()
    }

    #[test]
    fn phone_on_usb_without_debugging_is_the_problem() {
        let mut f = facts();
        f.usb.as_mut().unwrap().devices.push(pixel());
        let checks = evaluate(&f);
        assert_eq!(find(&checks, "usb_visible").status, Status::Pass);
        assert_eq!(find(&checks, "usb_data").status, Status::Pass);
        let dbg = find(&checks, "usb_debugging");
        assert_eq!((dbg.variant, dbg.status), ("off", Status::Fail));
        assert_eq!(find(&checks, "drivers").status, Status::Skip);
    }

    #[test]
    fn listed_phone_passes() {
        let mut f = facts();
        f.usb.as_mut().unwrap().devices.push(pixel());
        f.devices = parse_devices(
            "38121FDJH00A4B device usb:1-1 product:husky model:Pixel_8_Pro device:husky transport_id:1\n",
        );
        let checks = evaluate(&f);
        assert!(
            checks.iter().all(|c| c.status <= Status::Skip),
            "{checks:#?}"
        );
        assert_eq!(find(&checks, "usb_debugging").variant, "on");
    }

    #[test]
    fn device_states_become_warnings() {
        let mut f = facts();
        f.os = "linux";
        f.udev_rules = Some(false);
        f.devices = parse_devices(
            "8f3a2c91 unauthorized usb:1-2 transport_id:3\n\
             R5CW30ABCDE no permissions (missing udev rules? user is in the plugdev group); \
             see [http://developer.android.com/tools/device.html] usb:3-2 transport_id:4\n\
             192.168.1.57:5555 offline transport_id:5\n",
        );
        let checks = evaluate(&f);
        assert_eq!(find(&checks, "authorization").status, Status::Warn);
        assert_eq!(find(&checks, "authorization").params["devices"], "8f3a2c91");
        assert_eq!(find(&checks, "offline").status, Status::Warn);
        assert_eq!(find(&checks, "permissions").status, Status::Fail);
        assert_eq!(find(&checks, "drivers").variant, "udev_missing");
    }

    #[test]
    fn server_down_and_conflicts() {
        let mut f = facts();
        f.server_version = None;
        f.server_error = Some("connection refused".into());
        let checks = evaluate(&f);
        assert_eq!(find(&checks, "server_running").status, Status::Fail);
        assert_eq!(find(&checks, "server_conflict").status, Status::Skip);
        assert_eq!(find(&checks, "mdns").status, Status::Pass);

        let mut f = facts();
        f.server_version = Some(40);
        assert_eq!(find(&evaluate(&f), "server_conflict").variant, "mismatch");
        f.server_drops = 3;
        let c = evaluate(&f);
        let conflict = find(&c, "server_conflict");
        assert_eq!(
            (conflict.variant, conflict.status),
            ("restarts", Status::Warn)
        );
        assert_eq!(conflict.params["count"], "3");
    }

    #[test]
    fn no_usb_phone_with_emulator_is_not_a_warning() {
        let mut f = facts();
        f.devices = parse_devices(
            "emulator-5554 device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 transport_id:1\n",
        );
        let checks = evaluate(&f);
        assert_eq!(find(&checks, "usb_visible").status, Status::Skip);
        assert!(checks.iter().all(|c| c.status <= Status::Skip));
    }

    #[test]
    fn parses_process_tools() {
        // Captured on macOS: `lsof -nP -iTCP:5037 -sTCP:LISTEN -Fp`.
        assert_eq!(
            parse_lsof_pid("p85118\nf14\nn127.0.0.1:5037\n"),
            Some(85118)
        );
        assert_eq!(parse_lsof_pid(""), None);
        let netstat = "\nActive Connections\n\n  Proto  Local Address          Foreign Address        State           PID\n  \
                       TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1012\n  \
                       TCP    127.0.0.1:5037         0.0.0.0:0              LISTENING       8424\n";
        assert_eq!(parse_netstat_pid(netstat, 5037), Some(8424));
        assert_eq!(parse_netstat_pid(netstat, 5038), None);
        assert_eq!(parse_etime("55:09\n"), Some(3309));
        assert_eq!(parse_etime("  01:02:03"), Some(3723));
        assert_eq!(parse_etime("2-00:00:01"), Some(172_801));
        assert_eq!(parse_etime("garbage"), None);
    }
}
