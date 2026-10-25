//! Shell protocol v2 (AOSP `packages/modules/adb/shell_protocol.h`).
//!
//! With the `shell_v2` device feature, `shell,v2,…:<command>` wraps every
//! chunk in a packet `[id: u8][len: u32 LE][data]`, which separates stdout
//! from stderr, carries the exit code and lets the client resize the PTY.
//! Without it we fall back to the legacy `shell:` service: one raw byte
//! stream, no exit code, no resize.

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;

use super::server::{AdbServer, read_length_prefixed};
use crate::error::{AppError, AppResult};

pub const ID_STDIN: u8 = 0;
pub const ID_STDOUT: u8 = 1;
pub const ID_STDERR: u8 = 2;
pub const ID_EXIT: u8 = 3;
pub const ID_CLOSE_STDIN: u8 = 4;
pub const ID_WINDOW_SIZE_CHANGE: u8 = 5;

const HEADER_LEN: usize = 5;
/// adbd's own buffer is 32 KiB; larger stdin writes are split.
const MAX_PAYLOAD: usize = 32 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Packet {
    pub id: u8,
    pub data: Vec<u8>,
}

/// Encodes one packet. Payloads over [`MAX_PAYLOAD`] must be split by the
/// caller (see [`encode_stdin`]).
pub fn encode_packet(id: u8, data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(HEADER_LEN + data.len());
    out.push(id);
    out.extend_from_slice(&(data.len() as u32).to_le_bytes());
    out.extend_from_slice(data);
    out
}

/// Stdin bytes as one or more packets.
pub fn encode_stdin(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() + HEADER_LEN);
    for chunk in data.chunks(MAX_PAYLOAD) {
        out.extend_from_slice(&encode_packet(ID_STDIN, chunk));
    }
    out
}

/// Window size packet: `"<rows>x<cols>,<xpixels>x<ypixels>\0"`, the format
/// adbd parses with `sscanf("%dx%d,%dx%d")`.
pub fn encode_window_size(rows: u16, cols: u16, x_pixels: u16, y_pixels: u16) -> Vec<u8> {
    let text = format!("{rows}x{cols},{x_pixels}x{y_pixels}\0");
    encode_packet(ID_WINDOW_SIZE_CHANGE, text.as_bytes())
}

/// Incremental packet parser: feed it whatever the socket returned and take
/// out the complete packets.
#[derive(Debug, Default)]
pub struct PacketDecoder {
    buf: Vec<u8>,
}

impl PacketDecoder {
    pub fn push(&mut self, bytes: &[u8]) {
        self.buf.extend_from_slice(bytes);
    }

    /// Next complete packet, or `None` until more bytes arrive.
    pub fn next_packet(&mut self) -> Option<Packet> {
        if self.buf.len() < HEADER_LEN {
            return None;
        }
        let len = u32::from_le_bytes([self.buf[1], self.buf[2], self.buf[3], self.buf[4]]) as usize;
        if self.buf.len() < HEADER_LEN + len {
            return None;
        }
        let id = self.buf[0];
        let data = self.buf[HEADER_LEN..HEADER_LEN + len].to_vec();
        self.buf.drain(..HEADER_LEN + len);
        Some(Packet { id, data })
    }
}

/// Device features (`shell_v2`, `cmd`, `abb`, …).
pub async fn features(server: &AdbServer, serial: &str) -> AppResult<Vec<String>> {
    let mut stream = server
        .open(&format!("host-serial:{serial}:features"))
        .await?;
    let list = read_length_prefixed(&mut stream).await?;
    Ok(list
        .split(',')
        .map(|f| f.trim().to_owned())
        .filter(|f| !f.is_empty())
        .collect())
}

pub async fn supports_shell_v2(server: &AdbServer, serial: &str) -> AppResult<bool> {
    Ok(features(server, serial)
        .await?
        .iter()
        .any(|f| f == "shell_v2"))
}

/// Options for an interactive session.
#[derive(Debug, Clone)]
pub struct PtyOptions {
    pub term: String,
    pub rows: u16,
    pub cols: u16,
    /// Command to run instead of the login shell.
    pub command: Option<String>,
}

/// An opened shell stream and whether it speaks the v2 packet protocol.
pub struct ShellStream {
    pub stream: TcpStream,
    pub v2: bool,
}

/// Opens an interactive PTY session. Uses shell v2 when the device has it
/// (and sends the initial window size), otherwise legacy `shell:`.
pub async fn open_pty(
    server: &AdbServer,
    serial: &str,
    opts: &PtyOptions,
) -> AppResult<ShellStream> {
    let command = opts.command.as_deref().unwrap_or("");
    if supports_shell_v2(server, serial).await? {
        if opts.term.contains([',', ':']) {
            return Err(AppError::InvalidInput(format!("bad TERM {:?}", opts.term)));
        }
        let service = format!("shell,v2,TERM={},pty:{command}", opts.term);
        let mut stream = server.open_device(serial, &service).await?;
        stream
            .write_all(&encode_window_size(opts.rows, opts.cols, 0, 0))
            .await?;
        Ok(ShellStream { stream, v2: true })
    } else {
        let stream = server
            .open_device(serial, &format!("shell:{command}"))
            .await?;
        Ok(ShellStream { stream, v2: false })
    }
}

/// Result of a non-interactive command.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandOutput {
    pub stdout: String,
    pub stderr: String,
    /// `None` on devices without shell v2 (the legacy protocol has none).
    pub exit_code: Option<u8>,
}

