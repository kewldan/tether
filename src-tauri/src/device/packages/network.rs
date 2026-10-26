//! Per-app data usage without root. `dumpsys netstats --uid --full` is
//! readable by the shell user (it holds `DUMP`) and prints the per-UID
//! history that Settings → Data usage is built from: 2-hour buckets of
//! rx/tx bytes per network identity and foreground/background set. A
//! `--poll` first flushes the kernel counters into that history.

use serde::Serialize;

use super::parse::parse_tz_offset;
use super::sh;
use crate::adb::server::AdbServer;
use crate::error::AppResult;

const DAY: i64 = 86_400;
const MONTH: i64 = 30 * DAY;
const COMMAND: &str = "dumpsys netstats --poll >/dev/null 2>&1; date +'%s %z'; \
     cat /proc/uptime; dumpsys netstats --uid --full";

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Traffic {
    pub rx: u64,
    pub tx: u64,
}

impl Traffic {
    fn add(&mut self, rx: u64, tx: u64) {
        self.rx += rx;
        self.tx += tx;
    }
}

/// Bytes of one period, split by network.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub wifi: Traffic,
    pub mobile: Traffic,
    pub ethernet: Traffic,
    pub other: Traffic,
    /// Traffic through a VPN tunnel. Android also counts it on the
    /// underlying network, so it is not part of [`Usage::total`].
    pub vpn: Traffic,
    /// Part of the total used while the app was in the foreground.
    pub foreground: Traffic,
}

