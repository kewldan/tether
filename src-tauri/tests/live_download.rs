//! Downloads real platform-tools from Google. Run with
//! `cargo test --test live_download -- --ignored --nocapture`.

use std::sync::atomic::AtomicBool;

use adb_gui_lib::adb::installer::{self, InstallEvent};
use adb_gui_lib::adb::locator::{self, AdbSource};

#[tokio::test]
#[ignore = "downloads ~10 MB from dl.google.com"]
async fn downloads_and_runs_platform_tools() {
    let app_data = tempfile::tempdir().unwrap();
    let cancel = AtomicBool::new(false);
    let mut events = Vec::new();

    let adb = installer::install(app_data.path(), &cancel, |e| events.push(e))
        .await
        .unwrap();

    let install = locator::inspect(adb, AdbSource::Bundled).await;
    println!("{install:?}, {} progress events", events.len());
    assert!(install.version.is_some(), "downloaded adb must run");
    assert!(matches!(events.last(), Some(InstallEvent::Extracting)));
    assert!(
        !app_data.path().join(".platform-tools-download").exists(),
        "work dir must be cleaned up"
    );
}

#[tokio::test]
#[ignore = "talks to dl.google.com"]
async fn cancel_stops_download() {
    let app_data = tempfile::tempdir().unwrap();
    let cancel = AtomicBool::new(true);

    let err = installer::install(app_data.path(), &cancel, |_| {})
        .await
        .unwrap_err();
    assert_eq!(err.to_string(), "operation was cancelled");
    assert!(!app_data.path().join("platform-tools").exists());
}
