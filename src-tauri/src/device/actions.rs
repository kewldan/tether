//! One-shot device actions: reboot, screenshot, screen recording and
//! pulling a file over `exec:cat`.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::Deserialize;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;

use crate::adb::server::AdbServer;
use crate::device::captures;
use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RebootTarget {
    System,
    Recovery,
    Bootloader,
    Sideload,
    PowerOff,
}

impl RebootTarget {
    /// Argument of adbd's `reboot:` service.
    fn service(self) -> Option<&'static str> {
        match self {
            Self::System => Some("reboot:"),
            Self::Recovery => Some("reboot:recovery"),
            Self::Bootloader => Some("reboot:bootloader"),
            Self::Sideload => Some("reboot:sideload"),
            Self::PowerOff => None,
        }
    }
}

/// Reboots the device into `target`, or powers it off. The connection drops
/// as the device goes down, so read errors after the request are expected.
pub async fn reboot(server: &AdbServer, serial: &str, target: RebootTarget) -> AppResult<()> {
    let mut stream = match target.service() {
        Some(service) => server.open_device(serial, service).await?,
        // adbd has no power-off service; the shell user may call the power
        // manager directly.
        None => {
            server
                .open_device(serial, "exec:svc power shutdown")
                .await?
        }
    };
    let mut sink = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut sink)).await;
    Ok(())
}

/// PNG bytes of the current screen.
pub async fn screenshot(server: &AdbServer, serial: &str) -> AppResult<Vec<u8>> {
    let bytes = server.exec(serial, "screencap -p").await?;
    if !captures::is_png(&bytes) {
        let text = String::from_utf8_lossy(&bytes[..bytes.len().min(200)]).into_owned();
        return Err(AppError::Device(format!(
            "screencap failed: {}",
            text.trim()
        )));
    }
    Ok(bytes)
}

/// Quotes a string for `sh`.
pub fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// A running `screenrecord`: its pid and the stream that ends when it exits.
pub struct RecordingProcess {
    pub pid: u32,
    pub stream: BufReader<TcpStream>,
}

/// Starts `screenrecord` writing to `remote`. The shell prints its pid and
/// then execs into screenrecord, so the pid is screenrecord's own.
pub async fn start_recording(
    server: &AdbServer,
    serial: &str,
    remote: &str,
) -> AppResult<RecordingProcess> {
    let command = format!(
        "exec:sh -c 'echo $$; exec screenrecord --bit-rate 8000000 {}'",
        remote
    );
    if remote.contains('\'') {
        return Err(AppError::InvalidInput("bad remote path".into()));
    }
    let stream = server.open_device(serial, &command).await?;
    let mut stream = BufReader::new(stream);
    let mut line = String::new();
    tokio::time::timeout(Duration::from_secs(5), stream.read_line(&mut line))
        .await
        .map_err(|_| AppError::Device("screenrecord did not start".into()))??;
    let pid = line
        .trim()
        .parse()
        .map_err(|_| AppError::Device(format!("screenrecord failed: {}", line.trim())))?;
    Ok(RecordingProcess { pid, stream })
}

/// Collects whatever screenrecord prints until it exits (errors such as
/// "Unable to open" end up here).
pub async fn wait_recording(process: &mut RecordingProcess) -> String {
    let mut out = String::new();
    let _ = process.stream.read_to_string(&mut out).await;
    out
}

/// Asks screenrecord to finish: SIGINT makes it finalize the mp4.
pub async fn interrupt(server: &AdbServer, serial: &str, pid: u32) -> AppResult<()> {
    server.exec(serial, &format!("kill -INT {pid}")).await?;
    Ok(())
}

/// Size of a remote file in bytes.
pub async fn remote_size(server: &AdbServer, serial: &str, remote: &str) -> AppResult<Option<u64>> {
    let out = server
        .exec_text(serial, &format!("stat -c %s {}", shell_quote(remote)))
        .await?;
    Ok(out.trim().parse().ok())
}

/// Copies a remote file to `dest` over `exec:cat`, reporting
/// `(received, total)`. Stops with [`AppError::Cancelled`] once `cancel`
/// is set; a partial file is removed.
pub async fn pull(
    server: &AdbServer,
    serial: &str,
    remote: &str,
    dest: &Path,
    cancel: &AtomicBool,
    mut progress: impl FnMut(u64, Option<u64>),
) -> AppResult<u64> {
    let total = remote_size(server, serial, remote).await?;
    let mut stream = server
        .open_device(serial, &format!("exec:cat {}", shell_quote(remote)))
        .await?;
    let mut file = tokio::fs::File::create(dest).await?;
    let mut buf = vec![0u8; 256 * 1024];
    let mut received = 0u64;
    let result: AppResult<()> = async {
        loop {
            if cancel.load(Ordering::Relaxed) {
                return Err(AppError::Cancelled);
            }
            let n = stream.read(&mut buf).await?;
            if n == 0 {
                break;
            }
            file.write_all(&buf[..n]).await?;
            received += n as u64;
            progress(received, total);
        }
        file.flush().await?;
        Ok(())
    }
    .await;
    if let Err(e) = result {
        drop(file);
        let _ = tokio::fs::remove_file(dest).await;
        return Err(e);
    }
    if total.is_some_and(|t| t != received) {
        let _ = tokio::fs::remove_file(dest).await;
        return Err(AppError::Device(format!(
            "pulled {received} of {} bytes",
            total.unwrap_or(0)
        )));
    }
    Ok(received)
}

pub async fn remove_remote(server: &AdbServer, serial: &str, remote: &str) -> AppResult<()> {
    server
        .exec(serial, &format!("rm -f {}", shell_quote(remote)))
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_for_shell() {
        assert_eq!(shell_quote("/sdcard/a b.mp4"), "'/sdcard/a b.mp4'");
        assert_eq!(shell_quote("it's"), r"'it'\''s'");
    }

    #[test]
    fn reboot_services() {
        assert_eq!(RebootTarget::System.service(), Some("reboot:"));
        assert_eq!(RebootTarget::Sideload.service(), Some("reboot:sideload"));
        assert_eq!(RebootTarget::PowerOff.service(), None);
    }

    #[test]
    fn reboot_target_from_json() {
        let t: RebootTarget = serde_json::from_str("\"power_off\"").unwrap();
        assert_eq!(t, RebootTarget::PowerOff);
    }
}
