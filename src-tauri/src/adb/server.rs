//! Client for the adb server smart-socket protocol (AOSP
//! `packages/modules/adb/SERVICES.TXT`, `OVERVIEW.TXT`).
//!
//! Every request is `<4 hex digits length><payload>`; the server answers
//! `OKAY` or `FAIL<4 hex length><message>`. Host services that return data
//! prefix it with a hex length as well.

use std::net::SocketAddr;
use std::path::Path;
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::process::Command;

use crate::error::{AppError, AppResult};

pub const DEFAULT_PORT: u16 = 5037;

#[derive(Debug, Clone, Copy)]
pub struct AdbServer {
    addr: SocketAddr,
}

impl Default for AdbServer {
    fn default() -> Self {
        Self::new(SocketAddr::from(([127, 0, 0, 1], DEFAULT_PORT)))
    }
}

impl AdbServer {
    pub fn new(addr: SocketAddr) -> Self {
        Self { addr }
    }

    pub async fn connect(&self) -> AppResult<TcpStream> {
        let stream = TcpStream::connect(self.addr)
            .await
            .map_err(AppError::ServerUnreachable)?;
        stream.set_nodelay(true)?;
        Ok(stream)
    }

    /// Opens a connection and sends a host request, leaving the stream
    /// positioned after `OKAY`.
    pub async fn open(&self, request: &str) -> AppResult<TcpStream> {
        let mut stream = self.connect().await?;
        send_request(&mut stream, request).await?;
        Ok(stream)
    }

    /// Internal protocol version of the running server, e.g. `41`.
    pub async fn version(&self) -> AppResult<u32> {
        let mut stream = self.open("host:version").await?;
        let hex = read_length_prefixed(&mut stream).await?;
        u32::from_str_radix(&hex, 16).map_err(|_| AppError::Protocol(hex))
    }

    /// Connects to the running server, or launches it with
    /// `adb start-server` if nothing listens on the port yet. An already
    /// running server (Android Studio, another tool) is reused as is.
    pub async fn ensure_running(&self, adb: &Path) -> AppResult<()> {
        if self.version().await.is_ok() {
            return Ok(());
        }

        let output = Command::new(adb)
            .arg("-P")
            .arg(self.addr.port().to_string())
            .arg("start-server")
            .output()
            .await
            .map_err(|e| AppError::ServerStart(e.to_string()))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(AppError::ServerStart(stderr.trim().to_owned()));
        }

        // `start-server` returns once the daemon forks, which can be a bit
        // before it accepts connections.
        for _ in 0..20 {
            if self.version().await.is_ok() {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        Err(AppError::ServerStart("server did not come up".into()))
    }

    /// Switches a fresh connection to the device and opens a device service
    /// on it (`shell:…`, `exec:…`, `sync:`, `tcp:…`, `localabstract:…`).
    /// The returned stream carries that service's raw bytes.
    pub async fn open_device(&self, serial: &str, service: &str) -> AppResult<TcpStream> {
        let mut stream = self.open(&format!("host:transport:{serial}")).await?;
        send_request(&mut stream, service).await?;
        Ok(stream)
    }

    /// Runs `exec:<command>` and returns its raw stdout. Unlike `shell:` it
    /// allocates no PTY, so binary output (screencap, files) is not mangled
    /// and stderr is not mixed in.
    pub async fn exec(&self, serial: &str, command: &str) -> AppResult<Vec<u8>> {
        let mut stream = self.open_device(serial, &format!("exec:{command}")).await?;
        let mut out = Vec::new();
        stream.read_to_end(&mut out).await?;
        Ok(out)
    }

    /// [`Self::exec`] decoded as (lossy) UTF-8 text.
    pub async fn exec_text(&self, serial: &str, command: &str) -> AppResult<String> {
        let out = self.exec(serial, command).await?;
        Ok(String::from_utf8_lossy(&out).into_owned())
    }

    /// Runs `shell:<command>` on a device and returns its stdout.
    pub async fn shell(&self, serial: &str, command: &str) -> AppResult<String> {
        let mut stream = self
            .open_device(serial, &format!("shell:{command}"))
            .await?;
        let mut out = Vec::new();
        stream.read_to_end(&mut out).await?;
        Ok(String::from_utf8_lossy(&out).into_owned())
    }
}

pub async fn send_request<S>(stream: &mut S, request: &str) -> AppResult<()>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let len = u16::try_from(request.len())
        .map_err(|_| AppError::Protocol(format!("request too long: {}", request.len())))?;
    stream
        .write_all(format!("{len:04x}{request}").as_bytes())
        .await?;
    read_status(stream).await
}

async fn read_status<R: AsyncRead + Unpin>(stream: &mut R) -> AppResult<()> {
    let mut status = [0u8; 4];
    stream.read_exact(&mut status).await?;
    match &status {
        b"OKAY" => Ok(()),
        b"FAIL" => {
            let message = read_length_prefixed(stream).await?;
            Err(AppError::AdbFailure(message))
        }
        other => Err(AppError::Protocol(format!(
            "unexpected status {:?}",
            String::from_utf8_lossy(other)
        ))),
    }
}

/// Reads one `<4 hex length><payload>` message.
pub async fn read_length_prefixed<R: AsyncRead + Unpin>(stream: &mut R) -> AppResult<String> {
    let mut len_hex = [0u8; 4];
    stream.read_exact(&mut len_hex).await?;
    let len_str =
        std::str::from_utf8(&len_hex).map_err(|_| AppError::Protocol("non-ascii length".into()))?;
    let len = usize::from_str_radix(len_str, 16)
        .map_err(|_| AppError::Protocol(format!("bad length {len_str:?}")))?;

    let mut payload = vec![0u8; len];
    stream.read_exact(&mut payload).await?;
    Ok(String::from_utf8_lossy(&payload).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::duplex;

    #[tokio::test]
    async fn request_is_hex_length_prefixed() {
        let (mut client, mut server) = duplex(64);
        let task = tokio::spawn(async move {
            let mut buf = [0u8; 16];
            server.read_exact(&mut buf).await.unwrap();
            server.write_all(b"OKAY").await.unwrap();
            buf
        });

        send_request(&mut client, "host:version").await.unwrap();
        assert_eq!(&task.await.unwrap(), b"000chost:version");
    }

    #[tokio::test]
    async fn fail_status_carries_message() {
        let (mut client, mut server) = duplex(64);
        tokio::spawn(async move {
            let mut buf = [0u8; 21];
            server.read_exact(&mut buf).await.unwrap();
            server.write_all(b"FAIL0010device not found").await.unwrap();
        });

        let err = send_request(&mut client, "host:transport:x1")
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::AdbFailure(m) if m == "device not found"));
    }

    #[tokio::test]
    async fn rejects_garbage_status() {
        let (mut client, mut server) = duplex(64);
        tokio::spawn(async move {
            let mut buf = [0u8; 16];
            server.read_exact(&mut buf).await.unwrap();
            server.write_all(b"WHAT").await.unwrap();
        });

        let err = send_request(&mut client, "host:version").await.unwrap_err();
        assert!(matches!(err, AppError::Protocol(_)));
    }
}
