//! `adb sideload`: streams an OTA package to a device in recovery's
//! "Apply update from ADB" mode (minadbd).
//!
//! Modern recoveries (Android 4.4+) use `sideload-host:<size>:<block>`:
//! the device asks for blocks by number — an 8-byte ASCII decimal, in any
//! order and possibly more than once — and we answer each with that block
//! of the file. The device ends the session with `DONEDONE` (installed) or
//! `FAILFAIL` (rejected). Older ones only know `sideload:<size>`, a plain
//! upload followed by an `OKAY`/`FAIL` status. Mirrors AOSP
//! `adb/client/commandline.cpp` (`adb_sideload_install`,
//! `adb_sideload_legacy`).

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::Serialize;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncSeek, AsyncSeekExt, AsyncWrite, AsyncWriteExt};

use super::server::{AdbServer, read_length_prefixed, send_request};
use crate::error::{AppError, AppResult};

/// `SIDELOAD_HOST_BLOCK_SIZE` in AOSP.
pub const BLOCK_SIZE: u64 = 64 * 1024;
/// Chunk size of the legacy upload (`CHUNK_SIZE` in AOSP).
const LEGACY_CHUNK: usize = 64 * 1024;
const EXIT_SUCCESS: &[u8; 8] = b"DONEDONE";
const EXIT_FAILURE: &[u8; 8] = b"FAILFAIL";
const CANCEL_POLL: Duration = Duration::from_millis(100);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SideloadMode {
    /// `sideload-host:` — the device pulls blocks.
    Host,
    /// `sideload:` — pre-KitKat push of the whole file.
    Legacy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    /// Bytes sent so far. With `sideload-host` this grows past the file
    /// size: recovery reads the package once to verify it and again to
    /// install it.
    pub transferred: u64,
    pub size: u64,
    /// adb's own estimate, 0..=100: `transferred * 47 / size` for
    /// `sideload-host` (100% ≈ 2.13× the size), plain upload share for
    /// legacy.
    pub percent: u8,
}

pub fn host_service(size: u64) -> String {
    format!("sideload-host:{size}:{BLOCK_SIZE}")
}

pub fn legacy_service(size: u64) -> String {
    format!("sideload:{size}")
}

/// Sideloads `path` to `serial`, trying `sideload-host` first and falling
/// back to legacy `sideload` when the device refuses the service (and the
/// file is small enough for it, like adb does).
pub async fn sideload(
    server: &AdbServer,
    serial: &str,
    path: &Path,
    cancel: &AtomicBool,
    mut on_progress: impl FnMut(SideloadMode, Progress),
) -> AppResult<SideloadMode> {
    let mut file = tokio::fs::File::open(path).await?;
    let size = file.metadata().await?.len();
    if size == 0 {
        return Err(AppError::InvalidInput("the package is empty".into()));
    }

    match open_service(server, serial, &host_service(size)).await {
        Ok(mut stream) => {
            serve_blocks(&mut stream, &mut file, size, cancel, |p| {
                on_progress(SideloadMode::Host, p)
            })
            .await?;
            Ok(SideloadMode::Host)
        }
        Err(AppError::AdbFailure(message)) => {
            if i32::try_from(size).is_err() {
                return Err(AppError::Device(format!(
                    "the device refused sideload-host ({message}) and the package is too \
                     large for the legacy sideload"
                )));
            }
            let mut stream = open_service(server, serial, &legacy_service(size)).await?;
            file.seek(std::io::SeekFrom::Start(0)).await?;
            send_legacy(&mut stream, &mut file, size, cancel, |p| {
                on_progress(SideloadMode::Legacy, p)
            })
            .await?;
            Ok(SideloadMode::Legacy)
        }
        Err(other) => Err(other),
    }
}

/// Switches to the device first, so "device not found" is not mistaken
/// for a refused service (which triggers the legacy fallback).
async fn open_service(
    server: &AdbServer,
    serial: &str,
    service: &str,
) -> AppResult<tokio::net::TcpStream> {
    let mut stream = server
        .open(&format!("host:transport:{serial}"))
        .await
        .map_err(|e| match e {
            AppError::AdbFailure(m) => AppError::Device(m),
            other => other,
        })?;
    send_request(&mut stream, service).await?;
    Ok(stream)
}

