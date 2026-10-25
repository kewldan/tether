//! Parsers for package manager output: `pm list packages`, `dumpsys
//! package`, `cmd appops get`, launcher queries, `stat`, `date +%z`.

use std::collections::HashMap;

use serde::Serialize;

/// One line of `pm list packages -f -U -i --show-versioncode`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListedPackage {
    pub package: String,
    pub apk_path: String,
    pub version_code: Option<u64>,
    pub installer: Option<String>,
    pub uid: Option<u32>,
}

/// `package:<path>=<pkg> versionCode:36  installer=null uid:10137`. APK
/// paths may contain `=` (base64 in `/data/app/~~…==/`), package names
/// never do, so the package starts after the last `=` of the first field.
pub fn parse_pm_list(output: &str) -> Vec<ListedPackage> {
    output
        .lines()
        .filter_map(|line| {
            let rest = line.trim_end().strip_prefix("package:")?;
            let (head, tail) = match rest.find(" versionCode:") {
                Some(i) => (&rest[..i], &rest[i..]),
                None => match rest.find("  installer=").or_else(|| rest.find(" uid:")) {
                    Some(i) => (&rest[..i], &rest[i..]),
                    None => (rest, ""),
                },
            };
            let (apk_path, package) = head.rsplit_once('=')?;
            let mut out = ListedPackage {
                package: package.to_owned(),
                apk_path: apk_path.to_owned(),
                version_code: None,
                installer: None,
                uid: None,
            };
            for token in tail.split_whitespace() {
                if let Some(v) = token.strip_prefix("versionCode:") {
                    out.version_code = v.parse().ok();
                } else if let Some(v) = token.strip_prefix("installer=") {
                    out.installer = (v != "null").then(|| v.to_owned());
                } else if let Some(v) = token.strip_prefix("uid:") {
                    out.uid = v.split(',').next().and_then(|u| u.parse().ok());
                }
            }
            Some(out)
        })
        .collect()
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionState {
    pub name: String,
    pub granted: bool,
    pub flags: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UserState {
    pub id: u32,
    pub installed: bool,
    pub hidden: bool,
    pub suspended: bool,
    pub stopped: bool,
    /// `COMPONENT_ENABLED_STATE_*`: 0 default, 1 enabled, 2 disabled,
    /// 3 disabled by user, 4 disabled until used.
    pub enabled: u8,
    pub first_install_time: Option<String>,
    pub data_dir: Option<String>,
    pub runtime_permissions: Vec<PermissionState>,
}

/// One `Package [name]` block of `dumpsys package`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PackageDump {
    pub name: String,
    pub app_id: Option<u32>,
    pub code_path: Option<String>,
    pub version_code: Option<u64>,
    pub min_sdk: Option<u32>,
    pub target_sdk: Option<u32>,
    pub version_name: Option<String>,
    pub splits: Vec<String>,
    pub apk_signing_version: Option<u32>,
    pub flags: Vec<String>,
    pub private_flags: Vec<String>,
    pub primary_abi: Option<String>,
    pub shared_user: Option<String>,
    pub overlay_target: Option<String>,
    pub timestamp: Option<String>,
    pub last_update_time: Option<String>,
    pub installer: Option<String>,
    pub initiating_installer: Option<String>,
    pub requested_permissions: Vec<String>,
    pub install_permissions: Vec<PermissionState>,
    pub users: Vec<UserState>,
}

impl PackageDump {
    pub fn has_flag(&self, flag: &str) -> bool {
        self.flags.iter().any(|f| f == flag)
    }

    pub fn user(&self, id: u32) -> Option<&UserState> {
        self.users.iter().find(|u| u.id == id)
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PackagesDump {
    pub packages: Vec<PackageDump>,
    /// Packages under "Hidden system packages": the factory versions of
    /// system apps that received an update.
    pub updated_system: Vec<String>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Section {
    Other,
    Packages,
    Hidden,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum List {
    None,
    Requested,
    Install,
    Runtime,
}

/// Parses `dumpsys package [packages|<pkg>]`. Only the `Packages:` and
/// `Hidden system packages:` sections are read; resolver tables, queries,
/// dexopt state and the rest are skipped.
pub fn parse_dumpsys_package(output: &str) -> PackagesDump {
    let mut out = PackagesDump::default();
    let mut section = Section::Other;
    let mut list = List::None;
    let mut current: Option<PackageDump> = None;

    let finish = |current: &mut Option<PackageDump>, out: &mut PackagesDump| {
        if let Some(p) = current.take() {
            out.packages.push(p);
        }
    };

    for raw in output.lines() {
        let line = raw.trim_end_matches('\r');
        let indent = line.len() - line.trim_start().len();
        let text = line.trim();
        if text.is_empty() {
            continue;
        }

        if indent == 0 {
            finish(&mut current, &mut out);
            section = match text {
                "Packages:" => Section::Packages,
                "Hidden system packages:" => Section::Hidden,
                _ => Section::Other,
            };
            continue;
        }
        if section == Section::Other {
            continue;
        }

        if indent == 2 {
            finish(&mut current, &mut out);
            list = List::None;
            let Some(name) = text
                .strip_prefix("Package [")
                .and_then(|r| r.split_once(']'))
                .map(|(n, _)| n.to_owned())
            else {
                continue;
            };
            if section == Section::Hidden {
                out.updated_system.push(name);
            } else {
                current = Some(PackageDump {
                    name,
                    ..PackageDump::default()
                });
            }
            continue;
        }

        let Some(p) = current.as_mut() else { continue };

        if indent == 4 {
            list = List::None;
            if let Some(rest) = text.strip_prefix("User ") {
                p.users.push(parse_user_line(rest));
                continue;
            }
            match text {
                "requested permissions:" => list = List::Requested,
                "install permissions:" => list = List::Install,
                _ => parse_package_field(p, text),
            }
            continue;
        }

        if indent == 6 {
            match list {
                List::Requested => {
                    // Newer releases append ": restricted=true" etc.
                    let name = text.split(':').next().unwrap_or(text).trim();
                    p.requested_permissions.push(name.to_owned());
                    continue;
                }
                List::Install => {
                    p.install_permissions.push(parse_permission(text));
                    continue;
                }
                _ => {}
            }
            list = List::None;
            let Some(user) = p.users.last_mut() else {
                continue;
            };
            if text == "runtime permissions:" {
                list = List::Runtime;
            } else if let Some(v) = text.strip_prefix("firstInstallTime=") {
                user.first_install_time = Some(v.to_owned());
            } else if let Some(v) = text.strip_prefix("dataDir=") {
                user.data_dir = (v != "null").then(|| v.to_owned());
            }
            continue;
        }

        if indent == 8
            && list == List::Runtime
            && let Some(user) = p.users.last_mut()
        {
            user.runtime_permissions.push(parse_permission(text));
        }
    }
    finish(&mut current, &mut out);
    out
}

fn parse_package_field(p: &mut PackageDump, text: &str) {
    let Some((key, value)) = text.split_once('=') else {
        return;
    };
    let some = |v: &str| (v != "null" && !v.is_empty()).then(|| v.to_owned());
    match key {
        "appId" | "userId" => p.app_id = value.parse().ok(),
        "codePath" => p.code_path = some(value),
        "versionCode" => {
            // `versionCode=36 minSdk=31 targetSdk=36`
            for pair in text.split_whitespace() {
                match pair.split_once('=') {
                    Some(("versionCode", v)) => p.version_code = v.parse().ok(),
                    Some(("minSdk", v)) => p.min_sdk = v.parse().ok(),
                    Some(("targetSdk", v)) => p.target_sdk = v.parse().ok(),
                    _ => {}
                }
            }
        }
        "versionName" => p.version_name = some(value),
        "splits" => {
            p.splits = value
                .trim_start_matches('[')
                .trim_end_matches(']')
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect();
        }
        "apkSigningVersion" => p.apk_signing_version = value.parse().ok(),
        "flags" | "pkgFlags" if p.flags.is_empty() => p.flags = bracket_tokens(value),
        "privateFlags" | "privatePkgFlags" if p.private_flags.is_empty() => {
            p.private_flags = bracket_tokens(value);
        }
        "primaryCpuAbi" => p.primary_abi = some(value),
        "sharedUser" => {
            // `SharedUserSetting{d00bf88 android.uid.networkstack/1073}`
            p.shared_user = value
                .split_whitespace()
                .nth(1)
                .and_then(|s| s.split('/').next())
                .map(str::to_owned);
        }
        "overlayTarget" => p.overlay_target = some(value),
        "timeStamp" => p.timestamp = some(value),
        "lastUpdateTime" => p.last_update_time = some(value),
        "installerPackageName" => p.installer = some(value),
        "initiatingPackageName" => p.initiating_installer = some(value),
        _ => {}
    }
}

fn bracket_tokens(value: &str) -> Vec<String> {
    value
        .trim_start_matches('[')
        .trim_end_matches(']')
        .split_whitespace()
        .map(str::to_owned)
        .collect()
}

/// `User 0: ceDataInode=… installed=true hidden=false … enabled=0 …`
fn parse_user_line(rest: &str) -> UserState {
    let (id, fields) = rest.split_once(':').unwrap_or((rest, ""));
    let mut user = UserState {
        id: id.trim().parse().unwrap_or(0),
        installed: true,
        ..UserState::default()
    };
    for pair in fields.split_whitespace() {
        let Some((k, v)) = pair.split_once('=') else {
            continue;
        };
        match k {
            "installed" => user.installed = v == "true",
            "hidden" => user.hidden = v == "true",
            "suspended" => user.suspended = v == "true",
            "stopped" => user.stopped = v == "true",
            "enabled" => user.enabled = v.parse().unwrap_or(0),
            _ => {}
        }
    }
    user
}

/// `android.permission.CAMERA: granted=false, flags=[ USER_SET|USER_FIXED]`
fn parse_permission(text: &str) -> PermissionState {
    let (name, rest) = text.split_once(':').unwrap_or((text, ""));
    let granted = rest.contains("granted=true");
    let flags = rest
        .split_once("flags=[")
        .map(|(_, f)| {
            f.trim_end_matches(']')
                .split('|')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    PermissionState {
        name: name.trim().to_owned(),
        granted,
        flags,
    }
}

/// Lines `pkg/.Activity` of `cmd package query-activities --brief
/// --components`; returns package → first launcher component.
pub fn parse_components(output: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for line in output.lines() {
        let line = line.trim();
        let Some((pkg, class)) = line.split_once('/') else {
            continue;
        };
        if pkg.is_empty() || class.is_empty() || pkg.contains(' ') || class.contains(' ') {
            continue;
        }
        out.entry(pkg.to_owned()).or_insert_with(|| line.to_owned());
    }
    out
}

/// `stat -c '%s %n' …` → path → size; error lines are skipped.
pub fn parse_stat_sizes(output: &str) -> HashMap<String, u64> {
    output
        .lines()
        .filter_map(|line| {
            let (size, path) = line.trim_end().split_once(' ')?;
            Some((path.to_owned(), size.parse().ok()?))
        })
        .collect()
}

/// `date +%z` → offset in seconds east of UTC (`+0300` → 10800).
pub fn parse_tz_offset(output: &str) -> Option<i64> {
    let s = output.trim();
    let (sign, digits) = match s.as_bytes().first()? {
        b'+' => (1, &s[1..]),
        b'-' => (-1, &s[1..]),
        _ => return None,
    };
    if digits.len() != 4 || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let hours: i64 = digits[..2].parse().ok()?;
    let minutes: i64 = digits[2..].parse().ok()?;
    Some(sign * (hours * 3600 + minutes * 60))
}

/// Device-local `YYYY-MM-DD HH:MM:SS` → Unix milliseconds.
pub fn parse_local_time(value: &str, tz_offset: i64) -> Option<i64> {
    let (date, time) = value.trim().split_once(' ')?;
    let mut d = date.split('-').map(|x| x.parse::<i64>().ok());
    let (y, m, day) = (d.next()??, d.next()??, d.next()??);
    let mut t = time.split(':').map(|x| x.parse::<i64>().ok());
    let (h, min, s) = (t.next()??, t.next()??, t.next()??);
    if !(1..=12).contains(&m) || !(1..=31).contains(&day) {
        return None;
    }
    let days = days_from_civil(y, m, day);
    // Epoch-zero timestamps mean "unknown" (APEX and prebuilt packages).
    if y <= 1970 {
        return None;
    }
    Some(((days * 86_400 + h * 3600 + min * 60 + s) - tz_offset) * 1000)
}

/// Days since 1970-01-01 for a proleptic Gregorian date (H. Hinnant).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppOpEntry {
    pub op: String,
    pub mode: String,
    /// Raw `time=+2h10m49s108ms ago`, if present.
    pub last_access: Option<String>,
    pub last_reject: Option<String>,
    pub running: bool,
}

/// Parses `cmd appops get <pkg|uid>`. The first entry may carry a
/// `Uid mode: ` prefix that opens the uid-wide section.
pub fn parse_appops(output: &str) -> Vec<AppOpEntry> {
    output
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            let line = line.strip_prefix("Uid mode: ").unwrap_or(line);
            let (op, rest) = line.split_once(": ")?;
            if op.is_empty()
                || !op
                    .bytes()
                    .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
            {
                return None;
            }
            let mut parts = rest.split("; ");
            let mode = parts.next()?.trim().to_owned();
            let mut entry = AppOpEntry {
                op: op.to_owned(),
                mode,
                last_access: None,
                last_reject: None,
                running: rest.contains("(running)"),
            };
            for part in parts {
                let part = part.trim().trim_end_matches(" (running)");
                if let Some(v) = part.strip_prefix("time=") {
                    entry.last_access = Some(v.trim_end_matches(" ago").to_owned());
                } else if let Some(v) = part.strip_prefix("rejectTime=") {
                    entry.last_reject = Some(v.trim_end_matches(" ago").to_owned());
                }
            }
            Some(entry)
        })
        .collect()
}

/// Outcome line of `pm`/`cmd package` commands that print `Success` or
/// `Failure [CODE: detail]` / `Error: …` / a Java exception.
pub fn pm_failure(output: &str) -> Option<String> {
    let text = output.trim();
    if text.is_empty()
        || text
            .lines()
            .any(|l| l.trim() == "Success" || l.starts_with("Success:"))
    {
        return None;
    }
    for line in text.lines() {
        let l = line.trim();
        if l.starts_with("Failure")
            || l.starts_with("Error")
            || l.starts_with("Exception")
            || l.starts_with("java.lang.")
            || l.starts_with("Security exception")
            || l.contains("Exception:")
        {
            return Some(first_meaningful_line(text));
        }
    }
    None
}

fn first_meaningful_line(text: &str) -> String {
    // Prefer the exception message over "Exception occurred while executing".
    text.lines()
        .map(str::trim)
        .find(|l| l.starts_with("java.lang.") || l.starts_with("Failure") || l.starts_with("Error"))
        .or_else(|| text.lines().map(str::trim).find(|l| !l.is_empty()))
        .unwrap_or(text)
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    const PM_LIST: &str = include_str!("../../../tests/fixtures/apps/pm-list-packages.txt");
    const DUMP_ALL: &str =
        include_str!("../../../tests/fixtures/apps/dumpsys-package-packages.txt");
    const DUMP_ONE: &str =
        include_str!("../../../tests/fixtures/apps/dumpsys-package-httptoolkit.txt");
    const DUMP_MISSING: &str =
        include_str!("../../../tests/fixtures/apps/dumpsys-package-missing.txt");
    const APPOPS: &str = include_str!("../../../tests/fixtures/apps/appops-get.txt");
    const LAUNCHER: &str =
        include_str!("../../../tests/fixtures/apps/query-activities-launcher.txt");

    #[test]
    fn parses_pm_list_with_base64_paths() {
        let list = parse_pm_list(PM_LIST);
        assert_eq!(list.len(), 6);
        let magnit = list
            .iter()
            .find(|p| p.package == "ru.tander.magnit")
            .unwrap();
        assert_eq!(
            magnit.apk_path,
            "/data/app/~~KjSgHoA4J32HgvqGvH8cNw==/ru.tander.magnit-kRCkZM1yDZwyyra2hoLczg==/base.apk"
        );
        assert_eq!(magnit.version_code, Some(1_528_882));
        assert_eq!(magnit.installer.as_deref(), Some("ru.vk.store"));
        assert_eq!(magnit.uid, Some(10225));
        let camera = list
            .iter()
            .find(|p| p.package == "com.android.camera2")
            .unwrap();
        assert_eq!(camera.installer, None);
        // CRLF from old adbd and lines without `=` are tolerated.
        let short = parse_pm_list("package:/a/b.apk=x.y\r\npackage:com.whatsapp\n");
        assert_eq!(short.len(), 1);
        assert_eq!(
            (short[0].package.as_str(), short[0].apk_path.as_str()),
            ("x.y", "/a/b.apk")
        );
    }

    #[test]
    fn parses_all_packages_dump() {
        let dump = parse_dumpsys_package(DUMP_ALL);
        let names: Vec<_> = dump.packages.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(
            names,
            [
                "com.google.android.networkstack.tethering",
                "ru.tander.magnit",
                "com.google.android.nfc",
                "com.android.privatespace",
                "com.google.android.webview",
            ]
        );
        assert_eq!(dump.updated_system, ["com.google.android.webview"]);

        let magnit = &dump.packages[1];
        assert_eq!(magnit.version_name.as_deref(), Some("8.125.0"));
        assert_eq!(magnit.version_code, Some(1_528_882));
        assert_eq!((magnit.min_sdk, magnit.target_sdk), (Some(26), Some(36)));
        assert_eq!(
            magnit.splits,
            ["base", "config.arm64_v8a", "config.en", "config.xxhdpi"]
        );
        assert_eq!(magnit.apk_signing_version, Some(3));
        assert!(!magnit.has_flag("SYSTEM") && magnit.has_flag("HAS_CODE"));
        assert_eq!(magnit.installer.as_deref(), Some("ru.vk.store"));
        assert_eq!(
            magnit.last_update_time.as_deref(),
            Some("2026-10-23 16:47:05")
        );
        assert_eq!(magnit.install_permissions.len(), 22);
        let user = magnit.user(0).unwrap();
        assert!(user.installed && user.enabled == 0);
        assert_eq!(
            user.first_install_time.as_deref(),
            Some("2026-07-14 18:24:43")
        );
        assert_eq!(
            user.data_dir.as_deref(),
            Some("/data/user/0/ru.tander.magnit")
        );
        assert_eq!(user.runtime_permissions.len(), 9);
        let fine = &user.runtime_permissions[1];
        assert_eq!(fine.name, "android.permission.ACCESS_FINE_LOCATION");
        assert!(!fine.granted);
        assert!(fine.flags.iter().any(|f| f == "USER_FIXED"));

        let tethering = &dump.packages[0];
        assert!(tethering.has_flag("SYSTEM"));
        assert_eq!(
            tethering.shared_user.as_deref(),
            Some("android.uid.networkstack")
        );

        let nfc = &dump.packages[2];
        assert_eq!(nfc.user(0).unwrap().enabled, 2);
        let privatespace = &dump.packages[3];
        assert!(!privatespace.user(0).unwrap().installed);
    }

    #[test]
    fn parses_single_package_dump_with_requested_permissions() {
        let dump = parse_dumpsys_package(DUMP_ONE);
        assert_eq!(dump.packages.len(), 1);
        let p = &dump.packages[0];
        assert_eq!(p.name, "tech.httptoolkit.android.v1");
        assert_eq!(p.version_name.as_deref(), Some("1.6.0"));
        assert_eq!(p.requested_permissions.len(), 9);
        assert!(
            p.requested_permissions
                .iter()
                .any(|r| r == "android.permission.CAMERA")
        );
        assert_eq!(p.initiating_installer.as_deref(), Some("com.android.shell"));
        let runtime = &p.user(0).unwrap().runtime_permissions;
        assert_eq!(runtime.len(), 2);
        assert!(runtime[0].granted && runtime[0].flags[0] == "USER_SET");

        assert!(parse_dumpsys_package(DUMP_MISSING).packages.is_empty());
    }

    #[test]
    fn parses_launcher_components() {
        let map = parse_components(LAUNCHER);
        assert_eq!(map.len(), 25);
        assert_eq!(
            map["com.android.settings"],
            "com.android.settings/.Settings"
        );
        assert!(!map.contains_key("25 activities found:"));
    }

    #[test]
    fn parses_stat_sizes_and_skips_errors() {
        let out = "180566412 /data/app/~~K==/m-k==/base.apk\n\
                   stat: '/nonexist.apk': No such file or directory\n\
                   770314 /system/priv-app/Tag Google/Tag.apk\n";
        let sizes = parse_stat_sizes(out);
        assert_eq!(sizes["/data/app/~~K==/m-k==/base.apk"], 180_566_412);
        assert_eq!(sizes["/system/priv-app/Tag Google/Tag.apk"], 770_314);
        assert_eq!(sizes.len(), 2);
    }

    #[test]
    fn converts_device_local_times() {
        assert_eq!(parse_tz_offset("+0300\n"), Some(10_800));
        assert_eq!(parse_tz_offset("-0530"), Some(-19_800));
        assert_eq!(parse_tz_offset("UTC"), None);
        // 2026-10-06 23:01:03 at +03:00 == 2026-10-06T20:01:03Z.
        assert_eq!(
            parse_local_time("2026-10-06 23:01:03", 10_800),
            Some(1_791_316_863_000)
        );
        assert_eq!(parse_local_time("1970-01-01 03:00:00", 10_800), None);
        assert_eq!(parse_local_time("garbage", 0), None);
    }

    #[test]
    fn parses_appops() {
        let ops = parse_appops(APPOPS);
        let first = &ops[0];
        assert_eq!(
            (first.op.as_str(), first.mode.as_str()),
            ("COARSE_LOCATION", "ignore")
        );
        let fg = ops.iter().find(|o| o.op == "START_FOREGROUND").unwrap();
        assert_eq!(fg.mode, "allow");
        assert_eq!(fg.last_access.as_deref(), Some("+8m49s237ms"));
        assert!(fg.running);
        let saw = ops.iter().find(|o| o.op == "SYSTEM_ALERT_WINDOW").unwrap();
        assert_eq!(saw.mode, "default");
        assert_eq!(saw.last_reject.as_deref(), Some("+8m50s387ms"));
        assert!(parse_appops("No operations.\n").is_empty());
    }

    #[test]
    fn detects_pm_failures() {
        assert_eq!(pm_failure("Success\n"), None);
        assert_eq!(pm_failure(""), None);
        assert_eq!(pm_failure("Package x new state: disabled-user\n"), None);
        assert_eq!(
            pm_failure("Failure [DELETE_FAILED_INTERNAL_ERROR]\n").as_deref(),
            Some("Failure [DELETE_FAILED_INTERNAL_ERROR]")
        );
        let exception = "Exception occurred while executing 'grant':\n\
            java.lang.IllegalArgumentException: Unknown permission android.permission.BOGUS\n\
            \tat com.android.server.Foo.bar(Foo.kt:1)\n";
        assert_eq!(
            pm_failure(exception).as_deref(),
            Some("java.lang.IllegalArgumentException: Unknown permission android.permission.BOGUS")
        );
    }
}