impl Usage {
    pub fn total(&self) -> Traffic {
        let mut t = Traffic::default();
        for x in [self.wifi, self.mobile, self.ethernet, self.other] {
            t.add(x.rx, x.tx);
        }
        t
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkUsage {
    /// `false` when the device prints no per-UID history (very old or
    /// locked-down builds); the periods are then empty.
    pub supported: bool,
    pub uid: u32,
    /// Device clock and boot time, Unix milliseconds.
    pub now: i64,
    pub boot: i64,
    pub today: Usage,
    pub since_boot: Usage,
    pub last_30_days: Usage,
    /// Start of the oldest bucket the device keeps for this UID.
    pub history_start: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Network {
    Wifi,
    Mobile,
    Ethernet,
    Vpn,
    Other,
}

/// `type=` of an identity: a `ConnectivityManager.TYPE_*` number on
/// Android 10+, the constant's name before that.
fn network(kind: &str) -> Network {
    match kind {
        "1" | "13" | "WIFI" | "WIFI_P2P" => Network::Wifi,
        "9" | "ETHERNET" => Network::Ethernet,
        "17" | "VPN" => Network::Vpn,
        k if k.starts_with("MOBILE") => Network::Mobile,
        k => match k.parse::<u32>() {
            Ok(0 | 2..=5 | 10..=12 | 14 | 15) => Network::Mobile,
            _ => Network::Other,
        },
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Bucket {
    start: i64,
    duration: i64,
    rx: u64,
    tx: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Series {
    network: Network,
    foreground: bool,
    buckets: Vec<Bucket>,
}

fn field<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    let at = line.find(key)?;
    let rest = &line[at + key.len()..];
    let end = rest.find([' ', ',', '}', ']']).unwrap_or(rest.len());
    Some(&rest[..end])
}

/// History entries of `uid` in the `UID stats:` section.
fn series(output: &str, uid: u32) -> Option<Vec<Series>> {
    let mut lines = output.lines().skip_while(|l| l.trim_end() != "UID stats:");
    lines.next()?;
    let uid_key = format!("uid={uid} ");
    let mut out: Vec<Series> = Vec::new();
    let mut current: Option<usize> = None;
    let mut duration = 0i64;
    for line in lines {
        if !line.starts_with(' ') && !line.is_empty() {
            break; // next top-level section
        }
        let t = line.trim();
        if t.starts_with("ident=") {
            current = None;
            let set = field(t, "set=").unwrap_or("");
            if !t.contains(&uid_key) || set.starts_with("DBG") {
                continue;
            }
            if field(t, "tag=").is_some_and(|tag| tag != "0x0") {
                continue;
            }
            let kind = field(t, "type=").unwrap_or("");
            out.push(Series {
                network: network(kind),
                foreground: set == "FOREGROUND",
                buckets: Vec::new(),
            });
            current = Some(out.len() - 1);
        } else if let Some(d) = t.strip_prefix("NetworkStatsHistory: bucketDuration=") {
            duration = d.trim().parse().unwrap_or(0);
        } else if t.starts_with("st=")
            && let Some(i) = current
        {
            let num = |k: &str| field(t, k).and_then(|v| v.parse::<u64>().ok());
            let (Some(start), Some(rx), Some(tx)) = (num("st="), num("rb="), num("tb=")) else {
                continue;
            };
            out[i].buckets.push(Bucket {
                start: start as i64,
                duration: duration.max(1),
                rx,
                tx,
            });
        }
    }
    Some(out)
}

/// The bytes of `bucket` that fall in `[from, now)`, assuming traffic is
/// spread evenly over the part of the bucket that has already passed.
fn overlap(bucket: &Bucket, from: i64, now: i64) -> (u64, u64) {
    let end = (bucket.start + bucket.duration).min(now);
    let span = end - bucket.start;
    if span <= 0 || end <= from {
        return (0, 0);
    }
    let inside = end - bucket.start.max(from);
    if inside >= span {
        return (bucket.rx, bucket.tx);
    }
    let part = |v: u64| (u128::from(v) * inside as u128 / span as u128) as u64;
    (part(bucket.rx), part(bucket.tx))
}

fn usage(series: &[Series], from: i64, now: i64) -> Usage {
    let mut u = Usage::default();
    for s in series {
        for b in &s.buckets {
            let (rx, tx) = overlap(b, from, now);
            if rx == 0 && tx == 0 {
                continue;
            }
            let slot = match s.network {
                Network::Wifi => &mut u.wifi,
                Network::Mobile => &mut u.mobile,
                Network::Ethernet => &mut u.ethernet,
                Network::Vpn => &mut u.vpn,
                Network::Other => &mut u.other,
            };
            slot.add(rx, tx);
            if s.foreground && s.network != Network::Vpn {
                u.foreground.add(rx, tx);
            }
        }
    }
    u
}

/// Parses the output of [`COMMAND`]: `<epoch> <+hhmm>`, `/proc/uptime`,
/// then the netstats dump.
pub fn parse_usage(output: &str, uid: u32) -> NetworkUsage {
    let mut head = output
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && *l != "Forced poll");
    let clock = head.next().unwrap_or("");
    let uptime = head.next().unwrap_or("");
    let mut parts = clock.split_whitespace();
    let now: i64 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let tz = parts.next().and_then(parse_tz_offset).unwrap_or(0);
    let up = uptime
        .split_whitespace()
        .next()
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(0.0) as i64;
    let boot = now - up;
    // Midnight in the device's time zone.
    let today = (now + tz).div_euclid(DAY) * DAY - tz;

    let series = series(output, uid);
    let supported = series.is_some() && now > 0;
    let series = series.unwrap_or_default();
    let history_start = series
        .iter()
        .flat_map(|s| s.buckets.iter().map(|b| b.start))
        .min()
        .map(|s| s * 1000);
    NetworkUsage {
        supported,
        uid,
        now: now * 1000,
        boot: boot * 1000,
        today: usage(&series, today, now),
        since_boot: usage(&series, boot, now),
        last_30_days: usage(&series, now - MONTH, now),
        history_start,
    }
}

pub async fn network_usage(server: &AdbServer, serial: &str, uid: u32) -> AppResult<NetworkUsage> {
    let output = sh(server, serial, COMMAND.to_owned()).await?;
    Ok(parse_usage(&output, uid))
}

#[cfg(test)]
mod tests {
    use super::*;

    const DUMP: &str = include_str!("../../../tests/fixtures/apps/netstats-uid-full.txt");

    #[test]
    fn classifies_network_types() {
        assert_eq!(network("0"), Network::Mobile);
        assert_eq!(network("1"), Network::Wifi);
        assert_eq!(network("17"), Network::Vpn);
        assert_eq!(network("MOBILE_HIPRI"), Network::Mobile);
        assert_eq!(network("WIFI"), Network::Wifi);
        assert_eq!(network("BLUETOOTH"), Network::Other);
    }

    #[test]
    fn reads_device_clock_and_boot_time() {
        let u = parse_usage(DUMP, 10169);
        assert!(u.supported);
        assert_eq!(u.now, 1_793_004_440_000);
        assert_eq!(u.boot, (1_793_004_440 - 37_640) * 1000);
    }

    #[test]
    fn sums_chrome_history_by_network_and_period() {
        let u = parse_usage(DUMP, 10169);
        let month = u.last_30_days;
        // Mobile within 30 days: one background bucket on the secondary
        // identity and one foreground bucket on the default one.
        assert_eq!(
            month.mobile,
            Traffic {
                rx: 5_325_982 + 16_595,
                tx: 34_501 + 10_473
            }
        );
        assert!(month.wifi.rx > 0 && month.vpn.rx > 0);
        assert!(month.foreground.rx > 0);
        assert!(month.foreground.rx <= month.total().rx);
        // Since boot is a subset of the month, today a subset of that.
        assert!(u.since_boot.total().rx <= month.total().rx);
        assert!(u.today.total().rx <= month.total().rx);
        assert_eq!(u.history_start, Some(1_784_037_600_000));
        assert_eq!(month.ethernet, Traffic::default());
    }

    #[test]
    fn counts_partial_buckets_proportionally() {
        let b = Bucket {
            start: 0,
            duration: 7200,
            rx: 1000,
            tx: 100,
        };
        assert_eq!(overlap(&b, 0, 10_000), (1000, 100));
        assert_eq!(overlap(&b, 3600, 10_000), (500, 50));
        assert_eq!(overlap(&b, 7200, 10_000), (0, 0));
        // An open bucket: half an hour passed, all of it after `from`.
        assert_eq!(overlap(&b, 0, 1800), (1000, 100));
        assert_eq!(overlap(&b, 900, 1800), (500, 50));
    }

    #[test]
    fn ignores_other_uids_and_sections() {
        let u = parse_usage(DUMP, 999_999);
        assert!(u.supported);
        assert_eq!(u.last_30_days, Usage::default());
        assert_eq!(u.history_start, None);
        // uid 1000 also appears in the Xt section (as uid=-1, not 1000).
        let system = parse_usage(DUMP, 1000);
        assert!(system.last_30_days.total().rx > 0);
    }

    #[test]
    fn parses_pre_android_10_identities() {
        let old = "1500000000 +0000\n100.0 50.0\nUID stats:\n  Pending bytes: 0\n  \
            Complete history:\n  ident=[{type=WIFI, subType=COMBINED, networkId=\"x\"}] \
            uid=10052 set=FOREGROUND tag=0x0\n    NetworkStatsHistory: bucketDuration=7200\n      \
            st=1499997600 rb=2048 rp=4 tb=1024 tp=3 op=0\n  ident=[{type=MOBILE, \
            subType=COMBINED, subscriberId=310260...}] uid=10052 set=DEFAULT tag=0x0\n    \
            NetworkStatsHistory: bucketDuration=7200\n      st=1499997600 rb=10 rp=1 tb=20 \
            tp=1 op=0\nUID tag stats:\n";
        let u = parse_usage(old, 10052);
        assert_eq!(u.today.wifi, Traffic { rx: 2048, tx: 1024 });
        assert_eq!(u.today.mobile, Traffic { rx: 10, tx: 20 });
        assert_eq!(u.today.foreground, Traffic { rx: 2048, tx: 1024 });
    }

    #[test]
    fn reports_missing_history_as_unsupported() {
        let u = parse_usage(
            "1500000000 +0000\n100.0 50.0\nCan't find service: netstats\n",
            1,
        );
        assert!(!u.supported);
    }
}
