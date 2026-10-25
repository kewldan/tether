//! Minimal `sync:` SEND (AOSP `packages/modules/adb/SYNC.TXT`), just enough
//! to upload the scrcpy-server jar. `exec:`/`shell:` cannot take stdin from
//! us, and base64 through shell arguments would need chunking around the
//! command-line limit, so one SEND is the simplest robust option. The full
//! sync client (listing, pull, progress) belongs to the files feature.
//!
//! Request: `SEND <len> "<path>,<mode>"`, then `DATA <len> <bytes>` chunks of
//! at most 64 KiB, then `DONE <mtime>`. The device answers `OKAY` or
//! `FAIL <len> <message>`. All lengths are little-endian u32.

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};

use crate::adb::server::AdbServer;
use crate::error::{AppError, AppResult};

const MAX_CHUNK: usize = 64 * 1024;
const MAX_PATH: usize = 1024;

/// Uploads `data` to `remote` with the given permission bits (e.g. `0o644`).
pub async fn push(
    server: &AdbServer,
    serial: &str,
    data: &[u8],
    remote: &str,
    mode: u32,
) -> AppResult<()> {
    let mtime = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as u32)
        .unwrap_or(0);
    let request = encode_send(data, remote, mode, mtime)?;

    let mut stream = server.open_device(serial, "sync:").await?;
    stream.write_all(&request).await?;
    read_status(&mut stream).await?;
    // Polite shutdown; the device closes the service either way.
    let _ = stream.write_all(b"QUIT\0\0\0\0").await;
    Ok(())
}

/// The whole SEND request (header, data chunks and DONE) as one buffer.
pub fn encode_send(data: &[u8], remote: &str, mode: u32, mtime: u32) -> AppResult<Vec<u8>> {
    // Regular file type bits plus permissions, as `adb push` sends them.
    let spec = format!("{remote},{}", 0o100000 | (mode & 0o7777));
    if remote.is_empty() || spec.len() > MAX_PATH {
        return Err(AppError::InvalidInput(format!(
            "bad remote path {remote:?}"
        )));
    }

    let chunks = data.len().div_ceil(MAX_CHUNK);
    let mut out = Vec::with_capacity(16 + spec.len() + data.len() + chunks * 8);
    push_frame(&mut out, b"SEND", spec.len() as u32);
    out.extend_from_slice(spec.as_bytes());
    for chunk in data.chunks(MAX_CHUNK) {
        push_frame(&mut out, b"DATA", chunk.len() as u32);
        out.extend_from_slice(chunk);
    }
    push_frame(&mut out, b"DONE", mtime);
    Ok(out)
}

fn push_frame(out: &mut Vec<u8>, id: &[u8; 4], value: u32) {
    out.extend_from_slice(id);
    out.extend_from_slice(&value.to_le_bytes());
}

async fn read_status<R: AsyncRead + Unpin>(stream: &mut R) -> AppResult<()> {
    let mut head = [0u8; 8];
    stream.read_exact(&mut head).await?;
    let len = u32::from_le_bytes([head[4], head[5], head[6], head[7]]) as usize;
    match &head[..4] {
        b"OKAY" => Ok(()),
        b"FAIL" => {
            let mut message = vec![0u8; len.min(64 * 1024)];
            stream.read_exact(&mut message).await?;
            Err(AppError::Device(format!(
                "push failed: {}",
                String::from_utf8_lossy(&message)
            )))
        }
        other => Err(AppError::Protocol(format!(
            "unexpected sync status {:?}",
            String::from_utf8_lossy(other)
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn send_request_layout() {
        let out = encode_send(b"hello", "/data/local/tmp/x.jar", 0o644, 0x0102_0304).unwrap();
        let spec = b"/data/local/tmp/x.jar,33188";
        let mut expected = Vec::new();
        expected.extend_from_slice(b"SEND");
        expected.extend_from_slice(&(spec.len() as u32).to_le_bytes());
        expected.extend_from_slice(spec);
        expected.extend_from_slice(b"DATA\x05\0\0\0hello");
        expected.extend_from_slice(b"DONE\x04\x03\x02\x01");
        assert_eq!(out, expected);
    }

    #[test]
    fn data_is_split_into_64k_chunks() {
        let data = vec![7u8; MAX_CHUNK * 2 + 10];
        let out = encode_send(&data, "/t", 0o644, 0).unwrap();
        let mut offset = 8 + "/t,33188".len();
        let mut sizes = Vec::new();
        while &out[offset..offset + 4] == b"DATA" {
            let len = u32::from_le_bytes(out[offset + 4..offset + 8].try_into().unwrap()) as usize;
            sizes.push(len);
            offset += 8 + len;
        }
        assert_eq!(sizes, vec![MAX_CHUNK, MAX_CHUNK, 10]);
        assert_eq!(&out[offset..offset + 4], b"DONE");
        assert_eq!(out.len(), offset + 8);
    }

    #[test]
    fn rejects_empty_path() {
        assert!(encode_send(b"", "", 0o644, 0).is_err());
    }

    #[tokio::test]
    async fn fail_status_carries_message() {
        let mut reply: &[u8] = b"FAIL\x0b\0\0\0no such dir";
        let err = read_status(&mut reply).await.unwrap_err();
        assert!(matches!(err, AppError::Device(m) if m.ends_with("no such dir")));
        let mut ok: &[u8] = b"OKAY\0\0\0\0";
        read_status(&mut ok).await.unwrap();
    }
}