/// Answers the device's block requests until it reports the result.
pub async fn serve_blocks<S, F>(
    stream: &mut S,
    file: &mut F,
    size: u64,
    cancel: &AtomicBool,
    mut on_progress: impl FnMut(Progress),
) -> AppResult<()>
where
    S: AsyncRead + AsyncWrite + Unpin,
    F: AsyncRead + AsyncSeek + Unpin,
{
    let block_len = usize::try_from(BLOCK_SIZE).unwrap_or(usize::MAX);
    let mut buf = vec![0u8; block_len];
    let mut transferred = 0u64;
    loop {
        let mut request = [0u8; 8];
        tokio::select! {
            read = stream.read_exact(&mut request) => {
                read.map_err(|e| match e.kind() {
                    std::io::ErrorKind::UnexpectedEof => AppError::Device(
                        "the device closed the connection before finishing the update".into(),
                    ),
                    _ => AppError::Io(e),
                })?;
            }
            () = cancelled(cancel) => return Err(AppError::Cancelled),
        }

        if &request == EXIT_SUCCESS {
            return Ok(());
        }
        if &request == EXIT_FAILURE {
            return Err(AppError::Device(
                "recovery rejected the package; the phone's screen shows why".into(),
            ));
        }

        let block = parse_block(&request)?;
        let offset = block
            .checked_mul(BLOCK_SIZE)
            .filter(|&o| o < size)
            .ok_or_else(|| {
                AppError::Protocol(format!(
                    "the device asked for block {block}, past the end of the {size}-byte package"
                ))
            })?;
        let len = usize::try_from((size - offset).min(BLOCK_SIZE)).unwrap_or(block_len);

        file.seek(std::io::SeekFrom::Start(offset)).await?;
        file.read_exact(&mut buf[..len]).await?;
        stream.write_all(&buf[..len]).await?;

        transferred += len as u64;
        on_progress(Progress {
            transferred,
            size,
            percent: host_percent(transferred, size),
        });
        if cancel.load(Ordering::Relaxed) {
            return Err(AppError::Cancelled);
        }
    }
}

/// Pre-KitKat `sideload:`: send the whole file, then read the status.
pub async fn send_legacy<S, F>(
    stream: &mut S,
    file: &mut F,
    size: u64,
    cancel: &AtomicBool,
    mut on_progress: impl FnMut(Progress),
) -> AppResult<()>
where
    S: AsyncRead + AsyncWrite + Unpin,
    F: AsyncRead + Unpin,
{
    let mut buf = vec![0u8; LEGACY_CHUNK];
    let mut sent = 0u64;
    while sent < size {
        if cancel.load(Ordering::Relaxed) {
            return Err(AppError::Cancelled);
        }
        let len = usize::try_from((size - sent).min(LEGACY_CHUNK as u64)).unwrap_or(LEGACY_CHUNK);
        file.read_exact(&mut buf[..len]).await?;
        stream.write_all(&buf[..len]).await?;
        sent += len as u64;
        on_progress(Progress {
            transferred: sent,
            size,
            percent: u8::try_from(sent * 100 / size).unwrap_or(100),
        });
    }
    stream.flush().await?;

    let mut status = [0u8; 4];
    stream.read_exact(&mut status).await?;
    match &status {
        b"OKAY" => Ok(()),
        b"FAIL" => Err(AppError::Device(read_length_prefixed(stream).await?)),
        other => Err(AppError::Protocol(format!(
            "unexpected sideload status {:?}",
            String::from_utf8_lossy(other)
        ))),
    }
}

/// `strtoll` on the 8-byte request (minadbd sends `%08u`).
fn parse_block(request: &[u8; 8]) -> AppResult<u64> {
    let text = std::str::from_utf8(request)
        .ok()
        .map(|s| s.trim_matches(|c: char| c == '\0' || c.is_ascii_whitespace()))
        .filter(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()));
    text.and_then(|s| s.parse().ok()).ok_or_else(|| {
        AppError::Protocol(format!(
            "bad block request {:?}",
            String::from_utf8_lossy(request)
        ))
    })
}

fn host_percent(transferred: u64, size: u64) -> u8 {
    let pct = u128::from(transferred) * 47 / u128::from(size.max(1));
    u8::try_from(pct.min(100)).unwrap_or(100)
}

