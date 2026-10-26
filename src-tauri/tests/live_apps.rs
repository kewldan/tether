//! Live checks of the Apps backend against a running adb server and a
//! connected device (an emulator is fine). Run with:
//!
//! ```sh
//! TETHER_SERIAL=emulator-5554 cargo test --test live_apps -- --ignored --nocapture --test-threads=1
//! ```
//!
//! Only user apps are touched: one is extracted and reinstalled over itself
//! with `-r` (data kept), and an unsigned APK is offered to the installer to
//! check failure parsing. Nothing is uninstalled.

use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use adb_gui_lib::adb::server::AdbServer;
use adb_gui_lib::device::apk::file;
use adb_gui_lib::device::packages::install::{self, InstallEvent, InstallOptions};
use adb_gui_lib::device::packages::meta::{self, MetaRequest};
use adb_gui_lib::device::packages::{self, AppSummary, extract};

fn serial() -> String {
    std::env::var("TETHER_SERIAL").unwrap_or_else(|_| "emulator-5554".into())
}

async fn user_apps(server: &AdbServer) -> Vec<AppSummary> {
    let apps = packages::list(server, &serial()).await.unwrap();
    apps.into_iter().filter(|a| !a.system).collect()
}

#[tokio::test]
#[ignore]
async fn lists_and_describes_apps() {
    let server = AdbServer::default();
    let started = std::time::Instant::now();
    let apps = packages::list(&server, &serial()).await.unwrap();
    println!("{} packages in {:?}", apps.len(), started.elapsed());
    assert!(apps.len() > 20);
    assert!(apps.iter().any(|a| a.system));
    let with_size = apps.iter().filter(|a| a.size.is_some()).count();
    println!(
        "{with_size} with sizes, {} launchable",
        apps.iter().filter(|a| a.launcher.is_some()).count()
    );
    assert!(
        with_size * 10 >= apps.len() * 9,
        "most apps should have sizes"
    );

    let settings = apps
        .iter()
        .find(|a| a.package == "com.android.settings")
        .unwrap();
    assert!(settings.system && settings.launcher.is_some());

    let details = packages::details(&server, &serial(), "com.android.settings")
        .await
        .unwrap();
    assert!(!details.apks.is_empty());
    assert!(details.summary.version_name.is_some());
    println!(
        "settings: pid {:?}, {} runtime perms",
        details.pid,
        details.runtime_permissions.len()
    );

    let components = packages::components(&server, &serial(), "com.android.settings")
        .await
        .unwrap();
    assert!(components.components.len() > 10);
    let ops = packages::app_ops(
        &server,
        &serial(),
        "com.android.settings",
        details.summary.uid,
    )
    .await
    .unwrap();
    println!("ops: {} uid, {} package", ops.uid.len(), ops.package.len());
    let battery = packages::battery(&server, &serial(), "com.android.settings")
        .await
        .unwrap();
    println!("battery: {battery:?}");
    let storage = packages::storage(&server, &serial(), "com.android.settings")
        .await
        .unwrap();
    assert!(storage.apk.is_some());
}

#[tokio::test]
#[ignore]
async fn resolves_labels_and_icons() {
    let server = AdbServer::default();
    for app in user_apps(&server).await.iter().take(5) {
        let req = MetaRequest {
            package: app.package.clone(),
            apk_path: app.apk_path.clone(),
            version_code: app.version_code,
            last_update: app.last_update,
        };
        let started = std::time::Instant::now();
        let m = meta::load(&server, &serial(), &req, "en-US").await;
        let icon = match &m.icon {
            Some(adb_gui_lib::device::apk::icon::AppIcon::Bitmap { src }) => {
                format!("bitmap {}", src.len())
            }
            Some(adb_gui_lib::device::apk::icon::AppIcon::Adaptive { .. }) => "adaptive".into(),
            None => "none".into(),
        };
        println!(
            "{} → {:?} [{icon}] in {:?}",
            app.package,
            m.label,
            started.elapsed()
        );
        assert!(m.label.is_some(), "no label for {}", app.package);
    }
}

#[tokio::test]
#[ignore]
async fn extracts_and_reinstalls_a_user_app() {
    let server = AdbServer::default();
    let apps = user_apps(&server).await;
    let app = apps
        .iter()
        .filter(|a| a.splits.is_empty() && a.size.is_some())
        .min_by_key(|a| a.size)
        .expect("a user app without splits");
    println!("using {} ({:?} bytes)", app.package, app.size);

    let dir = tempfile::tempdir().unwrap();
    let cancel = AtomicBool::new(false);
    let path = extract::extract(
        &server,
        &serial(),
        &app.package,
        dir.path(),
        &cancel,
        &|_| {},
    )
    .await
    .unwrap();
    let pkg = file::inspect(&path, "en").unwrap();
    assert_eq!(pkg.package, app.package);
    assert_eq!(pkg.version_code, app.version_code);
    println!("extracted {} signing {:?}", path.display(), pkg.signing);

    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    let options = InstallOptions {
        reinstall: true,
        ..InstallOptions::default()
    };
    install::install_on(
        server,
        serial(),
        Arc::new(pkg),
        options,
        Arc::new(AtomicBool::new(false)),
        move |e| sink.lock().unwrap().push(e),
    )
    .await;
    let events = events.lock().unwrap();
    let last = events.last().unwrap();
    assert!(matches!(last, InstallEvent::Done { .. }), "{last:?}");
    assert!(
        events
            .iter()
            .any(|e| matches!(e, InstallEvent::Progress { .. }))
    );
}

