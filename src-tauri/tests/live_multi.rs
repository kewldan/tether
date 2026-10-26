//! Multi-device grid and sideload checks against a real adb server and a
//! booted device or emulator. Nothing here changes device state: the
//! sideload test only checks that a device in normal mode refuses the
//! service. Run with `cargo test --test live_multi -- --ignored`.

use std::time::Instant;

use adb_gui_lib::adb::devices::DeviceState;
use adb_gui_lib::adb::server::{AdbServer, read_length_prefixed};
use adb_gui_lib::adb::sideload;
use adb_gui_lib::device::{actions, thumbnail};
use adb_gui_lib::error::AppError;
use tokio::io::AsyncReadExt;

async fn ready_serial(server: &AdbServer) -> String {
    let mut stream = server.open("host:devices-l").await.unwrap();
    let list =
        adb_gui_lib::adb::devices::parse_devices(&read_length_prefixed(&mut stream).await.unwrap());
    list.into_iter()
        .find(|d| d.state == DeviceState::Device)
        .expect("no ready device")
        .serial
}

#[tokio::test]
#[ignore = "needs a ready device"]
async fn thumbnail_from_real_screencap() {
    let server = AdbServer::default();
    let serial = ready_serial(&server).await;
    let started = Instant::now();
    let png = actions::screenshot(&server, &serial).await.unwrap();
    let captured = started.elapsed();
    let full = thumbnail::decode_png(&png).unwrap();
    let small = thumbnail::fit(&full, 270, 810);
    let encoded = thumbnail::encode_png(&small).unwrap();
    println!(
        "{serial}: {}×{} ({} KB) in {captured:?} → {}×{} ({} KB) in {:?} total",
        full.width,
        full.height,
        png.len() / 1024,
        small.width,
        small.height,
        encoded.len() / 1024,
        started.elapsed()
    );
    assert!(small.width <= 270);
    assert!(full.width > small.width);
}

#[tokio::test]
#[ignore = "needs a ready device"]
async fn normal_mode_refuses_sideload_host() {
    let server = AdbServer::default();
    let serial = ready_serial(&server).await;
    // adbd outside recovery has no sideload services: the server either
    // fails the request or the stream closes without a block request.
    match server
        .open_device(&serial, &sideload::host_service(1 << 20))
        .await
    {
        Err(AppError::AdbFailure(message)) => println!("refused: {message}"),
        Err(other) => panic!("unexpected error {other:?}"),
        Ok(mut stream) => {
            let mut buf = Vec::new();
            stream.read_to_end(&mut buf).await.unwrap();
            assert!(buf.is_empty(), "got {buf:?}");
            println!("closed without a request");
        }
    }
}
