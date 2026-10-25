//! Connection, Wi-Fi and diagnostics primitives against a real adb server
//! and (if running) an emulator. Read-only for the devices: nothing is
//! rebooted, reconnected or switched to tcpip. Run with
//! `cargo test --test live_connection -- --ignored --nocapture`.

use adb_gui_lib::adb::devices::{self, Transport};
use adb_gui_lib::adb::locator::{self, LocatorEnv};
use adb_gui_lib::adb::server::{AdbServer, DEFAULT_PORT, read_length_prefixed};
use adb_gui_lib::adb::{avd, diagnostics, hostkey, usb, wireless};
use adb_gui_lib::device::summary;

async fn snapshot(server: &AdbServer) -> Vec<devices::Device> {
    let mut stream = server.open("host:devices-l").await.unwrap();
    devices::parse_devices(&read_length_prefixed(&mut stream).await.unwrap())
}

#[tokio::test]
#[ignore = "needs a running adb server"]
async fn scan_finds_the_installed_adb() {
    let checks = locator::scan(&LocatorEnv::from_process(None, None));
    for c in &checks {
        println!("{:?} {:?} {:?}", c.kind, c.status, c.found);
    }
    let adb = checks.iter().find_map(|c| c.found.clone()).expect("adb");
    let client = locator::client_protocol_version(&adb).await;
    let server = AdbServer::default().version().await.unwrap();
    println!("client protocol {client:?}, server {server}");
    assert!(client.is_some());
}

#[tokio::test]
#[ignore = "needs a running adb server"]
async fn wireless_host_services() {
    let server = AdbServer::default();
    let mdns = wireless::mdns_check(&server).await;
    println!("mdns: {mdns:?}");
    println!("services: {:?}", wireless::mdns_services(&server).await);

    // Nothing listens there: a refused connect is an error, not a device.
    let err = wireless::connect(&server, "127.0.0.1:5599").await.unwrap_err();
    println!("connect: {err}");
    let err = wireless::pair(&server, "127.0.0.1:5599", "123456")
        .await
        .unwrap_err();
    println!("pair: {err}");
    assert!(wireless::disconnect(&server, "127.0.0.1:5599").await.is_err());
}

#[tokio::test]
#[ignore = "needs a running emulator"]
async fn emulator_summary_and_address() {
    let server = AdbServer::default();
    let list = snapshot(&server).await;
    let Some(emu) = list
        .iter()
        .find(|d| d.transport == Transport::Emulator && d.state == devices::DeviceState::Device)
    else {
        println!("no emulator running");
        return;
    };
    let s = summary::device_summary(&server, &emu.serial).await.unwrap();
    println!("{}: {s:?}", emu.serial);
    assert!(s.battery.is_some());
    let ip = wireless::device_ip(&server, &emu.serial).await.unwrap();
    println!("wlan0: {ip:?}");
    let name = server
        .exec_text(&emu.serial, "getprop ro.boot.qemu.avd_name")
        .await
        .unwrap();
    let avds = avd::avd_home().map(|h| avd::list_in(&h)).unwrap_or_default();
    println!("avd {:?} of {avds:?}", name.trim());
    assert!(avds.iter().any(|a| a.name == name.trim()));
}

#[tokio::test]
#[ignore = "needs a running adb server"]
async fn diagnostics_facts_from_the_system() {
    let process = diagnostics::server_process(DEFAULT_PORT).await;
    println!("server process: {process:?}");
    assert!(process.pid.is_some());
    let scan = usb::scan().await;
    println!("usb: {scan:#?}");
    println!(
        "fingerprint: {:?}",
        hostkey::android_user_home().and_then(|d| hostkey::fingerprint_in(&d))
    );

    let server = AdbServer::default();
    let facts = diagnostics::Facts {
        os: std::env::consts::OS,
        server_version: server.version().await.ok(),
        server_port: DEFAULT_PORT,
        process,
        devices: snapshot(&server).await,
        usb: Some(scan),
        mdns: wireless::mdns_check(&server).await.ok(),
        ..Default::default()
    };
    for check in diagnostics::evaluate(&facts) {
        println!(
            "{:?} {}/{} {:?}",
            check.status, check.id, check.variant, check.params
        );
    }
}
