//! Live performance sampling (`/proc/stat`, `/proc/meminfo`,
//! `/proc/net/dev`, `dumpsys battery`, `dumpsys gfxinfo`) and the process
//! list (`top`). One `exec:` round trip per sample.

use std::collections::HashMap;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::adb::server::AdbServer;
use crate::adb::shell_v2;
use crate::error::{AppError, AppResult};

// ---------------------------------------------------------------- CPU

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CpuTimes {
    pub busy: u64,
    pub idle: u64,
}

impl CpuTimes {
    /// Busy share in percent between two snapshots.
    pub fn usage_since(&self, prev: &CpuTimes) -> Option<f32> {
        let busy = self.busy.checked_sub(prev.busy)?;
        let idle = self.idle.checked_sub(prev.idle)?;
        let total = busy + idle;
        (total > 0).then(|| (busy as f64 / total as f64 * 100.0) as f32)
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProcStat {
    pub total: CpuTimes,
    /// Online cores by index (`cpu3` → 3).
    pub cores: Vec<(u32, CpuTimes)>,
}

fn parse_cpu_fields(fields: &[u64]) -> CpuTimes {
    // user nice system idle iowait irq softirq steal [guest guest_nice]
    // guest time is already part of user, so it is not added again.
    let get = |i: usize| fields.get(i).copied().unwrap_or(0);
    let idle = get(3) + get(4);
    let busy = get(0) + get(1) + get(2) + get(5) + get(6) + get(7);
    CpuTimes { busy, idle }
}

pub fn parse_proc_stat(text: &str) -> ProcStat {
    let mut stat = ProcStat::default();
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        let Some(name) = parts.next() else { continue };
        let Some(rest) = name.strip_prefix("cpu") else {
            continue;
        };
        let fields: Vec<u64> = parts.filter_map(|p| p.parse().ok()).collect();
        let times = parse_cpu_fields(&fields);
        if rest.is_empty() {
            stat.total = times;
        } else if let Ok(id) = rest.parse() {
            stat.cores.push((id, times));
        }
    }
    stat
}

/// Groups cores by `cpuinfo_max_freq` into clusters, slowest first, and
/// returns how many cores each cluster has (`[4, 4, 1]`).
pub fn clusters(max_freqs: &[u64]) -> Vec<u32> {
    let mut counts: Vec<(u64, u32)> = Vec::new();
    for &f in max_freqs {
        match counts.iter_mut().find(|(freq, _)| *freq == f) {
            Some((_, n)) => *n += 1,
            None => counts.push((f, 1)),
        }
    }
    counts.sort_by_key(|(f, _)| *f);
    counts.into_iter().map(|(_, n)| n).collect()
}

// ---------------------------------------------------------------- memory

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Memory {
    pub total_kb: u64,
    pub available_kb: u64,
    pub used_kb: u64,
    pub swap_total_kb: u64,
    pub swap_used_kb: u64,
}

pub fn parse_meminfo(text: &str) -> Memory {
    let values: HashMap<&str, u64> = text
        .lines()
        .filter_map(|line| {
            let (key, rest) = line.split_once(':')?;
            let value = rest.split_whitespace().next()?.parse().ok()?;
            Some((key.trim(), value))
        })
        .collect();
    let get = |k: &str| values.get(k).copied().unwrap_or(0);
    let total = get("MemTotal");
    // MemAvailable exists since Linux 3.14; estimate on older kernels.
    let available = values
        .get("MemAvailable")
        .copied()
        .unwrap_or_else(|| get("MemFree") + get("Buffers") + get("Cached"));
    let swap_total = get("SwapTotal");
    Memory {
        total_kb: total,
        available_kb: available,
        used_kb: total.saturating_sub(available),
        swap_total_kb: swap_total,
        swap_used_kb: swap_total.saturating_sub(get("SwapFree")),
    }
}

// ---------------------------------------------------------------- network

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NetIface {
    pub name: String,
    pub rx_bytes: u64,
    pub tx_bytes: u64,
}

pub fn parse_net_dev(text: &str) -> Vec<NetIface> {
    text.lines()
        .filter_map(|line| {
            let (name, rest) = line.split_once(':')?;
            let fields: Vec<u64> = rest
                .split_whitespace()
                .map(|f| f.parse().ok())
                .collect::<Option<_>>()?;
            if fields.len() < 9 {
                return None;
            }
            Some(NetIface {
                name: name.trim().to_owned(),
                rx_bytes: fields[0],
                tx_bytes: fields[8],
            })
        })
        .collect()
}

/// Totals over real interfaces (not loopback) and the busiest one's name.
pub fn net_totals(ifaces: &[NetIface]) -> (u64, u64, Option<String>) {
    let real = ifaces.iter().filter(|i| i.name != "lo");
    let rx = real.clone().map(|i| i.rx_bytes).sum();
    let tx = real.clone().map(|i| i.tx_bytes).sum();
    let primary = real
        .filter(|i| i.rx_bytes + i.tx_bytes > 0)
        .max_by_key(|i| i.rx_bytes + i.tx_bytes)
        .map(|i| i.name.clone());
    (rx, tx, primary)
}

// ---------------------------------------------------------------- battery

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Battery {
    pub level: Option<u32>,
    pub temperature_c: Option<f32>,
    pub voltage_mv: Option<u32>,
    /// Positive or negative as the driver reports it; `None` when the
    /// device does not expose `current_now` to the shell user.
    pub current_ma: Option<f32>,
    pub charging: bool,
    pub plugged: bool,
}

pub fn parse_dumpsys_battery(text: &str) -> Battery {
    let mut battery = Battery::default();
    for line in text.lines() {
        let Some((key, value)) = line.trim().split_once(": ") else {
            continue;
        };
        let value = value.trim();
        match key {
            "level" => battery.level = value.parse().ok(),
            "temperature" => {
                battery.temperature_c = value.parse::<f32>().ok().map(|t| t / 10.0);
            }
            "voltage" => battery.voltage_mv = value.parse().ok(),
            // BatteryManager.BATTERY_STATUS_CHARGING = 2
            "status" => battery.charging = value == "2",
            "AC powered" | "USB powered" | "Wireless powered" | "Dock powered" => {
                battery.plugged |= value == "true";
            }
            _ => {}
        }
    }
    battery
}

/// `current_now` is µA on almost every device; a few report mA.
pub fn parse_current_now(text: &str) -> Option<f32> {
    let raw: f64 = text.trim().parse().ok()?;
    let ma = if raw.abs() > 20_000.0 {
        raw / 1000.0
    } else {
        raw
    };
    Some(ma as f32)
}

// ---------------------------------------------------------------- frames

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct GfxStats {
    pub total_frames: u64,
    pub janky_frames: u64,
    pub p95_ms: Option<u32>,
}

/// First (process-level) summary of `dumpsys gfxinfo <package>`.
pub fn parse_gfxinfo(text: &str) -> Option<GfxStats> {
    let mut total = None;
    let mut janky = None;
    let mut p95 = None;
    for line in text.lines().map(str::trim) {
        if let Some(v) = line.strip_prefix("Total frames rendered: ") {
            if total.is_some() {
                break;
            }
            total = v.trim().parse().ok();
        } else if let Some(v) = line.strip_prefix("Janky frames: ") {
            janky = janky.or_else(|| v.split_whitespace().next()?.parse().ok());
        } else if let Some(v) = line.strip_prefix("95th percentile: ") {
            p95 = p95.or_else(|| v.trim().trim_end_matches("ms").parse().ok());
        }
    }
    Some(GfxStats {
        total_frames: total?,
        janky_frames: janky.unwrap_or(0),
        p95_ms: p95,
    })
}

/// `TOTAL PSS:   117499            TOTAL RSS: …` from `dumpsys meminfo`.
pub fn parse_total_pss(text: &str) -> Option<u64> {
    let rest = text.split("TOTAL PSS:").nth(1)?;
    rest.split_whitespace().next()?.parse().ok()
}

// ---------------------------------------------------------------- processes

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Process {
    pub pid: u32,
    pub user: String,
    pub cpu: f32,
    pub rss_kb: u64,
    pub state: String,
    pub name: String,
}

pub const TOP_COMMAND: &str = "top -b -n 1 -q -o PID,USER,%CPU,RSS,S,NAME";

/// Parses `top -b -n 1 [-q] -o PID,USER,%CPU,RSS,S,NAME`. Header lines
/// (present without `-q`) are skipped because their first column is not
/// a number.
pub fn parse_top(text: &str) -> Vec<Process> {
    text.lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let pid = parts.next()?.parse().ok()?;
            let user = parts.next()?.to_owned();
            let cpu = parts.next()?.parse().ok()?;
            let rss_kb = parts.next()?.parse().ok()?;
            let state = parts.next()?.to_owned();
            let name = parts.collect::<Vec<_>>().join(" ");
            if name.is_empty() {
                return None;
            }
            Some(Process {
                pid,
                user,
                cpu,
                rss_kb,
                state,
                name,
            })
        })
        .collect()
}

