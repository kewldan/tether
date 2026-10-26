//! System and per-app language, and host-port usage, against a real
//! device. Uses `$TETHER_SERIAL` (default `emulator-5554`); restores the
//! original languages afterwards. Run with
//! `cargo test --test live_locale -- --ignored --nocapture --test-threads 1`.

use std::io::Write;
use std::time::Duration;

use adb_gui_lib::adb::forward;
use adb_gui_lib::adb::host_ports;
use adb_gui_lib::adb::server::AdbServer;
use adb_gui_lib::device::dev_settings::{self, DevChange};

fn serial() -> String {
    std::env::var("TETHER_SERIAL").unwrap_or_else(|_| "emulator-5554".into())
}

#[tokio::test]
#[ignore = "needs a device"]
async fn switches_system_and_app_language_and_back() {
    let server = AdbServer::default();
    let serial = serial();
    let before = dev_settings::read(&server, &serial).await.unwrap();
    println!(
        "locale {:?}, settable {}",
        before.locale, before.locale_settable
    );
    let original = before.locale.clone().expect("locale");

    if before.locale_settable {
        let locales = dev_settings::device_locales(&server, &serial)
            .await
            .unwrap();
        println!("{} device locales", locales.len());
        assert!(locales.iter().any(|l| l == "fr-FR"));
        let after = dev_settings::apply(&server, &serial, &DevChange::Locale("fr-FR".into()))
            .await
            .unwrap();
        assert_eq!(after.locale.as_deref(), Some("fr-FR"));
        let bad = dev_settings::apply(&server, &serial, &DevChange::Locale("zz".into())).await;
        println!("invalid tag: {bad:?}");
        assert!(bad.is_err());
        let restored = dev_settings::apply(&server, &serial, &DevChange::Locale(original.clone()))
            .await
            .unwrap();
        assert_eq!(restored.locale.as_deref(), Some(original.as_str()));
    }

    let pkg = "com.android.settings";
    let app_before = dev_settings::app_locales(&server, &serial, pkg)
        .await
        .unwrap();
    let set = dev_settings::set_app_locales(&server, &serial, pkg, &["de-DE".into()])
        .await
        .unwrap();
    assert_eq!(set, vec!["de-DE"]);
    let back = dev_settings::set_app_locales(&server, &serial, pkg, &app_before)
        .await
        .unwrap();
    assert_eq!(back, app_before);
    assert!(
        dev_settings::app_locales(&server, &serial, "no.such.pkg")
            .await
            .is_err()
    );
}

#[tokio::test]
#[ignore = "needs a device"]
async fn counts_connections_on_a_forwarded_port() {
    let server = AdbServer::default();
    let serial = serial();
    // The adb server itself listens on 5037.
    let usage = host_ports::usage(&[5037]);
    println!("{usage:?}");
    let owner = usage[0].listener.as_ref().expect("adb listens on 5037");
    assert_eq!(owner.name.as_deref(), Some("adb"));

    let port = forward::forward(
        &server,
        &serial,
        "tcp:0",
        "localabstract:chrome_devtools_remote",
        false,
    )
    .await
    .unwrap()
    .expect("adb picked a port");
    let mut a = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
    let mut b = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
    let _ = a.write_all(b"GET /json/version HTTP/1.1\r\n\r\n");
    let _ = b.write_all(b"GET /json/version HTTP/1.1\r\n\r\n");
    tokio::time::sleep(Duration::from_millis(300)).await;
    let usage = host_ports::usage(&[port]);
    println!("{usage:?}");
    forward::kill_forward(&server, &serial, &format!("tcp:{port}"))
        .await
        .unwrap();
    assert_eq!(usage[0].connections, 2);
    assert_eq!(
        usage[0].listener.as_ref().and_then(|o| o.name.as_deref()),
        Some("adb")
    );
}
