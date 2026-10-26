//! Mirrors a real device through the bundled scrcpy-server. Needs a running
//! adb server and a device (default `emulator-5554`, override with
//! `MIRROR_SERIAL`):
//!
//! `cargo test --test live_mirror -- --ignored --nocapture --test-threads=1`

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use adb_gui_lib::adb::server::AdbServer;
use adb_gui_lib::mirror::control::{ControlMessage, KeyAction, Position, TouchAction};
use adb_gui_lib::mirror::protocol::{AudioCodec, VideoCodec, record};
use adb_gui_lib::mirror::record::{Recorder, Tap};
use adb_gui_lib::mirror::session::{self, MirrorEvent, MirrorOptions, Running};

fn serial() -> String {
    std::env::var("MIRROR_SERIAL").unwrap_or_else(|_| "emulator-5554".into())
}

fn jar() -> Vec<u8> {
    std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/resources/scrcpy-server"
    ))
    .unwrap()
}

#[derive(Default)]
struct Collected {
    messages: usize,
    bytes: usize,
    sessions: Vec<(u32, u32)>,
    configs: Vec<(String, Vec<u8>)>,
    frames: usize,
    key_frames: usize,
    audio_bytes: usize,
    /// (pts, size) of each audio packet.
    audio_packets: Vec<(u64, usize)>,
    audio_configs: Vec<(String, Vec<u8>)>,
    /// PTS of the first video frame.
    first_video_pts: Option<u64>,
    first_frame: Option<Instant>,
    first_key: Option<Vec<u8>>,
    events: Vec<String>,
}

fn parse(batch: &[u8], c: &mut Collected) {
    c.messages += 1;
    c.bytes += batch.len();
    let mut at = 0;
    while at < batch.len() {
        let kind = batch[at];
        let flags = batch[at + 1];
        let len = u32::from_be_bytes(batch[at + 4..at + 8].try_into().unwrap()) as usize;
        let body = &batch[at + 16..at + 16 + len];
        match kind {
            record::SESSION => c.sessions.push((
                u32::from_be_bytes(body[..4].try_into().unwrap()),
                u32::from_be_bytes(body[4..8].try_into().unwrap()),
            )),
            record::VIDEO_CONFIG => {
                let n = body[0] as usize;
                c.configs.push((
                    String::from_utf8(body[1..1 + n].to_vec()).unwrap(),
                    body[1 + n..].to_vec(),
                ));
            }
            record::VIDEO_FRAME => {
                c.frames += 1;
                c.first_frame.get_or_insert_with(Instant::now);
                c.first_video_pts.get_or_insert(u64::from_be_bytes(
                    batch[at + 8..at + 16].try_into().unwrap(),
                ));
                if flags & record::FLAG_KEY != 0 {
                    c.first_key
                        .get_or_insert_with(|| body[..body.len().min(160)].to_vec());
                    c.key_frames += 1;
                }
            }
            record::AUDIO => {
                c.audio_bytes += len;
                c.audio_packets.push((
                    u64::from_be_bytes(batch[at + 8..at + 16].try_into().unwrap()),
                    len,
                ));
            }
            record::AUDIO_CONFIG => {
                let n = body[0] as usize;
                c.audio_configs.push((
                    String::from_utf8(body[1..1 + n].to_vec()).unwrap(),
                    body[1 + n..].to_vec(),
                ));
            }
            other => panic!("unknown record {other}"),
        }
        at += 16 + len;
    }
}

async fn start(options: MirrorOptions) -> (Running, Arc<Mutex<Collected>>, Instant) {
    start_with(options, Arc::default()).await
}

async fn start_with(
    options: MirrorOptions,
    tap: Arc<Tap>,
) -> (Running, Arc<Mutex<Collected>>, Instant) {
    let collected = Arc::new(Mutex::new(Collected::default()));
    let data = collected.clone();
    let events = collected.clone();
    let started = Instant::now();
    let running = session::start(
        AdbServer::default(),
        &serial(),
        1,
        &jar(),
        &options,
        Arc::new(move |batch| parse(&batch, &mut data.lock().unwrap())),
        Arc::new(move |event| {
            let text = match event {
                MirrorEvent::Clipboard { text } => format!("clipboard:{text}"),
                other => format!("{other:?}"),
            };
            events.lock().unwrap().events.push(text);
        }),
        tap,
    )
    .await
    .expect("session did not start");
    println!("connected in {:?}: {:?}", started.elapsed(), running.info);
    (running, collected, started)
}

