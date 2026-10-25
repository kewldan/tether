//! Port forwarding (`host-serial:<serial>:forward:…`) and reverse
//! forwarding (device service `reverse:forward:…`), SERVICES.TXT.

use serde::{Deserialize, Serialize};
use tokio::io::AsyncReadExt;

use super::server::{AdbServer, read_length_prefixed};
use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Direction {
    /// Host port → device socket (`adb forward`).
    Forward,
    /// Device port → host socket (`adb reverse`).
    Reverse,
}

/// One active rule. For forward rules `local` is the host side and
/// `remote` the device side; for reverse rules it is the other way round,
/// exactly as adb lists them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortRule {
    pub direction: Direction,
    pub local: String,
    pub remote: String,
}

/// Parses `list-forward` output: `<serial> <local> <remote>` per line.
/// Forward lists carry the device serial, reverse lists the adbd-side
/// host name (`host-13`), so we filter forward lists by serial only.
pub fn parse_list(text: &str, direction: Direction, serial: Option<&str>) -> Vec<PortRule> {
    text.lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let owner = parts.next()?;
            let local = parts.next()?;
            let remote = parts.next()?;
            if serial.is_some_and(|s| s != owner) {
                return None;
            }
            Some(PortRule {
                direction,
                local: local.to_owned(),
                remote: remote.to_owned(),
            })
        })
        .collect()
}

const DEVICE_KINDS: &[&str] = &[
    "tcp:",
    "localabstract:",
    "localreserved:",
    "localfilesystem:",
    "dev:",
    "jdwp:",
    "vsock:",
];

/// Validates a socket spec. `host_side` specs (where adb listens or
/// connects on this computer) must be `tcp:<port>`; device-side specs may
/// also be unix sockets, `jdwp:<pid>` and so on.
pub fn validate_spec(spec: &str, host_side: bool, allow_zero: bool) -> AppResult<()> {
    let bad = |why: &str| Err(AppError::InvalidInput(format!("{spec:?}: {why}")));
    if spec.is_empty()
        || spec
            .chars()
            .any(|c| c == ';' || c.is_whitespace() || c.is_control())
    {
        return bad("must not be empty or contain spaces or ';'");
    }
    if let Some(port) = spec.strip_prefix("tcp:") {
        return match port.parse::<u16>() {
            Ok(0) if !allow_zero => bad("port 0 is only allowed when adb picks the port"),
            Ok(_) => Ok(()),
            Err(_) => bad("port must be a number from 1 to 65535"),
        };
    }
    if host_side {
        return bad("this side must be tcp:<port>");
    }
    match DEVICE_KINDS.iter().find(|k| spec.starts_with(**k)) {
        Some(kind) => {
            let rest = &spec[kind.len()..];
            if rest.is_empty() {
                bad("missing name")
            } else if *kind == "jdwp:" && rest.parse::<u32>().is_err() {
                bad("jdwp needs a process id")
            } else {
                Ok(())
            }
        }
        None => bad("unknown socket type"),
    }
}

/// Reads the second status of a forward request and the port adb picked
/// when the local side was `tcp:0`.
async fn finish_forward(stream: &mut tokio::net::TcpStream) -> AppResult<Option<u16>> {
    let mut status = [0u8; 4];
    stream.read_exact(&mut status).await?;
    match &status {
        b"OKAY" => {}
        b"FAIL" => return Err(forward_error(read_length_prefixed(stream).await?)),
        other => {
            return Err(AppError::Protocol(format!(
                "unexpected status {:?}",
                String::from_utf8_lossy(other)
            )));
        }
    }
    let mut rest = Vec::new();
    stream.read_to_end(&mut rest).await?;
    // Optional `<4 hex len><port>`.
    let port = std::str::from_utf8(rest.get(4..).unwrap_or_default())
        .ok()
        .and_then(|p| p.trim().parse().ok());
    Ok(port)
}

fn forward_error(message: String) -> AppError {
    AppError::Device(message)
}

/// `adb forward [--no-rebind] <local> <remote>`; returns the resolved port
/// if `local` was `tcp:0`.
pub async fn forward(
    server: &AdbServer,
    serial: &str,
    local: &str,
    remote: &str,
    no_rebind: bool,
) -> AppResult<Option<u16>> {
    validate_spec(local, true, true)?;
    validate_spec(remote, false, false)?;
    let mode = if no_rebind {
        "forward:norebind"
    } else {
        "forward"
    };
    let request = format!("host-serial:{serial}:{mode}:{local};{remote}");
    let mut stream = server.open(&request).await.map_err(unwrap_failure)?;
    finish_forward(&mut stream).await
}

pub async fn kill_forward(server: &AdbServer, serial: &str, local: &str) -> AppResult<()> {
    validate_spec(local, true, false)?;
    let request = format!("host-serial:{serial}:killforward:{local}");
    server.open(&request).await.map_err(unwrap_failure)?;
    Ok(())
}

pub async fn list_forward(server: &AdbServer, serial: &str) -> AppResult<Vec<PortRule>> {
    let mut stream = server.open("host:list-forward").await?;
    let text = read_length_prefixed(&mut stream).await?;
    Ok(parse_list(&text, Direction::Forward, Some(serial)))
}

