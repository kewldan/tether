//! Compressed transfers (`sendrecv_v2`) against a real device, with a
//! small benchmark: a compressible log and random bytes, pushed and pulled
//! with every codec the device offers and without compression. Everything
//! lives under `/data/local/tmp/tether-test` and is removed afterwards.
//!
//! `cargo test --test live_compression -- --ignored --nocapture`
//! (`TETHER_SERIAL` picks a device, `TETHER_BENCH_MB` the file size).

use std::path::Path;
use std::time::Instant;

use adb_gui_lib::adb::compression::Compression;
use adb_gui_lib::adb::server::AdbServer;
use adb_gui_lib::adb::sync::{CompressionFeatures, device_features};
use adb_gui_lib::device::files;
use adb_gui_lib::device::transfer::{self, CompressionMode, TransferControl, TransferOptions};

const DIR: &str = "/data/local/tmp/tether-test/compression";

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

fn log_like(size: usize) -> Vec<u8> {
    let tags = [
        "ActivityManager",
        "WindowManager",
        "chatty",
        "Tether",
        "art",
    ];
    let mut out = Vec::with_capacity(size + 200);
    let mut i = 0u64;
    while out.len() < size {
        let line = format!(
            "10-26 12:{:02}:{:02}.{:03} {:5} {:5} I {}: event {} state={} took {}ms\n",
            (i / 60_000) % 60,
            (i / 1000) % 60,
            i % 1000,
            1000 + i % 37,
            2000 + i % 91,
            tags[(i % 5) as usize],
            i,
            i % 7,
            (i * 7919) % 431
        );
        out.extend_from_slice(line.as_bytes());
        i += 1;
    }
    out.truncate(size);
    out
}

fn random(size: usize) -> Vec<u8> {
    // xorshift: incompressible enough, no extra dependency.
    let mut x = 0x9E37_79B9_7F4A_7C15u64;
    (0..size)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            (x >> 24) as u8
        })
        .collect()
}

fn mbps(bytes: usize, secs: f64) -> f64 {
    bytes as f64 / secs / 1_000_000.0
}

#[tokio::test]
#[ignore = "needs a device"]
async fn compressed_roundtrip_and_benchmark() {
    let server = AdbServer::default();
    let serial = serial(&server).await;
    let features = CompressionFeatures::parse(&device_features(&server, &serial).await.unwrap());
    println!("device codecs: {features:?}");
    let mb: usize = std::env::var("TETHER_BENCH_MB")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(64);
    let size = mb * 1024 * 1024;

    files::delete(&server, &serial, &[DIR.into()])
        .await
        .unwrap();
    files::mkdirs(&server, &serial, &[DIR.into()])
        .await
        .unwrap();
    let local = tempfile::tempdir().unwrap();

    let mut modes = vec![("plain", CompressionMode::Off)];
    for codec in [Compression::Lz4, Compression::Zstd, Compression::Brotli] {
        if features.supports(codec) {
            modes.push((codec.name(), CompressionMode::Force(codec)));
        }
    }

    println!("| data | mode | push MB/s | pull MB/s |");
    println!("|---|---|---|---|");
    for (label, data) in [("log", log_like(size)), ("random", random(size))] {
        for (name, mode) in &modes {
            let options = TransferOptions { compression: *mode };
            let file = local.path().join(format!("{label}-{name}.bin"));
            std::fs::write(&file, &data).unwrap();
            let control = TransferControl::default();

            let t = Instant::now();
            let pushed = transfer::push_with_options(
                &server,
                &serial,
                std::slice::from_ref(&file),
                DIR,
                &control,
                options,
                |_| {},
            )
            .await
            .unwrap();
            let push_secs = t.elapsed().as_secs_f64();
            let remote = &pushed.destinations[0];

            let out = tempfile::tempdir().unwrap();
            let t = Instant::now();
            let pulled = transfer::pull_with_options(
                &server,
                &serial,
                std::slice::from_ref(remote),
                out.path(),
                &control,
                options,
                |_| {},
            )
            .await
            .unwrap();
            let pull_secs = t.elapsed().as_secs_f64();
            let back = std::fs::read(Path::new(&pulled.destinations[0])).unwrap();
            assert!(back == data, "{label} via {name} came back different");
            println!(
                "| {label} {mb} MiB | {name} | {:.0} | {:.0} |",
                mbps(size, push_secs),
                mbps(size, pull_secs)
            );
            files::delete(&server, &serial, std::slice::from_ref(remote))
                .await
                .unwrap();
        }
    }

    files::delete(&server, &serial, &[DIR.into()])
        .await
        .unwrap();
}
