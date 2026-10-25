//! File manager against a real device. Needs a running adb server and one
//! authorized device (set `TETHER_SERIAL` to pick one). Everything is
//! created under `/data/local/tmp/tether-test` and `/sdcard/Download/
//! tether-test` and removed afterwards.
//!
//! `cargo test --test live_files -- --ignored --nocapture --test-threads=1`

use std::sync::atomic::Ordering;
use std::time::Instant;

use adb_gui_lib::adb::server::AdbServer;
use adb_gui_lib::adb::sync::{SyncConn, SyncFeatures};
use adb_gui_lib::device::files::{self, EntryKind};
use adb_gui_lib::device::transfer::{self, TransferControl, TransferEvent};
use adb_gui_lib::error::AppError;

const TMP: &str = "/data/local/tmp/tether-test";
const SDCARD: &str = "/sdcard/Download/tether-test";

async fn serial(server: &AdbServer) -> String {
    if let Ok(serial) = std::env::var("TETHER_SERIAL") {
        return serial;
    }
    let mut stream = server.open("host:devices").await.unwrap();
    let list = adb_gui_lib::adb::server::read_length_prefixed(&mut stream)
        .await
        .unwrap();
    list.lines()
        .find(|l| l.ends_with("\tdevice"))
        .and_then(|l| l.split('\t').next())
        .expect("no authorized device")
        .to_owned()
}

#[tokio::test]
#[ignore = "needs a device"]
async fn lists_root_sdcard_and_denied_data() {
    let server = AdbServer::default();
    let serial = serial(&server).await;
    let features = adb_gui_lib::adb::sync::device_features(&server, &serial)
        .await
        .unwrap();
    println!("features: {features}");

    let root = files::list_dir(&server, &serial, "/").await.unwrap();
    assert!(!root.denied);
    let sdcard = root.entries.iter().find(|e| e.name == "sdcard").unwrap();
    assert_eq!(sdcard.kind, EntryKind::Symlink);
    assert!(sdcard.link_to_dir);
    println!("/ has {} entries", root.entries.len());

    let listing = files::list_dir(&server, &serial, "/sdcard").await.unwrap();
    assert!(listing.entries.iter().any(|e| e.name == "Download"));
    for e in listing.entries.iter().take(5) {
        println!(
            "{} {:>10} {} {:?}:{:?} {}",
            e.permissions, e.size, e.mtime, e.owner, e.group, e.name
        );
    }

    let data = files::list_dir(&server, &serial, "/data").await.unwrap();
    assert!(data.denied, "shell should not list /data");

    let missing = files::list_dir(&server, &serial, "/nope/never").await;
    assert!(matches!(missing, Err(AppError::Device(_))), "{missing:?}");

    let storage = files::storage(&server, &serial, "/sdcard").await.unwrap();
    println!("storage: {storage:?}");
    assert!(storage.total > 0);
}

#[tokio::test]
#[ignore = "needs a device"]
async fn v1_protocol_matches_v2() {
    let server = AdbServer::default();
    let serial = serial(&server).await;
    let v1 = SyncFeatures::default();
    let mut conn = SyncConn::new(server.open_device(&serial, "sync:").await.unwrap(), v1);
    let listing = files::list_with(&mut conn, "/sdcard").await.unwrap();
    assert!(listing.entries.iter().any(|e| e.name == "Download"));
    let root = files::list_with(&mut conn, "/").await.unwrap();
    let sdcard = root.entries.iter().find(|e| e.name == "sdcard").unwrap();
    assert!(sdcard.link_to_dir, "v1 trailing-slash stat should resolve");
    conn.quit().await.unwrap();
}