fn options() -> MirrorOptions {
    MirrorOptions {
        video_codec: VideoCodec::H264,
        max_size: 1280,
        video_bit_rate: 8_000_000,
        max_fps: 60,
        audio: false,
        audio_codec: AudioCodec::Opus,
        show_touches: false,
        stay_awake: false,
    }
}

async fn shell(cmd: &str) -> String {
    AdbServer::default().shell(&serial(), cmd).await.unwrap()
}

async fn server_running() -> bool {
    shell("ps -A -o ARGS | grep -c '[c]om.genymobile.scrcpy.Server'")
        .await
        .trim()
        != "0"
}

fn send(running: &Running, msg: ControlMessage) {
    running.control.send(msg.encode()).unwrap();
}

async fn swipe(running: &Running, size: (u32, u32), from: (f32, f32), to: (f32, f32)) {
    let (w, h) = size;
    let at = |t: f32| Position {
        x: ((from.0 + (to.0 - from.0) * t) * w as f32) as i32,
        y: ((from.1 + (to.1 - from.1) * t) * h as f32) as i32,
        width: w as u16,
        height: h as u16,
    };
    let touch = |action, t| ControlMessage::Touch {
        action,
        pointer_id: -2,
        position: at(t),
        pressure: 1.0,
        action_button: 0,
        buttons: 0,
    };
    send(running, touch(TouchAction::Down, 0.0));
    for step in 1..=12 {
        tokio::time::sleep(Duration::from_millis(16)).await;
        send(running, touch(TouchAction::Move, step as f32 / 12.0));
    }
    send(running, touch(TouchAction::Up, 1.0));
}

fn key(running: &Running, keycode: u32) {
    for action in [KeyAction::Down, KeyAction::Up] {
        send(
            running,
            ControlMessage::Key {
                action,
                keycode,
                repeat: 0,
                metastate: 0,
            },
        );
    }
}

async fn focused_window() -> String {
    shell("dumpsys window | grep mCurrentFocus").await
}

