//! Live device snapshot for the Overview page: battery, storage, memory,
//! CPU, thermal, display, network, uptime and build facts.
//!
//! Everything comes from one `exec:` round trip (see [`super::sections`]).
//! Every field is optional: emulators and older releases lack some sources,
//! and a missing value must never fail the whole snapshot.

use std::collections::HashMap;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::adb::server::AdbServer;
use crate::device::props::{DeviceInfo, parse_getprop};
use crate::device::sections;
use crate::error::AppResult;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceSnapshot {
    pub info: DeviceInfo,
    pub build: BuildFacts,
    pub battery: Option<Battery>,
    pub storage: Option<Storage>,
    pub memory: Option<Memory>,
    pub cpu: Cpu,
    pub thermal: Option<Thermal>,
    pub display: Display,
    pub network: Network,
    pub uptime_secs: Option<f64>,
    pub root: RootStatus,
    /// Host time of the snapshot, ms since the Unix epoch.
    pub taken_at: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildFacts {
    pub brand: Option<String>,
    pub device: Option<String>,
    pub build_id: Option<String>,
    pub build_type: Option<String>,
    pub incremental: Option<String>,
    /// SoC name (`ro.soc.manufacturer` + `ro.soc.model`), else `ro.hardware`.
    pub soc: Option<String>,
    pub locale: Option<String>,
}

// ---------------------------------------------------------------- battery

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BatteryStatus {
    Unknown,
    Charging,
    Discharging,
    NotCharging,
    Full,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BatteryHealth {
    Unknown,
    Good,
    Overheat,
    Dead,
    OverVoltage,
    Failure,
    Cold,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PowerSource {
    Ac,
    Usb,
    Wireless,
    Dock,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Battery {
    /// 0–100.
    pub level: Option<u8>,
    pub status: BatteryStatus,
    pub plugged: Option<PowerSource>,
    pub temperature_c: Option<f32>,
    pub health: BatteryHealth,
    pub voltage_v: Option<f32>,
    pub technology: Option<String>,
}

/// Parses `dumpsys battery`.
pub fn parse_battery(output: &str) -> Option<Battery> {
    let fields = colon_fields(output);
    let get = |k: &str| fields.get(k).map(String::as_str);
    let level: Option<u32> = get("level").and_then(|v| v.parse().ok());
    let scale: u32 = get("scale").and_then(|v| v.parse().ok()).unwrap_or(100);
    if level.is_none() && get("status").is_none() {
        return None;
    }
    let level = level.map(|l| {
        let pct = (l * 100).checked_div(scale).unwrap_or(l);
        pct.min(100) as u8
    });

    let status = match get("status").and_then(|v| v.parse::<u8>().ok()) {
        Some(2) => BatteryStatus::Charging,
        Some(3) => BatteryStatus::Discharging,
        Some(4) => BatteryStatus::NotCharging,
        Some(5) => BatteryStatus::Full,
        _ => BatteryStatus::Unknown,
    };
    let health = match get("health").and_then(|v| v.parse::<u8>().ok()) {
        Some(2) => BatteryHealth::Good,
        Some(3) => BatteryHealth::Overheat,
        Some(4) => BatteryHealth::Dead,
        Some(5) => BatteryHealth::OverVoltage,
        Some(6) => BatteryHealth::Failure,
        Some(7) => BatteryHealth::Cold,
        _ => BatteryHealth::Unknown,
    };
    let powered = |k: &str| get(k) == Some("true");
    let plugged = if powered("AC powered") {
        Some(PowerSource::Ac)
    } else if powered("USB powered") {
        Some(PowerSource::Usb)
    } else if powered("Wireless powered") {
        Some(PowerSource::Wireless)
    } else if powered("Dock powered") {
        Some(PowerSource::Dock)
    } else {
        None
    };

    Some(Battery {
        level,
        status,
        plugged,
        // Tenths of a degree Celsius.
        temperature_c: get("temperature")
            .and_then(|v| v.parse::<f32>().ok())
            .map(|t| t / 10.0),
        health,
        // Millivolts; some HALs report volts.
        voltage_v: get("voltage")
            .and_then(|v| v.parse::<f32>().ok())
            .filter(|v| *v > 0.0)
            .map(|v| if v > 100.0 { v / 1000.0 } else { v }),
        technology: get("technology")
            .filter(|v| !v.is_empty())
            .map(str::to_owned),
    })
}

// ---------------------------------------------------------------- storage

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Storage {
    pub total_bytes: u64,
    pub used_bytes: u64,
    pub available_bytes: u64,
    pub categories: Option<StorageCategories>,
}

/// Breakdown cached by the system in `dumpsys diskstats` (real devices
/// refresh it daily; emulators usually lack it).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageCategories {
    /// App code, data and cache.
    pub apps: u64,
    pub photos_videos: u64,
    pub audio: u64,
    pub downloads: u64,
    pub system: u64,
    pub other: u64,
}

/// Parses `df -k <path>`: the first data row, sizes in KiB.
pub fn parse_df(output: &str) -> Option<Storage> {
    // Toybox prints one row per line; old toolbox wrapped long device names
    // onto their own line, so join all tokens after the header.
    let mut lines = output.lines().filter(|l| !l.trim().is_empty());
    let header = lines.next()?;
    if !header.contains("Filesystem") {
        return None;
    }
    let tokens: Vec<&str> = lines.flat_map(str::split_whitespace).collect();
    // Filesystem, 1K-blocks, Used, Available, Use%, Mounted on
    let nums: Vec<u64> = tokens
        .iter()
        .skip(1)
        .take(3)
        .map(|t| t.parse().ok())
        .collect::<Option<_>>()?;
    let [total, used, available] = nums[..] else {
        return None;
    };
    Some(Storage {
        total_bytes: total * 1024,
        used_bytes: used * 1024,
        available_bytes: available * 1024,
        categories: None,
    })
}

/// Parses the category sizes from `dumpsys diskstats`, in bytes.
pub fn parse_diskstats(output: &str) -> Option<StorageCategories> {
    let fields = colon_fields(output);
    let size = |k: &str| fields.get(k).and_then(|v| v.parse::<u64>().ok());
    let apps = size("App Size")?;
    Some(StorageCategories {
        apps: apps + size("App Data Size").unwrap_or(0) + size("App Cache Size").unwrap_or(0),
        photos_videos: size("Photos Size").unwrap_or(0) + size("Videos Size").unwrap_or(0),
        audio: size("Audio Size").unwrap_or(0),
        downloads: size("Downloads Size").unwrap_or(0),
        system: size("System Size").unwrap_or(0),
        other: size("Other Size").unwrap_or(0),
    })
}

// ----------------------------------------------------------------- memory

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Memory {
    pub total_bytes: u64,
    pub available_bytes: u64,
    pub free_bytes: u64,
    pub cached_bytes: u64,
    pub swap_total_bytes: u64,
    pub swap_free_bytes: u64,
}

/// Parses `/proc/meminfo` (values in kB).
pub fn parse_meminfo(output: &str) -> Option<Memory> {
    let mut kb: HashMap<&str, u64> = HashMap::new();
    for line in output.lines() {
        let Some((key, rest)) = line.split_once(':') else {
            continue;
        };
        if let Some(v) = rest.split_whitespace().next().and_then(|v| v.parse().ok()) {
            kb.insert(key.trim(), v);
        }
    }
    let get = |k: &str| kb.get(k).copied().unwrap_or(0) * 1024;
    let total = get("MemTotal");
    if total == 0 {
        return None;
    }
    let free = get("MemFree");
    let available = kb
        .get("MemAvailable")
        .map(|v| v * 1024)
        .unwrap_or_else(|| free + get("Cached") + get("Buffers"));
    Some(Memory {
        total_bytes: total,
        available_bytes: available,
        free_bytes: free,
        cached_bytes: get("Cached"),
        swap_total_bytes: get("SwapTotal"),
        swap_free_bytes: get("SwapFree"),
    })
}

// -------------------------------------------------------------------- cpu

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cpu {
    pub cores: Option<u32>,
    pub max_freq_mhz: Option<u32>,
    /// Overall load 0..1 since the previous sample.
    pub load: Option<f32>,
    /// Per-core load 0..1, indexed by core number; `None` for offline cores.
    pub core_loads: Vec<Option<f32>>,
    pub abi: Option<String>,
}

/// One `cpu…` line of `/proc/stat` reduced to busy and total jiffies.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CpuTimes {
    /// `cpu` for the aggregate, `cpu0`… for cores.
    pub name: String,
    pub busy: u64,
    pub total: u64,
}

pub fn parse_proc_stat(output: &str) -> Vec<CpuTimes> {
    output
        .lines()
        .filter(|l| l.starts_with("cpu"))
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let name = parts.next()?.to_owned();
            // user nice system idle iowait irq softirq steal (guest is
            // already counted in user).
            let v: Vec<u64> = parts.take(8).filter_map(|p| p.parse().ok()).collect();
            if v.len() < 4 {
                return None;
            }
            let at = |i: usize| v.get(i).copied().unwrap_or(0);
            let idle = at(3) + at(4);
            let busy = at(0) + at(1) + at(2) + at(5) + at(6) + at(7);
            Some(CpuTimes {
                name,
                busy,
                total: busy + idle,
            })
        })
        .collect()
}