async fn cancelled(flag: &AtomicBool) {
    while !flag.load(Ordering::Relaxed) {
        tokio::time::sleep(CANCEL_POLL).await;
    }
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;
    use std::net::SocketAddr;

    use tokio::io::{DuplexStream, duplex};
    use tokio::net::TcpListener;

    use super::*;

    fn package(len: usize) -> Vec<u8> {
        (0..len).map(|i| (i * 31 % 251) as u8).collect()
    }

    /// minadbd's side: asks for `blocks`, checks each answer against the
    /// package, then sends `last`.
    async fn fake_recovery(
        mut device: DuplexStream,
        data: Vec<u8>,
        blocks: Vec<u64>,
        last: &'static [u8; 8],
    ) -> usize {
        let mut served = 0;
        for block in blocks {
            device
                .write_all(format!("{block:08}").as_bytes())
                .await
                .unwrap();
            let start = usize::try_from(block * BLOCK_SIZE).unwrap();
            let end = (start + BLOCK_SIZE as usize).min(data.len());
            let mut got = vec![0u8; end - start];
            device.read_exact(&mut got).await.unwrap();
            assert_eq!(got, data[start..end], "block {block}");
            served += got.len();
        }
        device.write_all(last).await.unwrap();
        served
    }

    #[test]
    fn services_match_adb() {
        assert_eq!(host_service(2_310_000), "sideload-host:2310000:65536");
        assert_eq!(legacy_service(1234), "sideload:1234");
    }

    #[test]
    fn parses_block_numbers() {
        assert_eq!(parse_block(b"00000000").unwrap(), 0);
        assert_eq!(parse_block(b"00012345").unwrap(), 12345);
        assert_eq!(parse_block(b"42\0\0\0\0\0\0").unwrap(), 42);
        assert!(parse_block(b"0000ab12").is_err());
        assert!(parse_block(b"\0\0\0\0\0\0\0\0").is_err());
    }

    #[test]
    fn percent_follows_adb_estimate() {
        assert_eq!(host_percent(0, 100), 0);
        assert_eq!(host_percent(100, 100), 47);
        assert_eq!(host_percent(213, 100), 100);
        assert_eq!(host_percent(500, 100), 100);
    }

    #[tokio::test]
    async fn serves_blocks_in_any_order_until_done() {
        // 3.5 blocks: the last one is short.
        let data = package(BLOCK_SIZE as usize * 3 + 1000);
        let size = data.len() as u64;
        let (mut host, device) = duplex(256 * 1024);
        // Verification pass, then an install pass that re-reads blocks.
        let order = vec![3, 0, 1, 2, 0, 1, 2, 3, 3];
        let device_task = tokio::spawn(fake_recovery(device, data.clone(), order, EXIT_SUCCESS));

        let mut file = Cursor::new(data);
        let mut seen = Vec::new();
        let cancel = AtomicBool::new(false);
        serve_blocks(&mut host, &mut file, size, &cancel, |p| seen.push(p))
            .await
            .unwrap();

        let served = device_task.await.unwrap();
        assert_eq!(seen.len(), 9);
        let last = seen.last().unwrap();
        assert_eq!(last.transferred, served as u64);
        assert_eq!(last.size, size);
        assert_eq!(last.percent, host_percent(served as u64, size));
        assert!(seen.windows(2).all(|w| w[0].transferred < w[1].transferred));
    }

    #[tokio::test]
    async fn failfail_is_an_error() {
        let data = package(10_000);
        let (mut host, device) = duplex(64 * 1024);
        tokio::spawn(fake_recovery(device, data.clone(), vec![0], EXIT_FAILURE));
        let cancel = AtomicBool::new(false);
        let err = serve_blocks(&mut host, &mut Cursor::new(data), 10_000, &cancel, |_| {})
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Device(m) if m.contains("rejected")));
    }

    #[tokio::test]
    async fn block_past_the_end_is_a_protocol_error() {
        let data = package(10_000);
        let (mut host, mut device) = duplex(64 * 1024);
        tokio::spawn(async move {
            device.write_all(b"00000001").await.unwrap();
            // Keep the pipe open until the host gives up.
            let mut sink = Vec::new();
            let _ = device.read_to_end(&mut sink).await;
        });
        let cancel = AtomicBool::new(false);
        let err = serve_blocks(&mut host, &mut Cursor::new(data), 10_000, &cancel, |_| {})
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Protocol(m) if m.contains("block 1")));
    }

    #[tokio::test]
    async fn early_close_is_reported() {
        let data = package(10_000);
        let (mut host, device) = duplex(64 * 1024);
        drop(device);
        let cancel = AtomicBool::new(false);
        let err = serve_blocks(&mut host, &mut Cursor::new(data), 10_000, &cancel, |_| {})
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Device(_)));
    }

    #[tokio::test]
    async fn cancel_stops_a_waiting_session() {
        let data = package(10_000);
        // The device never asks for anything.
        let (mut host, _device) = duplex(64 * 1024);
        let cancel = AtomicBool::new(true);
        let err = serve_blocks(&mut host, &mut Cursor::new(data), 10_000, &cancel, |_| {})
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Cancelled));
    }

    #[tokio::test]
    async fn legacy_upload_then_status() {
        let data = package(LEGACY_CHUNK * 2 + 77);
        let size = data.len() as u64;
        let expected = data.clone();
        let (mut host, mut device) = duplex(512 * 1024);
        let device_task = tokio::spawn(async move {
            let mut got = vec![0u8; expected.len()];
            device.read_exact(&mut got).await.unwrap();
            device.write_all(b"OKAY").await.unwrap();
            got == expected
        });
        let mut percents = Vec::new();
        let cancel = AtomicBool::new(false);
        send_legacy(&mut host, &mut Cursor::new(data), size, &cancel, |p| {
            percents.push(p.percent)
        })
        .await
        .unwrap();
        assert!(device_task.await.unwrap());
        assert_eq!(percents.last(), Some(&100));
    }

    #[tokio::test]
    async fn legacy_fail_status_carries_message() {
        let data = package(100);
        let (mut host, mut device) = duplex(64 * 1024);
        tokio::spawn(async move {
            let mut got = vec![0u8; 100];
            device.read_exact(&mut got).await.unwrap();
            device.write_all(b"FAIL0010signature failed").await.unwrap();
        });
        let cancel = AtomicBool::new(false);
        let err = send_legacy(&mut host, &mut Cursor::new(data), 100, &cancel, |_| {})
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Device(m) if m == "signature failed"));
    }

    /// Reads one smart-socket request from a fake adb server connection.
    async fn read_request(sock: &mut tokio::net::TcpStream) -> String {
        let mut len = [0u8; 4];
        sock.read_exact(&mut len).await.unwrap();
        let len = usize::from_str_radix(std::str::from_utf8(&len).unwrap(), 16).unwrap();
        let mut body = vec![0u8; len];
        sock.read_exact(&mut body).await.unwrap();
        String::from_utf8(body).unwrap()
    }

    /// A fake adb server whose device either speaks `sideload-host` or
    /// only legacy `sideload`. Returns the requests it saw.
    async fn fake_server(
        data: Vec<u8>,
        modern: bool,
    ) -> (SocketAddr, tokio::task::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let mut seen = Vec::new();
            loop {
                let (mut sock, _) = listener.accept().await.unwrap();
                let transport = read_request(&mut sock).await;
                seen.push(transport);
                sock.write_all(b"OKAY").await.unwrap();
                let service = read_request(&mut sock).await;
                seen.push(service.clone());
                if service.starts_with("sideload-host:") {
                    if !modern {
                        sock.write_all(b"FAIL000eclosed service").await.unwrap();
                        continue;
                    }
                    sock.write_all(b"OKAY").await.unwrap();
                    let blocks = data.len().div_ceil(BLOCK_SIZE as usize);
                    for block in 0..blocks {
                        sock.write_all(format!("{block:08}").as_bytes())
                            .await
                            .unwrap();
                        let start = block * BLOCK_SIZE as usize;
                        let end = (start + BLOCK_SIZE as usize).min(data.len());
                        let mut got = vec![0u8; end - start];
                        sock.read_exact(&mut got).await.unwrap();
                        assert_eq!(got, data[start..end]);
                    }
                    sock.write_all(EXIT_SUCCESS).await.unwrap();
                    return seen;
                }
                assert_eq!(service, legacy_service(data.len() as u64));
                sock.write_all(b"OKAY").await.unwrap();
                let mut got = vec![0u8; data.len()];
                sock.read_exact(&mut got).await.unwrap();
                assert_eq!(got, data);
                sock.write_all(b"OKAY").await.unwrap();
                return seen;
            }
        });
        (addr, task)
    }

    async fn run_against(modern: bool) -> (SideloadMode, Vec<String>, Vec<Progress>) {
        let data = package(BLOCK_SIZE as usize * 2 + 5);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ota.zip");
        std::fs::write(&path, &data).unwrap();
        let (addr, server_task) = fake_server(data, modern).await;
        let server = AdbServer::new(addr);
        let cancel = AtomicBool::new(false);
        let mut progress = Vec::new();
        let mode = sideload(&server, "R5CW30", &path, &cancel, |_, p| progress.push(p))
            .await
            .unwrap();
        (mode, server_task.await.unwrap(), progress)
    }

    #[tokio::test]
    async fn sideloads_with_sideload_host() {
        let size = BLOCK_SIZE * 2 + 5;
        let (mode, seen, progress) = run_against(true).await;
        assert_eq!(mode, SideloadMode::Host);
        assert_eq!(
            seen,
            ["host:transport:R5CW30".to_owned(), host_service(size)]
        );
        assert_eq!(progress.last().map(|p| p.transferred), Some(size));
    }

    #[tokio::test]
    async fn falls_back_to_legacy_sideload() {
        let size = BLOCK_SIZE * 2 + 5;
        let (mode, seen, progress) = run_against(false).await;
        assert_eq!(mode, SideloadMode::Legacy);
        assert_eq!(
            seen,
            [
                "host:transport:R5CW30".to_owned(),
                host_service(size),
                "host:transport:R5CW30".to_owned(),
                legacy_service(size),
            ]
        );
        assert_eq!(progress.last().map(|p| p.percent), Some(100));
    }
}