#[tokio::test]
#[ignore = "needs a device"]
async fn streams_h264_and_injects_input() {
    let (running, collected, started) = start(options()).await;
    let control = running.control.clone();
    let run = tokio::spawn(running.run);
    let running = Running {
        info: running.info,
        control,
        run: Box::pin(std::future::pending()),
    };

    // Frames flow.
    tokio::time::sleep(Duration::from_secs(1)).await;
    key(&running, 3); // HOME
    tokio::time::sleep(Duration::from_secs(2)).await;
    let size = {
        let c = collected.lock().unwrap();
        println!(
            "first frame after {:?}; {} frames ({} key) in {} messages, {} KiB",
            c.first_frame.map(|t| t - started),
            c.frames,
            c.key_frames,
            c.messages,
            c.bytes / 1024
        );
        println!("sessions {:?}", c.sessions);
        for (codec, description) in &c.configs {
            println!("config {codec}: avcC {description:02X?}");
        }
        assert!(!c.sessions.is_empty(), "no session packet");
        assert!(c.configs[0].0.starts_with("avc1."), "{:?}", c.configs);
        assert!(c.key_frames >= 1, "no key frame");
        *c.sessions.last().unwrap()
    };

    // Swipe down from the status bar: the notification shade takes focus.
    swipe(&running, size, (0.5, 0.005), (0.5, 0.7)).await;
    tokio::time::sleep(Duration::from_millis(800)).await;
    let focus = focused_window().await;
    println!("after swipe down: {}", focus.trim());
    assert!(focus.contains("NotificationShade"), "{focus}");
    send(&running, ControlMessage::CollapsePanels);
    tokio::time::sleep(Duration::from_millis(800)).await;
    let focus = focused_window().await;
    println!("after collapse: {}", focus.trim());
    assert!(!focus.contains("NotificationShade"), "{focus}");

    // Throughput while the screen changes (app drawer open and close).
    let before = {
        let c = collected.lock().unwrap();
        (c.frames, c.bytes, Instant::now())
    };
    swipe(&running, size, (0.5, 0.85), (0.5, 0.3)).await;
    tokio::time::sleep(Duration::from_millis(400)).await;
    swipe(&running, size, (0.5, 0.3), (0.5, 0.8)).await;
    tokio::time::sleep(Duration::from_millis(400)).await;
    {
        let c = collected.lock().unwrap();
        let secs = before.2.elapsed().as_secs_f64();
        println!(
            "during motion: {:.1} fps, {:.2} Mbit/s, {} messages total",
            (c.frames - before.0) as f64 / secs,
            (c.bytes - before.1) as f64 * 8.0 / secs / 1e6,
            c.messages
        );
    }
    key(&running, 3);

    // Clipboard over the control socket. With clipboard_autosync the
    // server only reports device-side changes (and suppresses the echo of
    // our own SET_CLIPBOARD), so this is informational.
    let text = format!("tether ✓ {}", session::new_scid());
    send(
        &running,
        ControlMessage::SetClipboard {
            sequence: 0,
            text: text.clone(),
            paste: false,
        },
    );
    tokio::time::sleep(Duration::from_millis(500)).await;
    let events = collected.lock().unwrap().events.clone();
    println!("device messages after SET_CLIPBOARD: {events:?}");

    // Stopping closes the sockets and the server exits on its own.
    assert!(server_running().await);
    run.abort();
    let _ = run.await;
    let deadline = Instant::now() + Duration::from_secs(5);
    while server_running().await {
        assert!(Instant::now() < deadline, "server still running after stop");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    println!("server gone after stop");
    let leftover = shell("ls /data/local/tmp/scrcpy-server.jar 2>&1").await;
    println!("jar after stop: {}", leftover.trim());
}

#[tokio::test]
#[ignore = "needs a device"]
async fn streams_av1() {
    let mut o = options();
    o.video_codec = VideoCodec::Av1;
    // Devices without an AV1 encoder fail here with the server's message.
    let (running, collected, _) = start(o).await;
    let run = tokio::spawn(running.run);
    tokio::time::sleep(Duration::from_secs(2)).await;
    run.abort();
    let c = collected.lock().unwrap();
    for (codec, description) in &c.configs {
        println!("av1 config {codec}: {description:02X?}");
    }
    println!("av1: {} frames ({} key)", c.frames, c.key_frames);
    assert!(c.configs[0].0.starts_with("av01."));
}

#[tokio::test]
#[ignore = "needs a device"]
async fn streams_h265_and_audio() {
    let mut o = options();
    o.video_codec = VideoCodec::H265;
    o.audio = true;
    let (running, collected, _) = start(o).await;
    let run = tokio::spawn(running.run);
    tokio::time::sleep(Duration::from_secs(3)).await;
    run.abort();
    let c = collected.lock().unwrap();
    println!(
        "h265: configs {:?}, {} frames, audio {} KiB, events {:?}",
        c.configs.iter().map(|c| &c.0).collect::<Vec<_>>(),
        c.frames,
        c.audio_bytes / 1024,
        c.events
    );
    assert!(c.configs[0].0.starts_with("hvc1."));
    assert!(c.frames > 0);
}

/// `ffprobe` summary of a file, if ffprobe is installed.
fn ffprobe(path: &std::path::Path) -> Option<String> {
    let out = std::process::Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-count_frames",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=codec_name,width,height,nb_read_frames,duration",
            "-of",
            "default=noprint_wrappers=1",
        ])
        .arg(path)
        .output()
        .ok()?;
    assert!(
        out.status.success(),
        "ffprobe failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Records a few seconds of the live stream per codec into MP4 and checks
/// the file with ffprobe (decodes every frame) when it is available.
/// `KEEP_RECORDINGS=<dir>` keeps copies of the files.
#[tokio::test]
#[ignore = "needs a device"]
async fn records_mp4() {
    let dir = tempfile::tempdir().unwrap();
    for codec in [VideoCodec::H264, VideoCodec::H265, VideoCodec::Av1] {
        let mut o = options();
        o.video_codec = codec;
        let tap = Arc::new(Tap::default());
        let (running, collected, _) = start_with(o, tap.clone()).await;
        let control = running.control.clone();
        let run = tokio::spawn(running.run);
        let running = Running {
            info: running.info,
            control,
            run: Box::pin(std::future::pending()),
        };
        tokio::time::sleep(Duration::from_millis(1500)).await;
        if codec == VideoCodec::H265 {
            let c = collected.lock().unwrap();
            println!("h265 first key frame: {:02X?}", c.first_key);
        }

        let path = dir.path().join(format!("{codec:?}.mp4"));
        let recorder = Recorder::start(
            codec,
            path.clone(),
            Box::new(|p| println!("  progress {p:?}")),
            Box::new(|r| panic!("unexpected end: {r:?}")),
        )
        .unwrap();
        tap.attach(recorder).unwrap();
        send(&running, ControlMessage::ResetVideo);
        let size = *collected.lock().unwrap().sessions.last().unwrap();
        for _ in 0..2 {
            swipe(&running, size, (0.5, 0.85), (0.5, 0.3)).await;
            tokio::time::sleep(Duration::from_millis(700)).await;
            swipe(&running, size, (0.5, 0.3), (0.5, 0.8)).await;
            tokio::time::sleep(Duration::from_millis(700)).await;
        }
        let saved = tap.detach().unwrap().stop().await.unwrap();
        run.abort();
        println!("{codec:?}: {saved:?}");
        assert!(saved.summary.frames > 10, "{saved:?}");
        assert!(saved.summary.duration_ms > 2000, "{saved:?}");
        if let Some(probe) = ffprobe(&path) {
            println!("{probe}");
            let frames: usize = probe
                .lines()
                .find_map(|l| l.strip_prefix("nb_read_frames="))
                .and_then(|n| n.parse().ok())
                .unwrap_or(0);
            assert_eq!(frames, saved.summary.frames, "every sample decodes");
        }
        if let Some(keep) = std::env::var_os("KEEP_RECORDINGS") {
            let name = path.file_name().unwrap();
            std::fs::copy(&path, std::path::Path::new(&keep).join(name)).unwrap();
        }
        // Let the server exit before the next codec.
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

/// Every stream of a file as ffprobe sees it after decoding all packets.
fn ffprobe_streams(path: &std::path::Path) -> Option<String> {
    let out = std::process::Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-count_frames",
            "-show_entries",
            "stream=index,codec_type,codec_name,channels,sample_rate,nb_read_frames,start_time,duration",
            "-of",
            "compact",
        ])
        .arg(path)
        .output()
        .ok()?;
    assert!(
        out.status.success(),
        "ffprobe failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Decodes the whole file with ffmpeg; returns its error lines and the
/// mean volume of the audio.
fn ffmpeg_decode(path: &std::path::Path) -> Option<(String, String)> {
    let out = std::process::Command::new("ffmpeg")
        .args(["-hide_banner", "-nostats", "-v", "info", "-i"])
        .arg(path)
        // Audio only: ffprobe already decoded the video, and the null
        // muxer complains about variable-rate video timestamps.
        .args(["-map", "0:a", "-af", "volumedetect", "-f", "null", "-"])
        .output()
        .ok()?;
    let log = String::from_utf8_lossy(&out.stderr).into_owned();
    let errors = log
        .lines()
        .filter(|l| l.contains("rror") || l.contains("nvalid"))
        .collect::<Vec<_>>()
        .join("\n");
    let volume = log
        .lines()
        .find(|l| l.contains("mean_volume"))
        .unwrap_or("")
        .to_owned();
    Some((errors, volume))
}

fn field(line: &str, name: &str) -> usize {
    line.split('|')
        .find_map(|f| f.strip_prefix(name))
        .and_then(|n| n.parse().ok())
        .unwrap_or(0)
}

/// Streams Opus audio next to the video, records both into one MP4 and
/// checks with ffprobe/ffmpeg that the audio track decodes and lines up.
#[tokio::test]
#[ignore = "needs a device with Android 11+"]
async fn records_mp4_with_opus_audio() {
    let dir = tempfile::tempdir().unwrap();
    let mut o = options();
    o.audio = true;
    o.audio_codec = AudioCodec::Opus;
    let tap = Arc::new(Tap::default());
    let (running, collected, _) = start_with(o, tap.clone()).await;
    let control = running.control.clone();
    let run = tokio::spawn(running.run);
    let running = Running {
        info: running.info,
        control,
        run: Box::pin(std::future::pending()),
    };
    tokio::time::sleep(Duration::from_millis(1500)).await;
    {
        let c = collected.lock().unwrap();
        println!("audio configs {:02X?}", c.audio_configs);
        println!("events {:?}", c.events);
        assert_eq!(c.audio_configs.len(), 1, "{:?}", c.events);
        assert_eq!(c.audio_configs[0].0, "opus");
        assert_eq!(&c.audio_configs[0].1[..8], b"OpusHead");
        let first_audio = c.audio_packets.first().map(|p| p.0).unwrap();
        let first_video = c.first_video_pts.unwrap();
        println!(
            "{} audio packets, first audio pts {first_audio} µs, first video pts \
             {first_video} µs (diff {} ms)",
            c.audio_packets.len(),
            (first_audio as i64 - first_video as i64) / 1000
        );
        let deltas: Vec<i64> = c
            .audio_packets
            .windows(2)
            .take(8)
            .map(|w| w[1].0 as i64 - w[0].0 as i64)
            .collect();
        println!("audio pts deltas {deltas:?}");
        // Same clock: both started within a few seconds of each other.
        assert!((first_audio as i64 - first_video as i64).abs() < 5_000_000);
    }

    let path = dir.path().join("opus.mp4");
    let recorder = Recorder::start(
        VideoCodec::H264,
        path.clone(),
        Box::new(|_| {}),
        Box::new(|r| panic!("unexpected end: {r:?}")),
    )
    .unwrap();
    tap.attach(recorder).unwrap();
    send(&running, ControlMessage::ResetVideo);
    let size = *collected.lock().unwrap().sessions.last().unwrap();
    for _ in 0..2 {
        swipe(&running, size, (0.5, 0.85), (0.5, 0.3)).await;
        tokio::time::sleep(Duration::from_millis(900)).await;
        swipe(&running, size, (0.5, 0.3), (0.5, 0.8)).await;
        tokio::time::sleep(Duration::from_millis(900)).await;
    }
    let saved = tap.detach().unwrap().stop().await.unwrap();
    run.abort();
    println!("{saved:?}");
    assert!(saved.summary.frames > 10, "{saved:?}");
    // ~50 packets a second of 20 ms.
    assert!(saved.summary.audio_packets > 100, "{saved:?}");

    if let Some(probe) = ffprobe_streams(&path) {
        println!("{probe}");
        let audio = probe
            .lines()
            .find(|l| l.contains("codec_type=audio"))
            .expect("no audio stream");
        assert!(audio.contains("codec_name=opus"), "{audio}");
        assert!(audio.contains("sample_rate=48000"), "{audio}");
        assert!(audio.contains("channels=2"), "{audio}");
        assert_eq!(
            field(audio, "nb_read_frames="),
            saved.summary.audio_packets,
            "every packet decodes"
        );
        let video = probe
            .lines()
            .find(|l| l.contains("codec_type=video"))
            .unwrap();
        assert_eq!(field(video, "nb_read_frames="), saved.summary.frames);
    }
    if let Some((errors, volume)) = ffmpeg_decode(&path) {
        println!("ffmpeg decode: {volume}");
        assert!(errors.is_empty(), "{errors}");
    }
    if let Some(keep) = std::env::var_os("KEEP_RECORDINGS") {
        std::fs::copy(&path, std::path::Path::new(&keep).join("opus.mp4")).unwrap();
    }
}