#[tokio::test]
#[ignore]
async fn extracts_and_reinstalls_a_split_app() {
    let server = AdbServer::default();
    let apps = user_apps(&server).await;
    let Some(app) = apps
        .iter()
        .filter(|a| !a.splits.is_empty())
        .min_by_key(|a| a.size)
    else {
        println!("no split user app on this device, skipping");
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let cancel = AtomicBool::new(false);
    let path = extract::extract(
        &server,
        &serial(),
        &app.package,
        dir.path(),
        &cancel,
        &|_| {},
    )
    .await
    .unwrap();
    assert!(path.extension().is_some_and(|e| e == "apks"));
    let pkg = file::inspect(&path, "en").unwrap();
    println!("{}: {} parts", pkg.package, pkg.parts.len());
    assert_eq!(pkg.parts.len(), app.splits.len() + 1);

    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    install::install_on(
        server,
        serial(),
        Arc::new(pkg),
        InstallOptions {
            reinstall: true,
            ..InstallOptions::default()
        },
        Arc::new(AtomicBool::new(false)),
        move |e| sink.lock().unwrap().push(e),
    )
    .await;
    let last = events.lock().unwrap().last().cloned().unwrap();
    assert!(matches!(last, InstallEvent::Done { .. }), "{last:?}");
}

#[tokio::test]
#[ignore]
async fn reports_unsigned_apk_failure() {
    let server = AdbServer::default();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("unsigned.apk");
    std::fs::write(&path, include_bytes!("fixtures/apps/fixture-plain.apk")).unwrap();
    let pkg = file::inspect(&path, "en").unwrap();

    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    install::install_on(
        server,
        serial(),
        Arc::new(pkg),
        InstallOptions {
            test_only: true,
            ..InstallOptions::default()
        },
        Arc::new(AtomicBool::new(false)),
        move |e| sink.lock().unwrap().push(e),
    )
    .await;
    let last = events.lock().unwrap().last().cloned().unwrap();
    println!("{last:?}");
    match last {
        InstallEvent::Failed { error, .. } => {
            assert_eq!(
                error.code.as_deref(),
                Some("INSTALL_PARSE_FAILED_NO_CERTIFICATES")
            );
        }
        other => panic!("expected a failure, got {other:?}"),
    }
}

#[tokio::test]
#[ignore]
async fn reads_signing_certificates() {
    let server = AdbServer::default();
    for package in ["com.android.settings", "com.google.android.apps.restore"] {
        let started = std::time::Instant::now();
        let Ok(info) = packages::signing::signing(&server, &serial(), package).await else {
            println!("{package}: not installed");
            continue;
        };
        let s = &info.signers[0];
        println!(
            "{package}: {:?} {} {:?} lineage {} in {:?}",
            info.schemes,
            s.certificate.sha256,
            s.certificate.subject_cn,
            info.lineage.len(),
            started.elapsed()
        );
        assert!(!info.schemes.is_empty());
        assert_eq!(s.certificate.sha256.len(), 32 * 3 - 1);
    }
}

#[tokio::test]
#[ignore]
async fn reads_network_usage() {
    let server = AdbServer::default();
    let apps = packages::list(&server, &serial()).await.unwrap();
    let app = apps
        .iter()
        .find(|a| a.package == "com.android.chrome")
        .or_else(|| apps.iter().find(|a| a.package == "com.android.settings"))
        .unwrap();
    let started = std::time::Instant::now();
    let usage = packages::network::network_usage(&server, &serial(), app.uid.unwrap())
        .await
        .unwrap();
    println!("{}: {usage:#?} in {:?}", app.package, started.elapsed());
    assert!(usage.supported);
    assert!(usage.boot < usage.now);
}

/// Renders every launchable app's icon; with `TETHER_ICON_DIR` set, the
/// icons with SVG layers are written there as JSON for a visual check.
#[tokio::test]
#[ignore]
async fn renders_vector_icons() {
    use adb_gui_lib::device::apk::icon::AppIcon;
    let server = AdbServer::default();
    let apps = packages::list(&server, &serial()).await.unwrap();
    let dir = std::env::var("TETHER_ICON_DIR").ok();
    let (mut none, mut svg) = (Vec::new(), 0);
    for app in apps.iter().filter(|a| a.launcher.is_some()) {
        let req = MetaRequest {
            package: app.package.clone(),
            apk_path: app.apk_path.clone(),
            version_code: app.version_code,
            last_update: app.last_update,
        };
        let m = meta::load(&server, &serial(), &req, "en-US").await;
        let urls: Vec<String> = match &m.icon {
            Some(AppIcon::Bitmap { src }) => vec![src.clone()],
            Some(AppIcon::Adaptive {
                background,
                foreground,
            }) => [background, foreground]
                .into_iter()
                .flatten()
                .cloned()
                .collect(),
            None => {
                none.push(app.package.clone());
                continue;
            }
        };
        if urls.iter().any(|u| u.starts_with("data:image/svg+xml")) {
            svg += 1;
            if let Some(dir) = &dir {
                let json = serde_json::to_string(&m.icon).unwrap();
                std::fs::write(format!("{dir}/{}.json", app.package), json).unwrap();
            }
        }
    }
    println!("{svg} icons with SVG layers; no icon: {none:?}");
}
