//! Streams logcat from the first online device of a real adb server.
//! Run with `cargo test --test live_logcat -- --ignored --nocapture`.

use std::time::{Duration, Instant};

use adb_gui_lib::adb::devices::{self, DeviceState};
use adb_gui_lib::adb::server::AdbServer;
use adb_gui_lib::device::logcat::{self, StreamOptions};

async fn first_device(server: &AdbServer) -> String {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let server_copy = *server;
    let tracker = tokio::spawn(async move {
        devices::track(&server_copy, |list| {
            let _ = tx.send(list);
        })
        .await
    });
    let list = tokio::time::timeout(Duration::from_secs(5), rx.recv())
        .await
        .expect("no device list")
        .unwrap();
    tracker.abort();
    list.into_iter()
        .find(|d| d.state == DeviceState::Device)
        .expect("no online device")
        .serial
}

#[tokio::test]
#[ignore = "needs a running adb server with a device"]
async fn streams_backlog_in_batches() {
    let server = AdbServer::default();
    let serial = first_device(&server).await;

    let opts = StreamOptions {
        buffers: vec!["main".into(), "system".into(), "crash".into()],
        tail: Some(5000),
        since: None,
    };
    let mut batches = Vec::new();
    let started = Instant::now();
    let _ = tokio::time::timeout(
        Duration::from_secs(3),
        logcat::stream(&server, &serial, &opts, |b| batches.push(b)),
    )
    .await;

    let entries: Vec<_> = batches.iter().flatten().collect();
    println!(
        "{} entries in {} batches within {:?}",
        entries.len(),
        batches.len(),
        started.elapsed()
    );
    assert!(
        entries.len() >= 1000,
        "backlog too small: {}",
        entries.len()
    );
    assert!(batches.len() < entries.len() / 10, "batching is too fine");
    assert!(entries.windows(2).all(|w| w[1].seq == w[0].seq + 1));
    assert!(
        entries
            .iter()
            .all(|e| e.date.len() == 10 && !e.tag.is_empty())
    );
    for crash in entries.iter().filter(|e| e.crash.is_some()) {
        println!("crash: {:?}", crash.crash);
    }
}

#[tokio::test]
#[ignore = "needs a running adb server with a device"]
async fn resolves_packages_and_processes() {
    let server = AdbServer::default();
    let serial = first_device(&server).await;

    let packages = logcat::packages(&server, &serial).await.unwrap();
    println!(
        "{} packages, {} third-party",
        packages.len(),
        packages.iter().filter(|p| p.third_party).count()
    );
    assert!(packages.iter().any(|p| p.name == "com.android.systemui"));

    let procs = logcat::package_processes(&server, &serial, "com.android.systemui")
        .await
        .unwrap();
    println!("systemui: {procs:?}");
    assert!(procs.uid.is_some());
    assert!(!procs.processes.is_empty());
}

#[tokio::test]
#[ignore = "needs a running adb server with a device"]
async fn clears_a_buffer() {
    let server = AdbServer::default();
    let serial = first_device(&server).await;
    // The radio buffer is the least useful one to lose on a shared device.
    logcat::clear(&server, &serial, &["radio".into()])
        .await
        .unwrap();
    assert!(
        logcat::clear(&server, &serial, &["bogus".into()])
            .await
            .is_err()
    );
}

/// The Android 6 dialect (`-v long` without uid and year): current logcat
/// prints the same header when asked for plain `-v long`, so this checks
/// the legacy parser against real output.
#[tokio::test]
#[ignore = "needs a running adb server with a device"]
async fn streams_in_legacy_format() {
    let server = AdbServer::default();
    let serial = first_device(&server).await;
    let dialect = logcat::LogDialect {
        sdk: Some(23),
        year: "2026".into(),
    };
    let opts = StreamOptions {
        buffers: vec!["main".into(), "system".into()],
        tail: Some(500),
        since: None,
    };
    let command = logcat::stream_command(&opts, &dialect).unwrap();
    let mut entries = Vec::new();
    let _ = tokio::time::timeout(
        Duration::from_secs(3),
        logcat::stream_command_output(&server, &serial, &command, &dialect, |b| entries.extend(b)),
    )
    .await;
    println!("{} legacy entries", entries.len());
    assert!(entries.len() >= 400, "too few: {}", entries.len());
    assert!(entries.iter().all(|e| e.uid.is_empty()
        && e.date.starts_with("2026-")
        && e.date.len() == 10
        && e.pid > 0));
}

/// Starts the background crash watcher, crashes Settings with `am crash`
/// and expects exactly that crash (nothing replayed from before).
#[tokio::test]
#[ignore = "needs a running adb server with a device"]
async fn crash_watcher_sees_new_crash_only() {
    let server = AdbServer::default();
    let serial = first_device(&server).await;
    let dialect = logcat::probe(&server, &serial).await;
    let command = logcat::crash_watch_command(&dialect);
    println!("{command}");

    server
        .exec_text(&serial, "am start -W -n com.android.settings/.Settings")
        .await
        .unwrap();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let watch_serial = serial.clone();
    let watcher = tokio::spawn(async move {
        logcat::stream_command_output(&server, &watch_serial, &command, &dialect, |b| {
            for e in b {
                let _ = tx.send(e);
            }
        })
        .await
    });
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert!(rx.try_recv().is_err(), "old entries were replayed");
    server
        .exec_text(&serial, "am crash com.android.settings")
        .await
        .unwrap();

    let entry = tokio::time::timeout(Duration::from_secs(10), rx.recv())
        .await
        .expect("no crash seen")
        .unwrap();
    watcher.abort();
    println!("{:?}", entry.crash);
    let crash = entry.crash.expect("first entry is the crash");
    assert_eq!(crash.process.as_deref(), Some("com.android.settings"));
}