/// Runs a command without a PTY and collects stdout, stderr and the exit
/// code. Falls back to `exec:` (stdout only) without shell v2.
pub async fn run(server: &AdbServer, serial: &str, command: &str) -> AppResult<CommandOutput> {
    if !supports_shell_v2(server, serial).await? {
        let stdout = server.exec_text(serial, command).await?;
        return Ok(CommandOutput {
            stdout,
            ..Default::default()
        });
    }
    let mut stream = server
        .open_device(serial, &format!("shell,v2,raw:{command}"))
        .await?;
    // Nothing to send: close stdin so commands that read it finish.
    stream
        .write_all(&encode_packet(ID_CLOSE_STDIN, &[]))
        .await?;
    collect(&mut stream).await
}

async fn collect<S: AsyncRead + AsyncWrite + Unpin>(stream: &mut S) -> AppResult<CommandOutput> {
    let mut decoder = PacketDecoder::default();
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut exit_code = None;
    let mut buf = vec![0u8; 64 * 1024];
    'read: loop {
        let n = stream.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        decoder.push(&buf[..n]);
        while let Some(packet) = decoder.next_packet() {
            match packet.id {
                ID_STDOUT => stdout.extend_from_slice(&packet.data),
                ID_STDERR => stderr.extend_from_slice(&packet.data),
                ID_EXIT => {
                    exit_code = packet.data.first().copied();
                    break 'read;
                }
                _ => {}
            }
        }
    }
    Ok(CommandOutput {
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
        exit_code,
    })
}

/// Quotes one argument for the device's `sh` (mksh/toybox): wraps it in
/// single quotes unless it only has safe characters.
pub fn quote(arg: &str) -> String {
    let safe = !arg.is_empty()
        && arg
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "@%+=:,./-_".contains(c));
    if safe {
        arg.to_owned()
    } else {
        format!("'{}'", arg.replace('\'', r"'\''"))
    }
}

/// Joins arguments into one `sh` command line.
pub fn join_args<S: AsRef<str>>(args: &[S]) -> String {
    args.iter()
        .map(|a| quote(a.as_ref()))
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::duplex;

    #[test]
    fn encodes_header_little_endian() {
        assert_eq!(
            encode_packet(ID_STDIN, b"ls\n"),
            vec![0, 3, 0, 0, 0, b'l', b's', b'\n']
        );
        assert_eq!(encode_packet(ID_CLOSE_STDIN, &[]), vec![4, 0, 0, 0, 0]);
    }

    #[test]
    fn encodes_window_size_like_adb_client() {
        let packet = encode_window_size(38, 120, 0, 0);
        assert_eq!(packet[0], ID_WINDOW_SIZE_CHANGE);
        assert_eq!(&packet[5..], b"38x120,0x0\0");
        assert_eq!(packet[1], 11);
    }

    #[test]
    fn splits_large_stdin() {
        let data = vec![b'a'; MAX_PAYLOAD + 10];
        let encoded = encode_stdin(&data);
        let mut decoder = PacketDecoder::default();
        decoder.push(&encoded);
        assert_eq!(decoder.next_packet().unwrap().data.len(), MAX_PAYLOAD);
        assert_eq!(decoder.next_packet().unwrap().data.len(), 10);
        assert!(decoder.next_packet().is_none());
    }

    #[test]
    fn decodes_packets_split_across_reads() {
        let mut bytes = encode_packet(ID_STDOUT, b"hello");
        bytes.extend(encode_packet(ID_STDERR, b"oops"));
        bytes.extend(encode_packet(ID_EXIT, &[1]));

        let mut decoder = PacketDecoder::default();
        let mut packets = Vec::new();
        for chunk in bytes.chunks(3) {
            decoder.push(chunk);
            while let Some(p) = decoder.next_packet() {
                packets.push(p);
            }
        }
        assert_eq!(
            packets,
            vec![
                Packet {
                    id: ID_STDOUT,
                    data: b"hello".to_vec()
                },
                Packet {
                    id: ID_STDERR,
                    data: b"oops".to_vec()
                },
                Packet {
                    id: ID_EXIT,
                    data: vec![1]
                },
            ]
        );
    }

    #[tokio::test]
    async fn collects_streams_and_exit_code() {
        let (mut client, mut server) = duplex(256);
        tokio::spawn(async move {
            let mut out = encode_packet(ID_STDOUT, b"Pixel 8 Pro\n");
            out.extend(encode_packet(ID_STDERR, b"warn\n"));
            out.extend(encode_packet(ID_EXIT, &[0]));
            server.write_all(&out).await.unwrap();
        });
        let output = collect(&mut client).await.unwrap();
        assert_eq!(output.stdout, "Pixel 8 Pro\n");
        assert_eq!(output.stderr, "warn\n");
        assert_eq!(output.exit_code, Some(0));
    }

    #[test]
    fn quotes_for_device_shell() {
        assert_eq!(
            quote("android.intent.action.VIEW"),
            "android.intent.action.VIEW"
        );
        assert_eq!(quote("com.example/.Main"), "com.example/.Main");
        assert_eq!(quote(""), "''");
        assert_eq!(quote("a b"), "'a b'");
        assert_eq!(quote("x://p?a=1&b=2"), "'x://p?a=1&b=2'");
        assert_eq!(quote("it's"), r"'it'\''s'");
        assert_eq!(quote("$HOME;rm"), "'$HOME;rm'");
        assert_eq!(
            join_args(&["am", "start", "-d", "a b"]),
            "am start -d 'a b'"
        );
    }
}
