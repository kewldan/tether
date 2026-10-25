//! Shell, ports, intents and performance against a real device. Uses
//! `$TETHER_SERIAL` or the first online device. Run with
//! `cargo test --test live_tools -- --ignored --nocapture --test-threads 1`.

use std::time::Duration;

use adb_gui_lib::adb::devices::{self, DeviceState};
use adb_gui_lib::adb::forward::{self, Direction};
use adb_gui_lib::adb::server::AdbServer;
use adb_gui_lib::adb::shell_v2::{self, PacketDecoder, PtyOptions};
use adb_gui_lib::device::intents::{self, Extra, ExtraType, IntentKind, IntentSpec, Outcome};
use adb_gui_lib::device::perf::{self, Sampler};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

async fn serial(server: &AdbServer) -> String {
    if let Ok(s) = std::env::var("TETHER_SERIAL") {
        return s;
    }
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let server = *server;
    let tracker = tokio::spawn(async move {
        devices::track(&server, |list| {
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
#[ignore = "needs a device"]
async fn shell_v2_runs_commands_and_ptys() {
    let server = AdbServer::default();
    let serial = serial(&server).await;
    assert!(shell_v2::supports_shell_v2(&server, &serial).await.unwrap());

    let out = shell_v2::run(&server, &serial, "echo hi; echo err >&2; exit 3")
        .await
        .unwrap();
    assert_eq!(out.stdout, "hi\n");
    assert_eq!(out.stderr, "err\n");
    assert_eq!(out.exit_code, Some(3));

    let opts = PtyOptions {
        term: "xterm-256color".into(),
        rows: 30,
        cols: 100,
        command: None,
    };
    let mut shell = shell_v2::open_pty(&server, &serial, &opts).await.unwrap();
    assert!(shell.v2);
    let stream = &mut shell.stream;
    stream
        .write_all(&shell_v2::encode_stdin(b"stty size; echo $((6*7))\n"))
        .await
        .unwrap();
    let mut decoder = PacketDecoder::default();
    let mut text = String::new();
    let mut buf = [0u8; 4096];
    while !text.contains("42\r\n") {
        let n = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut buf))
            .await
            .expect("no output")
            .unwrap();
        decoder.push(&buf[..n]);
        while let Some(p) = decoder.next_packet() {
            text.push_str(&String::from_utf8_lossy(&p.data));
        }
    }
    println!("pty output: {text:?}");
    assert!(text.contains("30 100"), "window size not applied");

    stream
        .write_all(&shell_v2::encode_window_size(40, 132, 0, 0))
        .await
        .unwrap();
    stream
        .write_all(&shell_v2::encode_stdin(b"stty size; exit 7\n"))
        .await
        .unwrap();
    let mut exit = None;
    let mut text = String::new();
    while exit.is_none() {
        let n = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut buf))
            .await
            .expect("no exit")
            .unwrap();
        if n == 0 {
            break;
        }
        decoder.push(&buf[..n]);
        while let Some(p) = decoder.next_packet() {
            if p.id == shell_v2::ID_EXIT {
                exit = p.data.first().copied();
            } else {
                text.push_str(&String::from_utf8_lossy(&p.data));
            }
        }
    }
    assert!(text.contains("40 132"), "resize not applied: {text:?}");
    assert_eq!(exit, Some(7));
}

#[tokio::test]
#[ignore = "needs a device"]
async fn forwards_and_reverses_ports() {
    let server = AdbServer::default();
    let serial = serial(&server).await;

    let port = forward::forward(&server, &serial, "tcp:0", "tcp:39130", false)
        .await
        .unwrap()
        .expect("adb picks a port for tcp:0");
    let local = format!("tcp:{port}");
    let list = forward::list_forward(&server, &serial).await.unwrap();
    println!("forward: {list:?}");
    assert!(
        list.iter()
            .any(|r| r.local == local && r.remote == "tcp:39130")
    );

    let err = forward::forward(&server, &serial, &local, "tcp:1", true)
        .await
        .unwrap_err();
    println!("norebind error: {err}");
    forward::kill_forward(&server, &serial, &local)
        .await
        .unwrap();
    assert!(
        forward::kill_forward(&server, &serial, &local)
            .await
            .is_err()
    );

    let busy = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let busy_port = busy.local_addr().unwrap().port();
    let err = forward::forward(
        &server,
        &serial,
        &format!("tcp:{busy_port}"),
        "tcp:1",
        false,
    )
    .await
    .unwrap_err();
    assert!(forward::is_address_in_use(&err.to_string()), "{err}");

    forward::reverse(&server, &serial, "tcp:39131", "tcp:39132", false)
        .await
        .unwrap();
    let list = forward::list_reverse(&server, &serial).await.unwrap();
    println!("reverse: {list:?}");
    assert!(list.iter().any(|r| r.direction == Direction::Reverse
        && r.local == "tcp:39131"
        && r.remote == "tcp:39132"));
    forward::kill_reverse(&server, &serial, "tcp:39131")
        .await
        .unwrap();
    assert!(
        forward::kill_reverse(&server, &serial, "tcp:39131")
            .await
            .is_err()
    );
}

#[tokio::test]
#[ignore = "needs a device"]
async fn sends_intents_and_keys() {
    let server = AdbServer::default();
    let serial = serial(&server).await;

    let broadcast = IntentSpec {
        action: "com.tether.test.PING".into(),
        extras: vec![
            Extra {
                key: "note".into(),
                kind: ExtraType::String,
                value: "it's a $test & more".into(),
            },
            Extra {
                key: "n".into(),
                kind: ExtraType::Int,
                value: "2".into(),
            },
        ],
        ..Default::default()
    };
    let r = intents::send(&server, &serial, IntentKind::Broadcast, &broadcast)
        .await
        .unwrap();
    println!("broadcast: {r:?}");
    assert_eq!(r.outcome, Outcome::Ok);
    assert_eq!(r.broadcast_result, Some(0));

    let unresolved = IntentSpec {
        action: "android.intent.action.VIEW".into(),
        data: "tether-test-nothing://x?a=1&b=2".into(),
        ..Default::default()
    };
    let r = intents::send(&server, &serial, IntentKind::Activity, &unresolved)
        .await
        .unwrap();
    println!("unresolved: {r:?}");
    assert_eq!(r.outcome, Outcome::Error);
    assert_eq!(r.error_kind.as_deref(), Some("unresolved"));

    let service = IntentSpec {
        component: "com.tether.none/.Svc".into(),
        ..Default::default()
    };
    let r = intents::send(&server, &serial, IntentKind::Service, &service)
        .await
        .unwrap();
    assert_eq!(r.error_kind.as_deref(), Some("not_found"));

    // KEYCODE_UNKNOWN does nothing on screen.
    intents::input_key(&server, &serial, "0").await.unwrap();
}

#[tokio::test]
#[ignore = "needs a device"]
async fn samples_performance_and_processes() {
    let server = AdbServer::default();
    let serial = serial(&server).await;

    let cpu = perf::cpu_info(&server, &serial).await.unwrap();
    println!("cpu: {cpu:?}");
    assert!(cpu.cores > 0);

    let mut sampler = Sampler::new(Some("com.android.systemui".into())).unwrap();
    let first = sampler.sample(&server, &serial).await.unwrap();
    tokio::time::sleep(Duration::from_secs(1)).await;
    let second = sampler.sample(&server, &serial).await.unwrap();
    println!("sample: {second:#?}");
    assert!(first.cpu.is_none());
    assert!(second.cpu.is_some());
    assert_eq!(second.cores.len() as u32, cpu.cores);
    assert!(second.memory.total_kb > 0);
    assert!(second.network.is_some());
    assert!(second.battery.level.is_some());
    assert!(second.frames.is_some(), "systemui renders frames");
    assert!(second.package_pss_kb.is_some());

    let procs = perf::processes(&server, &serial).await.unwrap();
    println!("{} processes", procs.len());
    assert!(procs.iter().any(|p| p.name == "system_server"));

    // Keep the parent shell alive while killing its child: adbd tears
    // down the process group when the service closes.
    let mut holder = server
        .open_device(&serial, "shell,v2,raw:sleep 60 & echo $!; wait")
        .await
        .unwrap();
    let mut decoder = PacketDecoder::default();
    let mut buf = [0u8; 256];
    let pid: u32 = loop {
        let n = holder.read(&mut buf).await.unwrap();
        decoder.push(&buf[..n]);
        if let Some(p) = decoder.next_packet() {
            break String::from_utf8_lossy(&p.data).trim().parse().unwrap();
        }
    };
    perf::kill(&server, &serial, pid, None).await.unwrap();
    assert!(perf::kill(&server, &serial, 1, None).await.is_err());
}