#[tokio::test]
#[ignore = "needs a device"]
async fn push_pull_and_file_operations() {
    let server = AdbServer::default();
    let serial = serial(&server).await;
    files::delete(&server, &serial, &[TMP.into(), SDCARD.into()])
        .await
        .unwrap();
    files::mkdir(&server, &serial, TMP).await.unwrap();
    files::mkdir(&server, &serial, SDCARD).await.unwrap();
    // mkdir refuses existing folders.
    assert!(files::mkdir(&server, &serial, TMP).await.is_err());

    // A local tree with an awkward name, an empty folder and a 5 MiB file.
    let local = tempfile::tempdir().unwrap();
    let root = local.path().join("it's a «test» $(x)");
    std::fs::create_dir_all(root.join("empty")).unwrap();
    std::fs::create_dir_all(root.join("sub")).unwrap();
    std::fs::write(root.join("hello.txt"), b"hello tether\n").unwrap();
    let big: Vec<u8> = (0..5 * 1024 * 1024u32).map(|i| (i % 251) as u8).collect();
    std::fs::write(root.join("sub/big.bin"), &big).unwrap();

    let control = TransferControl::default();
    let mut events = 0;
    let started = Instant::now();
    let pushed = transfer::push(
        &server,
        &serial,
        std::slice::from_ref(&root),
        SDCARD,
        &control,
        |_| events += 1,
    )
    .await
    .unwrap();
    println!(
        "pushed {} files, {} bytes in {:?} ({events} events)",
        pushed.files,
        pushed.bytes,
        started.elapsed()
    );
    assert_eq!(pushed.files, 2);
    let remote_root = &pushed.destinations[0];
    assert_eq!(remote_root, &format!("{SDCARD}/it's a «test» $(x)"));

    let listing = files::list_dir(&server, &serial, remote_root)
        .await
        .unwrap();
    let mut names: Vec<_> = listing.entries.iter().map(|e| e.name.clone()).collect();
    names.sort();
    assert_eq!(names, ["empty", "hello.txt", "sub"]);
    // FUSE storage lists empty folders as nothing at all; not "denied".
    let empty = files::list_dir(&server, &serial, &format!("{remote_root}/empty"))
        .await
        .unwrap();
    assert!(!empty.denied && empty.entries.is_empty());

    // Same name again → "(1)" suffix.
    let again = transfer::push(
        &server,
        &serial,
        &[root.join("hello.txt")],
        remote_root,
        &control,
        |_| {},
    )
    .await
    .unwrap();
    assert_eq!(
        again.destinations[0],
        format!("{remote_root}/hello (1).txt")
    );

    // Preview reads only the head.
    let head = files::read_head(
        &server,
        &serial,
        &format!("{remote_root}/sub/big.bin"),
        1000,
    )
    .await
    .unwrap();
    assert_eq!(head, &big[..1000]);

    // Pull the folder back and compare.
    let out = tempfile::tempdir().unwrap();
    let mut last = None;
    let pulled = transfer::pull(
        &server,
        &serial,
        std::slice::from_ref(remote_root),
        out.path(),
        &control,
        |e| last = Some(e),
    )
    .await
    .unwrap();
    assert_eq!(pulled.files, 3);
    let back = out.path().join("it's a «test» $(x)");
    assert_eq!(std::fs::read(back.join("sub/big.bin")).unwrap(), big);
    assert_eq!(
        std::fs::read(back.join("hello.txt")).unwrap(),
        b"hello tether\n"
    );
    assert!(back.join("empty").is_dir());
    assert!(matches!(
        last,
        Some(TransferEvent::Progress { files_done: 3, .. })
    ));

    // Rename, chmod, refuse overwrite, delete.
    let a = format!("{TMP}/a file.txt");
    let b = format!("{TMP}/b'file.txt");
    transfer::push(
        &server,
        &serial,
        &[root.join("hello.txt")],
        TMP,
        &control,
        |_| {},
    )
    .await
    .unwrap();
    files::rename(&server, &serial, &format!("{TMP}/hello.txt"), &a)
        .await
        .unwrap();
    files::mkdir(&server, &serial, &b).await.unwrap();
    assert!(files::rename(&server, &serial, &a, &b).await.is_err());
    files::chmod(&server, &serial, std::slice::from_ref(&a), "600", false)
        .await
        .unwrap();
    let listing = files::list_dir(&server, &serial, TMP).await.unwrap();
    let entry = listing
        .entries
        .iter()
        .find(|e| e.name == "a file.txt")
        .unwrap();
    assert_eq!(entry.permissions, "-rw-------");
    let denied = files::mkdir(&server, &serial, "/data/tether-nope").await;
    println!("mkdir in /data: {denied:?}");
    assert!(matches!(denied, Err(AppError::Device(_))));

    // Cancel a pull mid-flight.
    let cancel = TransferControl::default();
    let out2 = tempfile::tempdir().unwrap();
    let big_remote = format!("{remote_root}/sub/big.bin");
    let result = transfer::pull(&server, &serial, &[big_remote], out2.path(), &cancel, |e| {
        // The first progress event comes right before RECV starts.
        if matches!(e, TransferEvent::Progress { .. }) {
            cancel.cancel.store(true, Ordering::Relaxed);
        }
    })
    .await;
    assert!(matches!(result, Err(AppError::Cancelled)), "{result:?}");
    assert!(!out2.path().join("big.bin").exists());

    files::delete(&server, &serial, &[TMP.into(), SDCARD.into()])
        .await
        .unwrap();
    assert!(files::list_dir(&server, &serial, TMP).await.is_err());
}