/// `adb reverse <remote> <local>`: `device` is where adbd listens on the
/// phone, `host` is the socket on this computer it connects to.
pub async fn reverse(
    server: &AdbServer,
    serial: &str,
    device: &str,
    host: &str,
    no_rebind: bool,
) -> AppResult<Option<u16>> {
    validate_spec(device, false, true)?;
    validate_spec(host, true, false)?;
    let mode = if no_rebind {
        "forward:norebind"
    } else {
        "forward"
    };
    let mut stream = server
        .open_device(serial, &format!("reverse:{mode}:{device};{host}"))
        .await
        .map_err(unwrap_failure)?;
    finish_forward(&mut stream).await
}

pub async fn kill_reverse(server: &AdbServer, serial: &str, device: &str) -> AppResult<()> {
    validate_spec(device, false, false)?;
    let mut stream = server
        .open_device(serial, &format!("reverse:killforward:{device}"))
        .await
        .map_err(unwrap_failure)?;
    finish_forward(&mut stream).await.map(|_| ())
}

pub async fn list_reverse(server: &AdbServer, serial: &str) -> AppResult<Vec<PortRule>> {
    let mut stream = server.open_device(serial, "reverse:list-forward").await?;
    let text = read_length_prefixed(&mut stream).await?;
    Ok(parse_list(&text, Direction::Reverse, None))
}

/// Removes every forward of the device (`killforward-all`) and every
/// reverse rule.
pub async fn kill_all(server: &AdbServer, serial: &str) -> AppResult<()> {
    server
        .open(&format!("host-serial:{serial}:killforward-all"))
        .await?;
    let mut stream = server
        .open_device(serial, "reverse:killforward-all")
        .await?;
    finish_forward(&mut stream).await.map(|_| ())
}

/// The adb server reports forward failures as `AdbFailure`; they are about
/// the device or the port, so surface them as device errors.
fn unwrap_failure(e: AppError) -> AppError {
    match e {
        AppError::AdbFailure(message) => forward_error(message),
        other => other,
    }
}

/// True if adb's error means the host port is taken.
pub fn is_address_in_use(message: &str) -> bool {
    message.contains("Address already in use") || message.contains("address already in use")
}

/// First port from `start` up that nothing on this computer listens on.
pub fn free_host_port(start: u16) -> Option<u16> {
    (start..=u16::MAX)
        .take(200)
        .find(|port| std::net::TcpListener::bind(("127.0.0.1", *port)).is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Captured from adb 37 + Android 16 emulator.
    const FORWARD_LIST: &str = "emulator-5554 tcp:39123 tcp:39123\n\
        emulator-5554 tcp:60741 localabstract:chrome_devtools_remote\n\
        38121FDJH00A4B tcp:8080 tcp:8080\n";
    const REVERSE_LIST: &str = "host-13 tcp:39124 tcp:39124\nhost-13 tcp:45773 tcp:39125\n";

    #[test]
    fn parses_forward_list_for_one_device() {
        let rules = parse_list(FORWARD_LIST, Direction::Forward, Some("emulator-5554"));
        assert_eq!(rules.len(), 2);
        assert_eq!(rules[1].local, "tcp:60741");
        assert_eq!(rules[1].remote, "localabstract:chrome_devtools_remote");
        assert_eq!(rules[1].direction, Direction::Forward);
    }

    #[test]
    fn parses_reverse_list() {
        let rules = parse_list(REVERSE_LIST, Direction::Reverse, None);
        assert_eq!(
            rules,
            vec![
                PortRule {
                    direction: Direction::Reverse,
                    local: "tcp:39124".into(),
                    remote: "tcp:39124".into(),
                },
                PortRule {
                    direction: Direction::Reverse,
                    local: "tcp:45773".into(),
                    remote: "tcp:39125".into(),
                },
            ]
        );
        assert!(parse_list("", Direction::Reverse, None).is_empty());
    }

    #[test]
    fn validates_specs() {
        assert!(validate_spec("tcp:8081", true, false).is_ok());
        assert!(validate_spec("tcp:0", true, true).is_ok());
        assert!(validate_spec("tcp:0", true, false).is_err());
        assert!(validate_spec("tcp:70000", true, false).is_err());
        assert!(validate_spec("tcp:", true, false).is_err());
        assert!(validate_spec("localabstract:x", true, false).is_err());
        assert!(validate_spec("localabstract:chrome_devtools_remote", false, false).is_ok());
        assert!(validate_spec("jdwp:5106", false, false).is_ok());
        assert!(validate_spec("jdwp:abc", false, false).is_err());
        assert!(validate_spec("localfilesystem:", false, false).is_err());
        assert!(validate_spec("tcp:1;tcp:2", false, false).is_err());
        assert!(validate_spec("udp:53", false, false).is_err());
        assert!(validate_spec("tcp:80 ", true, false).is_err());
    }

    #[test]
    fn detects_address_in_use() {
        assert!(is_address_in_use(
            "cannot bind listener: Address already in use"
        ));
        assert!(!is_address_in_use("cannot rebind existing socket"));
    }

    #[test]
    fn finds_free_port() {
        let taken = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = taken.local_addr().unwrap().port();
        let free = free_host_port(port).unwrap();
        assert_ne!(free, port);
    }
}
