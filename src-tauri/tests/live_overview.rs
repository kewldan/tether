//! Overview, developer toggles, captures and bugreport against a real
//! device. Uses `TETHER_SERIAL` (default `emulator-5554`):
//!
//! ```text
//! cargo test --test live_overview -- --ignored --nocapture
//! ```
//!
//! Every toggle that is changed is restored; remote files live under
//! `/data/local/tmp/tether-test/` and are removed.

use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant};

use adb_gui_lib::adb::server::AdbServer;
use adb_gui_lib::device::dev_settings::{self, DevChange};
use adb_gui_lib::device::{actions, bugreport, captures, overview};

fn serial() -> String {
    std::env::var("TETHER_SERIAL").unwrap_or_else(|_| "emulator-5554".into())
}

#[tokio::test]
#[ignore = "needs a connected device"]
async fn snapshot_from_device() {
    let server = AdbServer::default();
    let serial = serial();

    let started = Instant::now();
    let (first, sample) = overview::snapshot(&server, &serial, None).await.unwrap();
    println!("first snapshot in {:?}", started.elapsed());
    println!("{first:#?}");
    assert!(first.memory.is_some());
    assert!(first.storage.is_some());
    assert!(first.uptime_secs.is_some());
    assert!(first.cpu.load.is_some());
    assert!(first.display.physical_size.is_some());

    let started = Instant::now();
    let (second, _) = overview::snapshot(&server, &serial, Some(sample))
        .await
        .unwrap();
    println!(
        "warm snapshot in {:?}, cpu {:?}",
        started.elapsed(),
        second.cpu.load
    );
}

#[tokio::test]
#[ignore = "needs a connected device"]
async fn screenshot_is_png() {
    let server = AdbServer::default();
    let png = actions::screenshot(&server, &serial()).await.unwrap();
    let size = captures::png_size(&png).unwrap();
    println!("screenshot {} bytes, {size:?}", png.len());

    let root = tempfile::tempdir().unwrap();
    let saved = captures::save(root.path(), "Live test", "Screenshot_test", "png", &png)
        .await
        .unwrap();
    assert_eq!((saved.width, saved.height), (Some(size.0), Some(size.1)));
}

#[tokio::test]
#[ignore = "needs a connected device"]
async fn dev_toggles_round_trip() {
    let server = AdbServer::default();
    let serial = serial();
    let before = dev_settings::read(&server, &serial).await.unwrap();
    println!("{before:#?}");

    let touches = before.show_touches.unwrap_or(false);
    let after = dev_settings::apply(&server, &serial, &DevChange::ShowTouches(!touches))
        .await
        .unwrap();
    assert_eq!(after.show_touches, Some(!touches));

    let scale = before.animation_scale.unwrap_or(1.0);
    let after = dev_settings::apply(&server, &serial, &DevChange::AnimationScale(0.5))
        .await
        .unwrap();
    assert_eq!(after.animation_scale, Some(0.5));

    let after = dev_settings::apply(&server, &serial, &DevChange::Density(Some(420)))
        .await
        .unwrap();
    assert_eq!(after.density, Some(420));

    let layout = before.layout_bounds.unwrap_or(false);
    let after = dev_settings::apply(&server, &serial, &DevChange::LayoutBounds(!layout))
        .await
        .unwrap();
    assert_eq!(after.layout_bounds, Some(!layout));

    // Restore.
    dev_settings::apply(&server, &serial, &DevChange::LayoutBounds(layout))
        .await
        .unwrap();
    dev_settings::apply(&server, &serial, &DevChange::Density(before.density))
        .await
        .unwrap();
    dev_settings::apply(&server, &serial, &DevChange::AnimationScale(scale))
        .await
        .unwrap();
    let restored = dev_settings::apply(&server, &serial, &DevChange::ShowTouches(touches))
        .await
        .unwrap();
    assert_eq!(restored.show_touches, before.show_touches);
    assert_eq!(restored.density, before.density);
    assert_eq!(restored.layout_bounds, before.layout_bounds);
}

#[tokio::test]
#[ignore = "needs a connected device"]
async fn records_and_pulls_screen() {
    let server = AdbServer::default();
    let serial = serial();
    server
        .exec(&serial, "mkdir -p /data/local/tmp/tether-test")
        .await
        .unwrap();
    let remote = "/data/local/tmp/tether-test/rec.mp4";

    let mut process = actions::start_recording(&server, &serial, remote)
        .await
        .unwrap();
    println!("screenrecord pid {}", process.pid);
    tokio::time::sleep(Duration::from_secs(2)).await;
    actions::interrupt(&server, &serial, process.pid)
        .await
        .unwrap();
    let output = tokio::time::timeout(
        Duration::from_secs(10),
        actions::wait_recording(&mut process),
    )
    .await
    .expect("screenrecord did not stop");
    println!("screenrecord said: {output:?}");

    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("rec.mp4");
    let size = actions::pull(
        &server,
        &serial,
        remote,
        &dest,
        &AtomicBool::new(false),
        |_, _| {},
    )
    .await
    .unwrap();
    println!("pulled {size} bytes");
    assert!(size > 1000);
    let head = std::fs::read(&dest).unwrap();
    assert_eq!(&head[4..8], b"ftyp");

    server
        .exec(&serial, "rm -rf /data/local/tmp/tether-test")
        .await
        .unwrap();
}

/// Takes 1–3 minutes.
#[tokio::test]
#[ignore = "needs a connected device; slow"]
async fn creates_bugreport() {
    let server = AdbServer::default();
    let serial = serial();
    let cancel = AtomicBool::new(false);
    let remote = bugreport::generate(&server, &serial, &cancel, |done, total| {
        if done % 200 == 0 {
            println!("progress {done}/{total}");
        }
    })
    .await
    .unwrap();
    println!("remote {remote}");

    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join(bugreport::local_name(&remote).unwrap());
    actions::pull(&server, &serial, &remote, &dest, &cancel, |_, _| {})
        .await
        .unwrap();
    server
        .exec(&serial, &bugreport::cleanup_command(&remote))
        .await
        .unwrap();
    println!("{:?}", bugreport::summarize(&dest).unwrap());
}
