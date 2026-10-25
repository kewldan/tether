//! Installed packages: listing, details and per-app actions through the
//! package manager (`pm`, `cmd package`), `am`, `appops` and `dumpsys`.

pub mod actions;
pub mod extract;
pub mod install;
pub mod meta;
pub mod parse;

use std::collections::HashMap;

use serde::Serialize;

use self::parse::{AppOpEntry, PackageDump, PermissionState};
use crate::adb::server::AdbServer;
use crate::device::apk::manifest::{Component, Manifest};
use crate::error::{AppError, AppResult};

/// Commands sent to adbd stay below the 4 KiB service-name limit of old
/// devices.
const MAX_COMMAND: usize = 3500;
const LAUNCHER_QUERY: &str = "cmd package query-activities --brief --components \
     -a android.intent.action.MAIN -c android.intent.category.LAUNCHER";

/// One row of the apps table.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSummary {
    pub package: String,
    pub uid: Option<u32>,
    pub apk_path: String,
    pub code_path: Option<String>,
    pub version_name: Option<String>,
    pub version_code: u64,
    pub installer: Option<String>,
    pub system: bool,
    /// A system app with an update installed over its factory version.
    pub updated_system: bool,
    pub disabled: bool,
    pub suspended: bool,
    pub stopped: bool,
    pub debuggable: bool,
    pub test_only: bool,
    /// Runtime resource overlay (no code, never launchable).
    pub overlay: bool,
    /// Split APK names besides `base`.
    pub splits: Vec<String>,
    /// Launcher activity as `pkg/.Class`.
    pub launcher: Option<String>,
    pub first_install: Option<i64>,
    pub last_update: Option<i64>,
    pub min_sdk: Option<u32>,
    pub target_sdk: Option<u32>,
    /// Bytes of all APK files.
    pub size: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApkFile {
    pub path: String,
    pub size: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppDetails {
    #[serde(flatten)]
    pub summary: AppSummary,
    pub pid: Option<u32>,
    pub data_dir: Option<String>,
    pub apks: Vec<ApkFile>,
    pub signing_version: Option<u32>,
    pub primary_abi: Option<String>,
    pub shared_user: Option<String>,
    pub initiating_installer: Option<String>,
    pub requested_permissions: Vec<String>,
    pub install_permissions: Vec<PermissionState>,
    pub runtime_permissions: Vec<PermissionState>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppComponents {
    pub components: Vec<Component>,
    /// Launcher activity resolved by the package manager (`pkg/.Class`).
    pub launcher: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStorage {
    pub apk: Option<u64>,
    /// App-private data without caches; only readable for debuggable apps.
    pub data: Option<u64>,
    pub cache: Option<u64>,
    /// `/sdcard/Android/{data,media}/<pkg>`.
    pub external: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppOps {
    /// Per-uid modes (backing runtime permissions).
    pub uid: Vec<AppOpEntry>,
    pub package: Vec<AppOpEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppBattery {
    /// `am get-standby-bucket`: 5 exempted, 10 active, 20 working set,
    /// 30 frequent, 40 rare, 45 restricted, 50 never.
    pub standby_bucket: Option<u32>,
    /// On the Doze / battery optimization allowlist.
    pub unrestricted: bool,
    /// `RUN_ANY_IN_BACKGROUND` app-op mode.
    pub background: Option<String>,
}

/// `exec_text` with an owned command, so calls can sit in `tokio::join!`.
pub(crate) async fn sh(server: &AdbServer, serial: &str, command: String) -> AppResult<String> {
    server.exec_text(serial, &command).await
}

/// Rejects anything that is not a package name, so it can go into a shell
/// command unquoted.
pub fn check_package(name: &str) -> AppResult<&str> {
    let ok = !name.is_empty()
        && name.len() <= 255
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'.');
    if ok {
        Ok(name)
    } else {
        Err(AppError::InvalidInput(format!(
            "not a package name: {name:?}"
        )))
    }
}

/// Single-quotes a value for the device shell.
pub fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

/// Lists packages installed for the current user, with sizes.
pub async fn list(server: &AdbServer, serial: &str) -> AppResult<Vec<AppSummary>> {
    let (listed, dump, tz, launcher) = tokio::join!(
        pm_list(server, serial),
        server.exec_text(serial, "dumpsys package packages"),
        server.exec_text(serial, "date +%z"),
        server.exec_text(serial, LAUNCHER_QUERY),
    );
    let listed = listed?;
    let dump = parse::parse_dumpsys_package(&dump?);
    let tz = tz
        .ok()
        .and_then(|t| parse::parse_tz_offset(&t))
        .unwrap_or(0);
    let launcher = launcher
        .map(|l| parse::parse_components(&l))
        .unwrap_or_default();

    let by_name: HashMap<&str, &PackageDump> =
        dump.packages.iter().map(|p| (p.name.as_str(), p)).collect();
    let mut apps: Vec<AppSummary> = listed
        .into_iter()
        .map(|l| {
            let d = by_name.get(l.package.as_str()).copied();
            let mut app = summarize(&l.package, d, &dump.updated_system, tz);
            app.apk_path = l.apk_path;
            app.uid = l.uid.or(app.uid);
            if app.installer.is_none() {
                app.installer = l.installer;
            }
            if app.version_code == 0 {
                app.version_code = l.version_code.unwrap_or(0);
            }
            app.launcher = launcher.get(&app.package).cloned();
            app
        })
        .collect();

    let sizes = apk_sizes(server, serial, &apps).await;
    for app in &mut apps {
        app.size = sizes.get(&app.package).copied();
    }
    Ok(apps)
}

async fn pm_list(server: &AdbServer, serial: &str) -> AppResult<Vec<parse::ListedPackage>> {
    // `--show-versioncode` needs Android 9 and `-U` Android 8; older
    // releases reject unknown options, so fall back step by step.
    let mut last = String::new();
    for flags in ["-f -U -i --show-versioncode", "-f -i", "-f"] {
        let out = server
            .exec_text(serial, &format!("pm list packages {flags}"))
            .await?;
        let listed = parse::parse_pm_list(&out);
        if !listed.is_empty() {
            return Ok(listed);
        }
        last = out;
    }
    Err(AppError::Device(format!(
        "the package manager returned no packages: {}",
        last.trim()
    )))
}

fn summarize(
    package: &str,
    d: Option<&PackageDump>,
    updated_system: &[String],
    tz: i64,
) -> AppSummary {
    let Some(d) = d else {
        return AppSummary {
            package: package.to_owned(),
            ..AppSummary::default()
        };
    };
    let user = d.user(0).or(d.users.first());
    let time = |v: Option<&String>| v.and_then(|t| parse::parse_local_time(t, tz));
    AppSummary {
        package: package.to_owned(),
        uid: d.app_id,
        apk_path: String::new(),
        code_path: d.code_path.clone(),
        version_name: d.version_name.clone(),
        version_code: d.version_code.unwrap_or(0),
        installer: d.installer.clone(),
        system: d.has_flag("SYSTEM"),
        updated_system: d.has_flag("UPDATED_SYSTEM_APP")
            || updated_system.iter().any(|u| u == package),
        disabled: user.is_some_and(|u| matches!(u.enabled, 2..=4)),
        suspended: user.is_some_and(|u| u.suspended),
        stopped: user.is_some_and(|u| u.stopped),
        debuggable: d.has_flag("DEBUGGABLE"),
        test_only: d.has_flag("TEST_ONLY"),
        overlay: d.overlay_target.is_some(),
        splits: d.splits.iter().filter(|s| *s != "base").cloned().collect(),
        launcher: None,
        first_install: time(user.and_then(|u| u.first_install_time.as_ref()))
            .or_else(|| time(d.timestamp.as_ref())),
        last_update: time(d.last_update_time.as_ref()),
        min_sdk: d.min_sdk,
        target_sdk: d.target_sdk,
        size: None,
    }
}

/// The stat target for one app: every APK in its `/data/app` directory, or
/// the single APK of a preinstalled app.
fn stat_target(app: &AppSummary) -> Option<(String, String)> {
    match &app.code_path {
        Some(dir) if dir.starts_with("/data/app/") => {
            Some((format!("{}/*.apk", quote(dir)), format!("{dir}/")))
        }
        _ if !app.apk_path.is_empty() => Some((quote(&app.apk_path), app.apk_path.clone())),
        _ => None,
    }
}

/// APK bytes per package via batched `stat`.
async fn apk_sizes(server: &AdbServer, serial: &str, apps: &[AppSummary]) -> HashMap<String, u64> {
    let targets: Vec<(&str, String, String)> = apps
        .iter()
        .filter_map(|a| stat_target(a).map(|(arg, prefix)| (a.package.as_str(), arg, prefix)))
        .collect();

    let mut commands = Vec::new();
    let mut current = String::from("stat -c '%s %n'");
    for (_, arg, _) in &targets {
        if current.len() + arg.len() + 1 > MAX_COMMAND {
            commands.push(std::mem::replace(
                &mut current,
                String::from("stat -c '%s %n'"),
            ));
        }
        current.push(' ');
        current.push_str(arg);
    }
    commands.push(current);

    let mut set = tokio::task::JoinSet::new();
    for command in commands {
        let server = *server;
        let serial = serial.to_owned();
        set.spawn(async move {
            server
                .exec_text(&serial, &format!("{command} 2>/dev/null"))
                .await
        });
    }
    let mut files = HashMap::new();
    while let Some(result) = set.join_next().await {
        if let Ok(Ok(out)) = result {
            files.extend(parse::parse_stat_sizes(&out));
        }
    }

    let mut sizes = HashMap::new();
    for (package, _, prefix) in targets {
        let total: u64 = if prefix.ends_with('/') {
            files
                .iter()
                .filter(|(path, _)| {
                    path.starts_with(&prefix) && !path[prefix.len()..].contains('/')
                })
                .map(|(_, size)| size)
                .sum()
        } else {
            files.get(&prefix).copied().unwrap_or(0)
        };
        if total > 0 {
            sizes.insert(package.to_owned(), total);
        }
    }
    sizes
}

/// Full information for the detail view.
pub async fn details(server: &AdbServer, serial: &str, package: &str) -> AppResult<AppDetails> {
    let package = check_package(package)?;
    let (dump, pid, tz, paths, launcher) = tokio::join!(
        sh(server, serial, format!("dumpsys package {package}")),
        sh(server, serial, format!("pidof {package}")),
        server.exec_text(serial, "date +%z"),
        sh(server, serial, format!("pm path {package}")),
        sh(
            server,
            serial,
            format!(
                "cmd package resolve-activity --brief -a android.intent.action.MAIN \
                 -c android.intent.category.LAUNCHER {package}"
            )
        ),
    );
    let dump = parse::parse_dumpsys_package(&dump?);
    let Some(d) = dump.packages.iter().find(|p| p.name == package) else {
        return Err(AppError::Device(format!("{package} is not installed")));
    };
    let tz = tz
        .ok()
        .and_then(|t| parse::parse_tz_offset(&t))
        .unwrap_or(0);
    let mut summary = summarize(package, Some(d), &dump.updated_system, tz);

    let apk_paths: Vec<String> = paths
        .unwrap_or_default()
        .lines()
        .filter_map(|l| l.trim().strip_prefix("package:").map(str::to_owned))
        .collect();
    let sizes = if apk_paths.is_empty() {
        HashMap::new()
    } else {
        let args: Vec<String> = apk_paths.iter().map(|p| quote(p)).collect();
        let out = server
            .exec_text(
                serial,
                &format!("stat -c '%s %n' {} 2>/dev/null", args.join(" ")),
            )
            .await
            .unwrap_or_default();
        parse::parse_stat_sizes(&out)
    };
    let apks: Vec<ApkFile> = apk_paths
        .iter()
        .map(|p| ApkFile {
            path: p.clone(),
            size: sizes.get(p).copied(),
        })
        .collect();
    summary.apk_path = apk_paths.first().cloned().unwrap_or_default();
    summary.size = Some(apks.iter().filter_map(|a| a.size).sum()).filter(|&s| s > 0);
    summary.launcher = launcher.ok().and_then(|l| {
        l.lines()
            .rev()
            .find(|x| x.contains('/'))
            .map(|x| x.trim().to_owned())
    });

    let user = d.user(0).or(d.users.first());
    Ok(AppDetails {
        pid: pid
            .ok()
            .and_then(|p| p.split_whitespace().next().and_then(|v| v.parse().ok())),
        data_dir: user.and_then(|u| u.data_dir.clone()),
        apks,
        signing_version: d.apk_signing_version,
        primary_abi: d.primary_abi.clone(),
        shared_user: d.shared_user.clone(),
        initiating_installer: d.initiating_installer.clone(),
        requested_permissions: d.requested_permissions.clone(),
        install_permissions: d.install_permissions.clone(),
        runtime_permissions: user
            .map(|u| u.runtime_permissions.clone())
            .unwrap_or_default(),
        summary,
    })
}

/// Reads one file out of an APK on the device with the device's `unzip`.
pub async fn read_apk_entry(
    server: &AdbServer,
    serial: &str,
    apk: &str,
    entry: &str,
) -> AppResult<Vec<u8>> {
    server
        .exec(
            serial,
            &format!("unzip -p {} {} 2>/dev/null", quote(apk), quote(entry)),
        )
        .await
}

/// Declared components from the base APK's manifest.
pub async fn components(
    server: &AdbServer,
    serial: &str,
    package: &str,
) -> AppResult<AppComponents> {
    let package = check_package(package)?;
    let (paths, launcher) = tokio::join!(
        sh(server, serial, format!("pm path {package}")),
        sh(
            server,
            serial,
            format!(
                "cmd package resolve-activity --brief -a android.intent.action.MAIN \
                 -c android.intent.category.LAUNCHER {package}"
            )
        ),
    );
    let paths = paths?;
    let base = paths
        .lines()
        .filter_map(|l| l.trim().strip_prefix("package:"))
        .find(|p| !p.contains("/split_"))
        .ok_or_else(|| AppError::Device(format!("{package} is not installed")))?;
    let xml = read_apk_entry(server, serial, base, "AndroidManifest.xml").await?;
    let manifest = Manifest::parse(&xml).ok_or_else(|| {
        AppError::Device(
            "could not read the app manifest (is `unzip` available on the device?)".into(),
        )
    })?;
    Ok(AppComponents {
        components: manifest.components,
        launcher: launcher.ok().and_then(|l| {
            l.lines()
                .rev()
                .find(|x| x.contains('/'))
                .map(|x| x.trim().to_owned())
        }),
    })
}

/// APK, data, cache and external storage sizes. Private data is only
/// readable through `run-as` for debuggable apps.
pub async fn storage(server: &AdbServer, serial: &str, package: &str) -> AppResult<AppStorage> {
    let package = check_package(package)?;
    let (paths, external, private) = tokio::join!(
        sh(server, serial, format!("pm path {package}")),
        sh(
            server,
            serial,
            format!(
                "du -sk /sdcard/Android/data/{package} /sdcard/Android/media/{package} 2>/dev/null"
            )
        ),
        sh(
            server,
            serial,
            format!("run-as {package} sh -c 'du -sk . cache code_cache' 2>/dev/null")
        ),
    );
    let apk_paths: Vec<String> = paths?
        .lines()
        .filter_map(|l| l.trim().strip_prefix("package:").map(quote))
        .collect();
    let apk = if apk_paths.is_empty() {
        None
    } else {
        let out = server
            .exec_text(
                serial,
                &format!("stat -c '%s %n' {} 2>/dev/null", apk_paths.join(" ")),
            )
            .await
            .unwrap_or_default();
        Some(parse::parse_stat_sizes(&out).values().sum())
    };

    let du = |text: &str| -> Vec<(String, u64)> {
        text.lines()
            .filter_map(|l| {
                let (kb, path) = l.split_once(char::is_whitespace)?;
                Some((path.trim().to_owned(), kb.parse::<u64>().ok()? * 1024))
            })
            .collect()
    };
    let external = external.ok().map(|t| du(&t)).filter(|v| !v.is_empty());
    let private = private.ok().map(|t| du(&t)).unwrap_or_default();
    let get = |name: &str| private.iter().find(|(p, _)| p == name).map(|(_, v)| *v);
    let cache = match (get("cache"), get("code_cache")) {
        (None, None) => None,
        (a, b) => Some(a.unwrap_or(0) + b.unwrap_or(0)),
    };
    Ok(AppStorage {
        apk,
        data: get(".").map(|total| total.saturating_sub(cache.unwrap_or(0))),
        cache,
        external: external.map(|v| v.iter().map(|(_, s)| s).sum()),
    })
}

/// App-op modes, split into the uid-wide and package-specific sections.
pub async fn app_ops(
    server: &AdbServer,
    serial: &str,
    package: &str,
    uid: Option<u32>,
) -> AppResult<AppOps> {
    let package = check_package(package)?;
    let all = parse::parse_appops(&sh(server, serial, format!("cmd appops get {package}")).await?);
    let uid_ops = match uid {
        Some(uid) => parse::parse_appops(
            &server
                .exec_text(serial, &format!("cmd appops get --uid {uid}"))
                .await
                .unwrap_or_default(),
        ),
        None => Vec::new(),
    };
    // `get <pkg>` prints the uid section first, then the package ops.
    let skip = if all.len() >= uid_ops.len()
        && all
            .iter()
            .zip(&uid_ops)
            .all(|(a, u)| a.op == u.op && a.mode == u.mode)
    {
        uid_ops.len()
    } else {
        0
    };
    Ok(AppOps {
        uid: uid_ops,
        package: all.into_iter().skip(skip).collect(),
    })
}

/// Standby bucket, Doze allowlist and background-run mode.
pub async fn battery(server: &AdbServer, serial: &str, package: &str) -> AppResult<AppBattery> {
    let package = check_package(package)?;
    let (bucket, allowlist, background) = tokio::join!(
        sh(server, serial, format!("am get-standby-bucket {package}")),
        server.exec_text(serial, "dumpsys deviceidle whitelist"),
        sh(
            server,
            serial,
            format!("cmd appops get {package} RUN_ANY_IN_BACKGROUND")
        ),
    );
    let needle = format!(",{package},");
    Ok(AppBattery {
        standby_bucket: bucket.ok().and_then(|b| b.trim().parse().ok()),
        unrestricted: allowlist.is_ok_and(|a| a.lines().any(|l| l.contains(&needle))),
        background: background
            .ok()
            .and_then(|b| parse::parse_appops(&b).into_iter().next())
            .map(|e| e.mode),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_package_names() {
        assert!(check_package("com.example.shop_2").is_ok());
        assert!(check_package("").is_err());
        assert!(check_package("a; reboot").is_err());
        assert!(check_package("a'b").is_err());
    }

    #[test]
    fn quotes_for_the_device_shell() {
        assert_eq!(quote("/data/app/~~a==/x"), "'/data/app/~~a==/x'");
        assert_eq!(quote("it's"), r"'it'\''s'");
    }

    #[test]
    fn summarizes_dump_entries() {
        let dump = parse::parse_dumpsys_package(include_str!(
            "../../../tests/fixtures/apps/dumpsys-package-packages.txt"
        ));
        let get = |name: &str| dump.packages.iter().find(|p| p.name == name);
        let magnit = summarize(
            "ru.tander.magnit",
            get("ru.tander.magnit"),
            &dump.updated_system,
            10_800,
        );
        assert!(!magnit.system && !magnit.disabled);
        assert_eq!(
            magnit.splits,
            ["config.arm64_v8a", "config.en", "config.xxhdpi"]
        );
        assert!(magnit.last_update.is_some() && magnit.first_install.is_some());

        let nfc = summarize(
            "com.google.android.nfc",
            get("com.google.android.nfc"),
            &dump.updated_system,
            0,
        );
        assert!(nfc.system && nfc.disabled);

        let webview = summarize(
            "com.google.android.webview",
            get("com.google.android.webview"),
            &dump.updated_system,
            0,
        );
        assert!(webview.system && webview.updated_system);
    }

    #[test]
    fn stat_targets_glob_data_app_dirs_only() {
        let data = AppSummary {
            code_path: Some("/data/app/~~x==/p-y==".into()),
            apk_path: "/data/app/~~x==/p-y==/base.apk".into(),
            ..AppSummary::default()
        };
        assert_eq!(
            stat_target(&data),
            Some((
                "'/data/app/~~x==/p-y=='/*.apk".into(),
                "/data/app/~~x==/p-y==/".into()
            ))
        );
        let system = AppSummary {
            code_path: Some("/product/overlay".into()),
            apk_path: "/product/overlay/A.apk".into(),
            ..AppSummary::default()
        };
        assert_eq!(
            stat_target(&system),
            Some((
                "'/product/overlay/A.apk'".into(),
                "/product/overlay/A.apk".into()
            ))
        );
    }
}