pub async fn processes(server: &AdbServer, serial: &str) -> AppResult<Vec<Process>> {
    let out = server.exec_text(serial, TOP_COMMAND).await?;
    Ok(parse_top(&out))
}

pub fn is_package_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 255
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_')
}

/// `am force-stop <package>` when a package is given (the only way to stop
/// another app's process without root), otherwise `kill <pid>`.
pub async fn kill(
    server: &AdbServer,
    serial: &str,
    pid: u32,
    package: Option<&str>,
) -> AppResult<()> {
    let command = match package {
        Some(pkg) if is_package_name(pkg) => format!("am force-stop {pkg}"),
        Some(pkg) => return Err(AppError::InvalidInput(format!("bad package {pkg:?}"))),
        None => format!("kill {pid}"),
    };
    let out = shell_v2::run(server, serial, &command).await?;
    let text = format!("{}{}", out.stdout, out.stderr);
    if out.exit_code.is_some_and(|c| c != 0) || text.contains("Operation not permitted") {
        let message = text
            .lines()
            .map(str::trim)
            .find(|l| !l.is_empty())
            .unwrap_or("kill failed")
            .to_owned();
        return Err(AppError::Device(message));
    }
    Ok(())
}

// ---------------------------------------------------------------- sampler

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Network {
    pub iface: Option<String>,
    pub rx_bytes_per_sec: f64,
    pub tx_bytes_per_sec: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Frames {
    pub fps: f32,
    /// Janky share over the last interval, percent.
    pub janky_percent: Option<f32>,
    pub p95_ms: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PerfSample {
    /// Milliseconds since the Unix epoch.
    pub time: u64,
    pub cpu: Option<f32>,
    pub cores: Vec<f32>,
    pub memory: Memory,
    pub network: Option<Network>,
    pub battery: Battery,
    pub frames: Option<Frames>,
    pub package_pss_kb: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CpuInfo {
    pub cores: u32,
    pub clusters: Vec<u32>,
}

/// Measures PSS only every Nth sample: `dumpsys meminfo` is slow.
const PSS_EVERY: u32 = 5;

pub struct Sampler {
    package: Option<String>,
    prev_cpu: Option<ProcStat>,
    prev_net: Option<(Instant, u64, u64)>,
    prev_gfx: Option<(Instant, GfxStats)>,
    last_pss: Option<u64>,
    tick: u32,
}

/// Splits `@@name` sections of the combined sampling command.
fn sections(text: &str) -> HashMap<&str, &str> {
    let mut out = HashMap::new();
    let mut name = "stat";
    let mut start = 0;
    let mut offset = 0;
    for line in text.split_inclusive('\n') {
        let trimmed = line.trim_end();
        if let Some(next) = trimmed.strip_prefix("@@") {
            out.insert(name, &text[start..offset]);
            name = next;
            start = offset + line.len();
        }
        offset += line.len();
    }
    out.insert(name, &text[start..]);
    out
}

impl Sampler {
    pub fn new(package: Option<String>) -> AppResult<Self> {
        if let Some(pkg) = &package
            && !is_package_name(pkg)
        {
            return Err(AppError::InvalidInput(format!("bad package {pkg:?}")));
        }
        Ok(Self {
            package,
            prev_cpu: None,
            prev_net: None,
            prev_gfx: None,
            last_pss: None,
            tick: 0,
        })
    }

    pub fn command(&self) -> String {
        let mut cmd = String::from(
            "cat /proc/stat; echo @@mem; cat /proc/meminfo; echo @@net; cat /proc/net/dev; \
             echo @@bat; dumpsys battery; echo @@cur; \
             cat /sys/class/power_supply/battery/current_now 2>/dev/null",
        );
        if let Some(pkg) = &self.package {
            cmd.push_str(&format!(
                "; echo @@gfx; dumpsys gfxinfo {pkg} | grep -m 3 -E \
                 '^(Total frames rendered|Janky frames|95th percentile):'"
            ));
            if self.tick.is_multiple_of(PSS_EVERY) {
                cmd.push_str(&format!(
                    "; echo @@pss; dumpsys meminfo {pkg} | grep -m 1 'TOTAL PSS'"
                ));
            }
        }
        cmd
    }

    /// Turns one command output into a sample, keeping state for deltas.
    pub fn ingest(&mut self, text: &str, now: Instant, time: u64) -> PerfSample {
        let parts = sections(text);
        let get = |k: &str| parts.get(k).copied().unwrap_or("");

        let stat = parse_proc_stat(get("stat"));
        let (cpu, cores) = match &self.prev_cpu {
            Some(prev) => {
                let cores = stat
                    .cores
                    .iter()
                    .map(|(id, t)| {
                        prev.cores
                            .iter()
                            .find(|(pid, _)| pid == id)
                            .and_then(|(_, p)| t.usage_since(p))
                            .unwrap_or(0.0)
                    })
                    .collect();
                (stat.total.usage_since(&prev.total), cores)
            }
            None => (None, Vec::new()),
        };
        self.prev_cpu = Some(stat);

        let (rx, tx, iface) = net_totals(&parse_net_dev(get("net")));
        let network = self.prev_net.and_then(|(at, prx, ptx)| {
            let dt = now.duration_since(at).as_secs_f64();
            (dt > 0.0).then(|| Network {
                iface: iface.clone(),
                rx_bytes_per_sec: rx.saturating_sub(prx) as f64 / dt,
                tx_bytes_per_sec: tx.saturating_sub(ptx) as f64 / dt,
            })
        });
        self.prev_net = Some((now, rx, tx));

        let mut battery = parse_dumpsys_battery(get("bat"));
        battery.current_ma = parse_current_now(get("cur"));

        let frames = match parse_gfxinfo(get("gfx")) {
            Some(gfx) => {
                let frames = self.prev_gfx.and_then(|(at, prev)| {
                    let dt = now.duration_since(at).as_secs_f64();
                    // A restarted process resets its counters.
                    let frames = gfx.total_frames.checked_sub(prev.total_frames)?;
                    let janky = gfx.janky_frames.saturating_sub(prev.janky_frames);
                    (dt > 0.0).then(|| Frames {
                        fps: (frames as f64 / dt) as f32,
                        janky_percent: (frames > 0)
                            .then(|| (janky as f64 / frames as f64 * 100.0) as f32),
                        p95_ms: gfx.p95_ms,
                    })
                });
                self.prev_gfx = Some((now, gfx));
                frames
            }
            None => {
                self.prev_gfx = None;
                None
            }
        };

        if self.package.is_some() && self.tick.is_multiple_of(PSS_EVERY) {
            self.last_pss = parse_total_pss(get("pss"));
        }
        self.tick = self.tick.wrapping_add(1);

        PerfSample {
            time,
            cpu,
            cores,
            memory: parse_meminfo(get("mem")),
            network,
            battery,
            frames,
            package_pss_kb: self.package.as_ref().and(self.last_pss),
        }
    }

    pub async fn sample(&mut self, server: &AdbServer, serial: &str) -> AppResult<PerfSample> {
        let out = server.exec_text(serial, &self.command()).await?;
        let time = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        Ok(self.ingest(&out, Instant::now(), time))
    }
}

pub async fn cpu_info(server: &AdbServer, serial: &str) -> AppResult<CpuInfo> {
    let out = server
        .exec_text(
            serial,
            "cat /proc/stat | grep -c '^cpu[0-9]'; \
             cat /sys/devices/system/cpu/cpu[0-9]*/cpufreq/cpuinfo_max_freq 2>/dev/null",
        )
        .await?;
    let mut lines = out.lines();
    let cores = lines
        .next()
        .and_then(|l| l.trim().parse().ok())
        .unwrap_or(0);
    let freqs: Vec<u64> = lines.filter_map(|l| l.trim().parse().ok()).collect();
    Ok(CpuInfo {
        cores,
        clusters: clusters(&freqs),
    })
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    // Captured from an Android 16 arm64 emulator.
    const PROC_STAT: &str = include_str!("testdata/proc_stat.txt");
    const MEMINFO: &str = include_str!("testdata/meminfo.txt");
    const NET_DEV: &str = include_str!("testdata/net_dev.txt");
    const BATTERY: &str = include_str!("testdata/dumpsys_battery.txt");
    const TOP: &str = include_str!("testdata/top.txt");
    const GFXINFO: &str = include_str!("testdata/gfxinfo.txt");

    #[test]
    fn parses_proc_stat() {
        let stat = parse_proc_stat(PROC_STAT);
        // cpu  10188 2755 51938 354253 2878 16568 762 0 0 0
        assert_eq!(stat.total.idle, 354253 + 2878);
        assert_eq!(stat.total.busy, 10188 + 2755 + 51938 + 16568 + 762);
        assert_eq!(stat.cores.len(), 4);
        assert_eq!(stat.cores[3].0, 3);
    }

    #[test]
    fn computes_cpu_delta() {
        let a = CpuTimes {
            busy: 100,
            idle: 900,
        };
        let b = CpuTimes {
            busy: 150,
            idle: 1050,
        };
        assert_eq!(b.usage_since(&a), Some(25.0));
        assert_eq!(a.usage_since(&a), None);
        assert_eq!(a.usage_since(&b), None);
    }

    #[test]
    fn groups_clusters() {
        assert_eq!(
            clusters(&[1_800_000, 1_800_000, 2_400_000, 3_000_000, 1_800_000]),
            vec![3, 1, 1]
        );
        assert_eq!(clusters(&[2, 2, 2, 2]), vec![4]);
        assert!(clusters(&[]).is_empty());
    }

    #[test]
    fn parses_meminfo() {
        let mem = parse_meminfo(MEMINFO);
        assert_eq!(mem.total_kb, 4010748);
        assert_eq!(mem.available_kb, 2043108);
        assert_eq!(mem.used_kb, 4010748 - 2043108);
        assert_eq!(mem.swap_total_kb, 3008056);
        assert_eq!(mem.swap_used_kb, 3008056 - 2314140);
    }

    #[test]
    fn parses_net_dev() {
        let ifaces = parse_net_dev(NET_DEV);
        assert_eq!(ifaces.len(), 17);
        let wlan = ifaces.iter().find(|i| i.name == "wlan0").unwrap();
        assert_eq!(wlan.rx_bytes, 69566048);
        assert_eq!(wlan.tx_bytes, 16119398);
        let (rx, tx, primary) = net_totals(&ifaces);
        assert_eq!(primary.as_deref(), Some("wlan0"));
        assert_eq!(rx, 69566048 + 154441);
        assert_eq!(tx, 16119398 + 96872 + 33258);
    }

    #[test]
    fn parses_battery() {
        let b = parse_dumpsys_battery(BATTERY);
        assert_eq!(b.level, Some(100));
        assert_eq!(b.temperature_c, Some(25.0));
        assert_eq!(b.voltage_mv, Some(5000));
        assert!(!b.charging);
        assert!(!b.plugged);
        assert_eq!(parse_current_now("-1840000\n"), Some(-1840.0));
        assert_eq!(parse_current_now("350"), Some(350.0));
        assert_eq!(parse_current_now(""), None);
    }

    #[test]
    fn parses_top() {
        let procs = parse_top(TOP);
        let server = procs.iter().find(|p| p.name == "system_server").unwrap();
        assert_eq!(server.pid, 744);
        assert_eq!(server.user, "system");
        assert_eq!(server.cpu, 2.9);
        assert_eq!(server.rss_kb, 439460);
        assert_eq!(server.state, "S");
        // USER columns that touch the next field still split.
        assert!(
            procs
                .iter()
                .any(|p| p.user == "webview_zygote" && p.pid == 1100)
        );
        assert!(procs.iter().any(|p| p.name == "[watchdogd]"));
        // Header lines are skipped.
        assert!(procs.iter().all(|p| p.pid > 0));
        assert_eq!(procs.len(), 25 + 11);
    }

    #[test]
    fn parses_gfxinfo_and_pss() {
        let gfx = parse_gfxinfo(GFXINFO).unwrap();
        assert_eq!(gfx.total_frames, 360);
        assert_eq!(gfx.janky_frames, 293);
        assert_eq!(gfx.p95_ms, Some(250));
        assert_eq!(parse_gfxinfo("No process found for: com.x\n"), None);
        assert_eq!(
            parse_total_pss(
                "           TOTAL PSS:   117499            TOTAL RSS:   302468       TOTAL SWAP PSS:       68\n"
            ),
            Some(117499)
        );
    }

    #[test]
    fn sampler_computes_rates_from_two_snapshots() {
        let mut sampler = Sampler::new(Some("com.example.shop".into())).unwrap();
        assert!(
            sampler
                .command()
                .contains("dumpsys gfxinfo com.example.shop")
        );
        let snapshot = |busy: u64, rx: u64, frames: u64| {
            let idle = 1000 + busy;
            format!(
                "cpu  {busy} 0 0 {idle} 0 0 0 0 0 0\ncpu0 {busy} 0 0 {idle} 0 0 0 0 0 0\n\
                 @@mem\nMemTotal: 1000 kB\nMemAvailable: 400 kB\n\
                 @@net\n wlan0: {rx} 1 0 0 0 0 0 0 {rx} 1 0 0 0 0 0 0\n\
                 @@bat\n  level: 82\n  temperature: 314\n  status: 2\n  USB powered: true\n\
                 @@cur\n1840000\n\
                 @@gfx\nTotal frames rendered: {frames}\nJanky frames: {frames} (100%)\n95th percentile: 21ms\n\
                 @@pss\n  TOTAL PSS:   319488  TOTAL RSS: 1\n"
            )
        };
        let t0 = Instant::now();
        let first = sampler.ingest(&snapshot(0, 0, 0), t0, 0);
        assert_eq!(first.cpu, None);
        assert!(first.network.is_none());
        assert_eq!(first.package_pss_kb, Some(319488));
        assert_eq!(first.memory.used_kb, 600);

        let second = sampler.ingest(
            &snapshot(1000, 2_000_000, 58),
            t0 + Duration::from_secs(2),
            2000,
        );
        assert_eq!(second.cpu, Some(50.0));
        assert_eq!(second.cores, vec![50.0]);
        let net = second.network.unwrap();
        assert_eq!(net.rx_bytes_per_sec, 1_000_000.0);
        assert_eq!(net.iface.as_deref(), Some("wlan0"));
        let frames = second.frames.unwrap();
        assert_eq!(frames.fps, 29.0);
        assert_eq!(frames.janky_percent, Some(100.0));
        assert_eq!(second.battery.current_ma, Some(1840.0));
        assert_eq!(second.battery.temperature_c, Some(31.4));
        assert!(second.battery.charging && second.battery.plugged);
        // PSS is kept between measurements.
        assert_eq!(second.package_pss_kb, Some(319488));
    }

    #[test]
    fn rejects_bad_package() {
        assert!(Sampler::new(Some("com.x; reboot".into())).is_err());
        assert!(is_package_name("com.example.shop_2"));
    }
}