/// Load per CPU line between two samples: `name → 0..1`.
pub fn cpu_load(prev: &[CpuTimes], cur: &[CpuTimes]) -> HashMap<String, f32> {
    cur.iter()
        .filter_map(|c| {
            let p = prev.iter().find(|p| p.name == c.name)?;
            let total = c.total.checked_sub(p.total)?;
            let busy = c.busy.checked_sub(p.busy)?;
            (total > 0).then(|| (c.name.clone(), (busy as f32 / total as f32).clamp(0.0, 1.0)))
        })
        .collect()
}

/// Counts CPUs in a sysfs range list such as `0-3` or `0-3,6-7`.
pub fn parse_cpu_range(output: &str) -> Option<u32> {
    let mut count = 0;
    for part in output.trim().split(',').filter(|p| !p.is_empty()) {
        count += match part.split_once('-') {
            Some((a, b)) => b.trim().parse::<u32>().ok()? - a.trim().parse::<u32>().ok()? + 1,
            None => {
                part.trim().parse::<u32>().ok()?;
                1
            }
        };
    }
    (count > 0).then_some(count)
}

/// Highest `cpuinfo_max_freq` (kHz, one per line) in MHz. Emulators report
/// nonsense such as `2`, so values under 100 MHz are ignored.
pub fn parse_max_freq(output: &str) -> Option<u32> {
    output
        .split_whitespace()
        .filter_map(|v| v.parse::<u64>().ok())
        .filter(|khz| *khz >= 100_000)
        .max()
        .map(|khz| (khz / 1000) as u32)
}

