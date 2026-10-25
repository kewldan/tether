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
