//! Talks to a real adb server. Run with `cargo test -- --ignored` on a
//! machine that has adb installed.

use std::time::Duration;

use adb_gui_lib::adb::devices;
use adb_gui_lib::adb::locator::{self, LocatorEnv};
use adb_gui_lib::adb::server::AdbServer;
use adb_gui_lib::device::props;

#[tokio::test]
#[ignore = "needs adb installed"]
async fn lists_devices_from_real_server() {
    let adb = locator::locate(&LocatorEnv::from_process(None, None))
        .await
        .expect("adb not found");
    println!("using {adb:?}");

    let server = AdbServer::default();
    server.ensure_running(&adb.path).await.unwrap();
    println!(
        "server protocol version {}",
        server.version().await.unwrap()
    );

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let tracker = tokio::spawn(async move {
        devices::track(&server, |list| {
            let _ = tx.send(list);
        })
        .await
    });
    let first = tokio::time::timeout(Duration::from_secs(5), rx.recv())
        .await
        .expect("no snapshot from track-devices")
        .unwrap();
    tracker.abort();
    println!("devices: {first:#?}");

    for device in first
        .iter()
        .filter(|d| d.state == devices::DeviceState::Device)
    {
        let info = props::device_info(&server, &device.serial).await.unwrap();
        println!("{}: {info:#?}", device.serial);
    }
}