// ---------------------------------------------------------------- thermal

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ThermalStatus {
    None,
    Light,
    Moderate,
    Severe,
    Critical,
    Emergency,
    Shutdown,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Thermal {
    pub status: ThermalStatus,
    pub cpu_c: Option<f32>,
    pub skin_c: Option<f32>,
}

/// Parses `dumpsys thermalservice`. Later temperature lines win, so the
/// "Current temperatures from HAL" block overrides the cached one.
pub fn parse_thermal(output: &str) -> Option<Thermal> {
    let status = output.lines().find_map(|l| {
        l.trim()
            .strip_prefix("Thermal Status:")
            .and_then(|v| v.trim().parse::<u8>().ok())
    })?;
    let status = match status {
        0 => ThermalStatus::None,
        1 => ThermalStatus::Light,
        2 => ThermalStatus::Moderate,
        3 => ThermalStatus::Severe,
        4 => ThermalStatus::Critical,
        5 => ThermalStatus::Emergency,
        _ => ThermalStatus::Shutdown,
    };
    let mut cpu: Option<f32> = None;
    let mut skin = None;
    for line in output.lines() {
        let Some(body) = line.trim().strip_prefix("Temperature{") else {
            continue;
        };
        let value = field_after(body, "mValue=").and_then(|v| v.parse::<f32>().ok());
        let kind = field_after(body, "mType=").and_then(|v| v.parse::<i32>().ok());
        match (kind, value) {
            // TYPE_CPU: hottest core.
            (Some(0), Some(v)) if !v.is_nan() => cpu = Some(cpu.map_or(v, |c| c.max(v))),
            (Some(3), Some(v)) if !v.is_nan() => skin = Some(v),
            _ => {}
        }
    }
    Some(Thermal {
        status,
        cpu_c: cpu,
        skin_c: skin,
    })
}

// ---------------------------------------------------------------- display

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Size {
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Display {
    pub physical_size: Option<Size>,
    pub override_size: Option<Size>,
    pub physical_density: Option<u32>,
    pub override_density: Option<u32>,
    pub refresh_rate: Option<f32>,
    pub max_refresh_rate: Option<f32>,
    pub font_scale: Option<f32>,
}

/// Parses `wm size`: `Physical size: 1280x2856` and optional
/// `Override size: 1080x2400`.
pub fn parse_wm_size(output: &str) -> (Option<Size>, Option<Size>) {
    let size = |prefix: &str| {
        output.lines().find_map(|l| {
            let (w, h) = l.trim().strip_prefix(prefix)?.trim().split_once('x')?;
            Some(Size {
                width: w.trim().parse().ok()?,
                height: h.trim().parse().ok()?,
            })
        })
    };
    (size("Physical size:"), size("Override size:"))
}

/// Parses `wm density`: `Physical density: 480`, `Override density: 420`.
pub fn parse_wm_density(output: &str) -> (Option<u32>, Option<u32>) {
    let density = |prefix: &str| {
        output
            .lines()
            .find_map(|l| l.trim().strip_prefix(prefix)?.trim().parse().ok())
    };
    (density("Physical density:"), density("Override density:"))
}

/// Current and highest refresh rate from `dumpsys display`.
pub fn parse_refresh_rate(output: &str) -> (Option<f32>, Option<f32>) {
    let current = field_after(output, "mActiveRenderFrameRate=")
        .or_else(|| field_after(output, "renderFrameRate "))
        .and_then(|v| v.parse::<f32>().ok());
    let max = output
        .find("supportedRefreshRates [")
        .map(|i| &output[i + "supportedRefreshRates [".len()..])
        .and_then(|rest| rest.split_once(']'))
        .and_then(|(list, _)| {
            list.split(',')
                .filter_map(|v| v.trim().parse::<f32>().ok())
                .reduce(f32::max)
        });
    (current, max.or(current))
}

// ---------------------------------------------------------------- network

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Network {
    pub wifi_enabled: Option<bool>,
    pub ssid: Option<String>,
    pub ip: Option<String>,
    pub rssi_dbm: Option<i32>,
    pub frequency_mhz: Option<u32>,
    pub link_speed_mbps: Option<u32>,
    pub mobile_operator: Option<String>,
    pub mobile_type: Option<String>,
}

/// Parses `cmd wifi status` (Android 11+).
pub fn parse_wifi_status(output: &str) -> Network {
    let mut net = Network::default();
    if output.contains("Wifi is enabled") {
        net.wifi_enabled = Some(true);
    } else if output.contains("Wifi is disabled") {
        net.wifi_enabled = Some(false);
    }
    let Some(info) = output.find("WifiInfo:").map(|i| &output[i..]) else {
        return net;
    };
    net.ssid = field_after(info, "SSID: ")
        .map(|s| s.trim_matches('"').to_owned())
        .filter(|s| !s.is_empty() && s != "<unknown ssid>");
    net.ip = field_after(info, "IP: ")
        .map(|s| s.trim_start_matches('/').to_owned())
        .filter(|s| !s.is_empty() && s != "0.0.0.0");
    net.rssi_dbm = field_after(info, "RSSI: ")
        .and_then(|v| v.parse().ok())
        .filter(|v| *v > -127);
    net.link_speed_mbps = field_after(info, "Link speed: ")
        .and_then(|v| v.trim_end_matches("Mbps").parse().ok())
        .filter(|v: &u32| *v > 0);
    net.frequency_mhz = field_after(info, "Frequency: ")
        .and_then(|v| v.trim_end_matches("MHz").parse().ok())
        .filter(|v: &u32| *v > 0);
    if net.ssid.is_none() {
        net.ip = None;
    }
    net
}

/// First IPv4 address in `ip addr show <iface>` output.
pub fn parse_ipv4(output: &str) -> Option<String> {
    output.lines().find_map(|line| {
        let mut parts = line.split_whitespace();
        parts.find(|p| *p == "inet")?;
        let addr = parts.next()?.split('/').next()?;
        Some(addr.to_owned())
    })
}

// ----------------------------------------------------------------- others

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RootStatus {
    /// adbd runs as root (`adb root`, userdebug builds).
    AdbRoot,
    /// An `su` binary is available.
    Su,
    None,
}

pub fn parse_root(uid: &str, su: &str) -> RootStatus {
    if uid.trim() == "0" {
        RootStatus::AdbRoot
    } else if !su.trim().is_empty() {
        RootStatus::Su
    } else {
        RootStatus::None
    }
}

/// Seconds since boot from `/proc/uptime`.
pub fn parse_uptime(output: &str) -> Option<f64> {
    output.split_whitespace().next()?.parse().ok()
}

fn build_facts(props: &HashMap<String, String>) -> BuildFacts {
    let get = |k: &str| props.get(k).filter(|v| !v.is_empty()).cloned();
    let soc = match (get("ro.soc.manufacturer"), get("ro.soc.model")) {
        (Some(m), Some(model)) if !model.starts_with(&m) => Some(format!("{m} {model}")),
        (_, Some(model)) => Some(model),
        _ => get("ro.hardware"),
    };
    BuildFacts {
        brand: get("ro.product.brand"),
        device: get("ro.product.device"),
        build_id: get("ro.build.id"),
        build_type: get("ro.build.type"),
        incremental: get("ro.build.version.incremental"),
        soc,
        locale: get("persist.sys.locale").or_else(|| get("ro.product.locale")),
    }
}

/// First non-empty entry of a comma-separated per-SIM property.
fn first_sim_value(value: Option<&String>) -> Option<String> {
    value?
        .split(',')
        .map(str::trim)
        .find(|v| !v.is_empty() && !v.eq_ignore_ascii_case("unknown"))
        .map(str::to_owned)
}

// ----------------------------------------------------------------- driver

const SECTIONS: &[(&str, &str)] = &[
    ("battery", "dumpsys battery"),
    ("df", "df -k /data"),
    ("diskstats", "dumpsys diskstats"),
    ("meminfo", "cat /proc/meminfo"),
    ("stat", "cat /proc/stat"),
    ("possible", "cat /sys/devices/system/cpu/possible"),
    (
        "maxfreq",
        "cat /sys/devices/system/cpu/cpu*/cpufreq/cpuinfo_max_freq",
    ),
    ("thermal", "dumpsys thermalservice"),
    ("wmsize", "wm size"),
    ("wmdensity", "wm density"),
    (
        "display",
        "dumpsys display | grep -E 'mActiveRenderFrameRate=|supportedRefreshRates' | head -n 3",
    ),
    ("font", "settings get system font_scale"),
    ("wifi", "cmd wifi status"),
    ("ip", "ip -4 addr show wlan0"),
    ("uptime", "cat /proc/uptime"),
    ("uid", "id -u"),
    ("su", "command -v su"),
    ("props", "getprop"),
];

/// Takes a snapshot. `prev_cpu` is the `/proc/stat` sample returned by the
/// previous call; without it a second sample is taken after a short pause
/// so the first snapshot already has a CPU load. Returns the snapshot and
/// the sample to pass next time.
pub async fn snapshot(
    server: &AdbServer,
    serial: &str,
    prev_cpu: Option<Vec<CpuTimes>>,
) -> AppResult<(DeviceSnapshot, Vec<CpuTimes>)> {
    let out = sections::run(server, serial, SECTIONS).await?;
    let section = |name: &str| out.get(name).map(String::as_str).unwrap_or("");

    let mut stat = parse_proc_stat(section("stat"));
    let prev = match prev_cpu {
        Some(prev) => prev,
        None => {
            tokio::time::sleep(Duration::from_millis(300)).await;
            let first = std::mem::take(&mut stat);
            stat = parse_proc_stat(&server.exec_text(serial, "cat /proc/stat").await?);
            first
        }
    };
    let loads = cpu_load(&prev, &stat);
    let cores = parse_cpu_range(section("possible"))
        .or_else(|| Some(stat.iter().filter(|c| c.name != "cpu").count() as u32))
        .filter(|n| *n > 0);
    let core_loads = (0..cores.unwrap_or(0))
        .map(|i| loads.get(&format!("cpu{i}")).copied())
        .collect();

    let props = parse_getprop(section("props"));
    let info = DeviceInfo::from_props(&props);

    let mut storage = parse_df(section("df"));
    if let Some(storage) = storage.as_mut() {
        storage.categories = parse_diskstats(section("diskstats"));
    }

    let (physical_size, override_size) = parse_wm_size(section("wmsize"));
    let (physical_density, override_density) = parse_wm_density(section("wmdensity"));
    let (refresh_rate, max_refresh_rate) = parse_refresh_rate(section("display"));
    let font_scale = section("font").trim().parse::<f32>().ok();

    let mut network = parse_wifi_status(section("wifi"));
    if network.ip.is_none() && network.wifi_enabled != Some(false) {
        network.ip = parse_ipv4(section("ip"));
    }
    network.mobile_operator = first_sim_value(props.get("gsm.operator.alpha"));
    network.mobile_type = first_sim_value(props.get("gsm.network.type"));

    let snapshot = DeviceSnapshot {
        build: build_facts(&props),
        battery: parse_battery(section("battery")),
        storage,
        memory: parse_meminfo(section("meminfo")),
        cpu: Cpu {
            cores,
            max_freq_mhz: parse_max_freq(section("maxfreq")),
            load: loads.get("cpu").copied(),
            core_loads,
            abi: info.abi.clone(),
        },
        thermal: parse_thermal(section("thermal")),
        display: Display {
            physical_size,
            override_size,
            physical_density,
            override_density,
            refresh_rate,
            max_refresh_rate,
            font_scale,
        },
        network,
        uptime_secs: parse_uptime(section("uptime")),
        root: parse_root(section("uid"), section("su")),
        info,
        taken_at: now_ms(),
    };
    Ok((snapshot, stat))
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------- helpers

/// `key: value` lines (dumpsys style), keys trimmed.
fn colon_fields(output: &str) -> HashMap<String, String> {
    output
        .lines()
        .filter_map(|l| {
            let (k, v) = l.split_once(':')?;
            Some((k.trim().to_owned(), v.trim().to_owned()))
        })
        .collect()
}

/// The value after `key` up to the next `,`, `}` or line end.
fn field_after<'a>(text: &'a str, key: &str) -> Option<&'a str> {
    let start = text.find(key)? + key.len();
    let rest = &text[start..];
    let end = rest.find([',', '}', '\n', '\r']).unwrap_or(rest.len());
    Some(rest[..end].trim())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Captured from an Android 16 (SDK 36) arm64 emulator.
    const BATTERY: &str = include_str!("testdata/emu36/battery.txt");
    const DF: &str = include_str!("testdata/emu36/df.txt");
    const MEMINFO: &str = include_str!("testdata/emu36/meminfo.txt");
    const STAT: &str = include_str!("testdata/emu36/stat.txt");
    const WM_SIZE: &str = include_str!("testdata/emu36/wm_size.txt");
    const WM_DENSITY: &str = include_str!("testdata/emu36/wm_density.txt");
    const DISPLAY: &str = include_str!("testdata/emu36/display.txt");
    const WIFI: &str = include_str!("testdata/emu36/cmdwifi.txt");
    const IP: &str = include_str!("testdata/emu36/ipaddr.txt");
    const THERMAL: &str = include_str!("testdata/emu36/thermal.txt");
    const UPTIME: &str = include_str!("testdata/emu36/uptime.txt");
    const POSSIBLE: &str = include_str!("testdata/emu36/cpu_possible.txt");
    const GETPROP: &str = include_str!("testdata/emu36/getprop.txt");

    #[test]
    fn battery_from_emulator() {
        let b = parse_battery(BATTERY).unwrap();
        assert_eq!(b.level, Some(100));
        assert_eq!(b.status, BatteryStatus::NotCharging);
        assert_eq!(b.health, BatteryHealth::Good);
        assert_eq!(b.plugged, None);
        assert_eq!(b.temperature_c, Some(25.0));
        assert_eq!(b.voltage_v, Some(5.0));
        assert_eq!(b.technology.as_deref(), Some("Li-ion"));
    }

    #[test]
    fn battery_charging_over_usb() {
        // Pixel 8 Pro, Android 15.
        let out = "Current Battery Service state:\n  AC powered: false\n  USB powered: true\n  \
                   Wireless powered: false\n  status: 2\n  health: 2\n  present: true\n  \
                   level: 82\n  scale: 100\n  voltage: 4210\n  temperature: 314\n  \
                   technology: Li-ion\n";
        let b = parse_battery(out).unwrap();
        assert_eq!(b.level, Some(82));
        assert_eq!(b.status, BatteryStatus::Charging);
        assert_eq!(b.plugged, Some(PowerSource::Usb));
        assert!((b.temperature_c.unwrap() - 31.4).abs() < 1e-4);
        assert!((b.voltage_v.unwrap() - 4.21).abs() < 1e-4);
    }

    #[test]
    fn battery_missing() {
        assert_eq!(parse_battery("Can't find service: battery\n"), None);
    }

    #[test]
    fn df_from_emulator() {
        let s = parse_df(DF).unwrap();
        assert_eq!(s.total_bytes, 6_082_144 * 1024);
        assert_eq!(s.used_bytes, 3_088_404 * 1024);
        assert_eq!(s.available_bytes, 2_851_528 * 1024);
    }

    #[test]
    fn df_with_wrapped_device_name() {
        let out = "Filesystem               1K-blocks     Used Available Use% Mounted on\n\
                   /dev/block/bootdevice/by-name/userdata\n\
                   \x20                        54470052 31234560  23104092  58% /data\n";
        let s = parse_df(out).unwrap();
        assert_eq!(s.total_bytes, 54_470_052 * 1024);
    }

    #[test]
    fn diskstats_categories() {
        // Pixel 7, Android 14 (emulators do not compute the categories).
        let out = "Latency: 2ms [512B Data Write]\n\
                   Data-Free: 81234560K / 115234560K total = 70% free\n\
                   App Size: 6912329728\nApp Data Size: 3141066752\nApp Cache Size: 391307264\n\
                   Photos Size: 1020194816\nVideos Size: 116445184\nAudio Size: 0\n\
                   Downloads Size: 4362240\nSystem Size: 13008420864\nOther Size: 1173041152\n";
        let c = parse_diskstats(out).unwrap();
        assert_eq!(c.apps, 6_912_329_728 + 3_141_066_752 + 391_307_264);
        assert_eq!(c.photos_videos, 1_020_194_816 + 116_445_184);
        assert_eq!(c.system, 13_008_420_864);
        assert_eq!(c.downloads, 4_362_240);
    }

    #[test]
    fn diskstats_without_categories() {
        let out =
            "Latency: 0ms [512B Data Write]\nData-Free: 2845840K / 6082144K total = 46% free\n";
        assert_eq!(parse_diskstats(out), None);
    }

    #[test]
    fn meminfo_from_emulator() {
        let m = parse_meminfo(MEMINFO).unwrap();
        assert_eq!(m.total_bytes, 4_010_748 * 1024);
        assert_eq!(m.available_bytes, 1_916_784 * 1024);
        assert_eq!(m.swap_total_bytes, 3_008_056 * 1024);
        assert_eq!(m.swap_free_bytes, 2_349_212 * 1024);
    }

    #[test]
    fn proc_stat_and_load() {
        let first = parse_proc_stat(STAT);
        assert_eq!(first.len(), 5);
        assert_eq!(first[0].name, "cpu");
        // user nice system idle iowait irq softirq
        assert_eq!(first[0].busy, 9882 + 2721 + 51344 + 16037 + 723);
        assert_eq!(first[0].total, first[0].busy + 329_049 + 2864);

        let mut second = first.clone();
        second[0].busy += 25;
        second[0].total += 100;
        second[1].total += 50;
        let loads = cpu_load(&first, &second);
        assert!((loads["cpu"] - 0.25).abs() < 1e-6);
        assert_eq!(loads["cpu0"], 0.0);
        assert!(!loads.contains_key("cpu1"));
    }

    #[test]
    fn cpu_ranges() {
        assert_eq!(parse_cpu_range(POSSIBLE), Some(4));
        assert_eq!(parse_cpu_range("0-3,6-7\n"), Some(6));
        assert_eq!(parse_cpu_range("0\n"), Some(1));
        assert_eq!(parse_cpu_range(""), None);
    }

    #[test]
    fn max_freq_ignores_emulator_garbage() {
        assert_eq!(parse_max_freq("2\n2\n2\n2\n"), None);
        assert_eq!(parse_max_freq("1704000\n2367000\n2914000\n"), Some(2914));
    }

    #[test]
    fn thermal_from_emulator() {
        let t = parse_thermal(THERMAL).unwrap();
        assert_eq!(t.status, ThermalStatus::None);
        assert_eq!(t.skin_c, Some(30.1));
        assert_eq!(t.cpu_c, None);
    }

    #[test]
    fn thermal_takes_hottest_cpu() {
        let out = "Thermal Status: 1\nCurrent temperatures from HAL:\n\
                   \tTemperature{mValue=41.5, mType=0, mName=BIG, mStatus=0}\n\
                   \tTemperature{mValue=38.0, mType=0, mName=LITTLE, mStatus=0}\n";
        let t = parse_thermal(out).unwrap();
        assert_eq!(t.status, ThermalStatus::Light);
        assert_eq!(t.cpu_c, Some(41.5));
    }

    #[test]
    fn wm_size_and_density() {
        assert_eq!(
            parse_wm_size(WM_SIZE),
            (
                Some(Size {
                    width: 1280,
                    height: 2856
                }),
                None
            )
        );
        assert_eq!(parse_wm_density(WM_DENSITY), (Some(480), None));
        let (_, over) = parse_wm_size("Physical size: 1344x2992\nOverride size: 1080x2400\n");
        assert_eq!(
            over,
            Some(Size {
                width: 1080,
                height: 2400
            })
        );
        assert_eq!(
            parse_wm_density("Physical density: 480\nOverride density: 420\n"),
            (Some(480), Some(420))
        );
    }

    #[test]
    fn refresh_rate_from_emulator() {
        let (cur, max) = parse_refresh_rate(DISPLAY);
        assert!((cur.unwrap() - 60.0).abs() < 0.01);
        assert!((max.unwrap() - 60.0).abs() < 0.01);
    }

    #[test]
    fn refresh_rate_ltpo_panel() {
        let out = "mActiveRenderFrameRate=120.0\n  DisplayDeviceInfo{..., renderFrameRate 120.0, \
                   supportedRefreshRates [1.0, 10.0, 60.0, 120.0], defaultModeId 1}\n";
        assert_eq!(parse_refresh_rate(out), (Some(120.0), Some(120.0)));
    }

    #[test]
    fn wifi_from_emulator() {
        let n = parse_wifi_status(WIFI);
        assert_eq!(n.wifi_enabled, Some(true));
        assert_eq!(n.ssid.as_deref(), Some("AndroidWifi"));
        assert_eq!(n.ip.as_deref(), Some("10.0.2.16"));
        assert_eq!(n.rssi_dbm, Some(-50));
        assert_eq!(n.frequency_mhz, Some(2437));
        assert_eq!(n.link_speed_mbps, Some(2));
    }

    #[test]
    fn wifi_disabled() {
        let n = parse_wifi_status(
            "Wifi is disabled\nWifi scanning is only available when wifi is enabled\n",
        );
        assert_eq!(n.wifi_enabled, Some(false));
        assert_eq!(n.ssid, None);
    }

    #[test]
    fn ipv4_from_ip_addr() {
        assert_eq!(parse_ipv4(IP).as_deref(), Some("10.0.2.16"));
        assert_eq!(parse_ipv4(""), None);
    }

    #[test]
    fn root_and_uptime() {
        assert_eq!(parse_root("2000\n", "/system/xbin/su\n"), RootStatus::Su);
        assert_eq!(parse_root("0\n", ""), RootStatus::AdbRoot);
        assert_eq!(parse_root("2000\n", ""), RootStatus::None);
        assert_eq!(parse_uptime(UPTIME), Some(1041.03));
    }

    #[test]
    fn build_facts_from_emulator() {
        let props = parse_getprop(GETPROP);
        let b = build_facts(&props);
        assert_eq!(b.soc.as_deref(), Some("AOSP ranchu"));
        assert_eq!(b.build_id.as_deref(), Some("BE4B.251210.005"));
        assert_eq!(b.build_type.as_deref(), Some("userdebug"));
        assert_eq!(b.device.as_deref(), Some("emu64a"));
        assert_eq!(b.locale.as_deref(), Some("en-US"));
        assert_eq!(
            first_sim_value(props.get("gsm.network.type")).as_deref(),
            Some("NR_SA")
        );
        assert_eq!(
            first_sim_value(Some(&",Beeline".to_owned())).as_deref(),
            Some("Beeline")
        );
    }

    #[test]
    fn soc_prefers_model_with_vendor() {
        let props: HashMap<String, String> = [
            ("ro.soc.manufacturer", "Google"),
            ("ro.soc.model", "Tensor G3"),
            ("ro.hardware", "husky"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_owned(), v.to_owned()))
        .collect();
        assert_eq!(build_facts(&props).soc.as_deref(), Some("Google Tensor G3"));
    }
}
