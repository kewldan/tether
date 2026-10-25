//! Wireless debugging and connection lifecycle over the adb server
//! protocol: mDNS discovery (`host:mdns:*`), pairing (`host:pair:`),
//! `host:connect:` / `host:disconnect:`, transport reconnects and legacy
//! `tcpip:` mode.

use serde::Serialize;
use tokio::io::{AsyncRead, AsyncReadExt};

use super::server::{AdbServer, read_length_prefixed};
use crate::error::{AppError, AppResult};

pub const PAIRING_SERVICE: &str = "_adb-tls-pairing._tcp";
pub const CONNECT_SERVICE: &str = "_adb-tls-connect._tcp";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ServiceKind {
    /// A phone in "Pair device with QR code / pairing code".
    Pairing,
    /// A phone with Wireless debugging on, ready to connect.
    Connect,
    /// Legacy `_adb._tcp` and anything else.
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MdnsService {
    /// Instance name, e.g. `adb-R5CW30ABCDE-xyzAbC` or `studio-Xk3…`.
    pub name: String,
    pub kind: ServiceKind,
    /// `ip:port`.
    pub address: String,
}

/// Parses `host:mdns:services`, one `name\ttype\tip:port` per line.
pub fn parse_services(text: &str) -> Vec<MdnsService> {
    text.lines()
        .filter_map(|line| {
            let mut parts = line.split('\t').map(str::trim);
            let name = parts.next().filter(|s| !s.is_empty())?;
            let kind = parts.next()?.trim_end_matches('.');
            let address = parts.next().filter(|s| !s.is_empty())?;
            Some(MdnsService {
                name: name.to_owned(),
                kind: match kind {
                    PAIRING_SERVICE => ServiceKind::Pairing,
                    CONNECT_SERVICE => ServiceKind::Connect,
                    _ => ServiceKind::Other,
                },
                address: address.to_owned(),
            })
        })
        .collect()
}

/// Version string of the server's mDNS backend; errors when discovery is
/// disabled.
pub async fn mdns_check(server: &AdbServer) -> AppResult<String> {
    let mut stream = server.open("host:mdns:check").await?;
    let text = read_length_prefixed(&mut stream).await?;
    if text.starts_with("ERROR") {
        return Err(AppError::AdbFailure(text));
    }
    Ok(text)
}

pub async fn mdns_services(server: &AdbServer) -> AppResult<Vec<MdnsService>> {
    let mut stream = server.open("host:mdns:services").await?;
    Ok(parse_services(&read_length_prefixed(&mut stream).await?))
}

/// `host:connect:<address>`. The server answers OKAY even on failure; the
/// message tells which.
pub async fn connect(server: &AdbServer, address: &str) -> AppResult<String> {
    let address = normalize_address(address)?;
    let mut stream = server.open(&format!("host:connect:{address}")).await?;
    let message = read_length_prefixed(&mut stream).await?;
    parse_connect_reply(&message).map(|()| address)
}

fn parse_connect_reply(message: &str) -> AppResult<()> {
    let m = message.trim();
    if m.starts_with("connected to") || m.starts_with("already connected to") {
        Ok(())
    } else {
        Err(AppError::Device(m.to_owned()))
    }
}

/// Adds the default port to a bare host and rejects obvious garbage before
/// it reaches the server.
pub fn normalize_address(address: &str) -> AppResult<String> {
    let a = address.trim();
    if a.is_empty() || a.contains(char::is_whitespace) {
        return Err(AppError::InvalidInput(format!("bad address {a:?}")));
    }
    // `[v6]:port`, `host:port` or a bare host (IPv6 without brackets has
    // several colons and no port).
    let has_port = if a.starts_with('[') {
        a.contains("]:")
    } else {
        a.matches(':').count() == 1
    };
    if has_port {
        let port = a.rsplit(':').next().unwrap_or_default();
        if port.parse::<u16>().is_err() {
            return Err(AppError::InvalidInput(format!("bad port in {a:?}")));
        }
        Ok(a.to_owned())
    } else {
        Ok(format!("{a}:5555"))
    }
}

/// `host:disconnect:<serial>`; works for `ip:port` and mDNS serials.
pub async fn disconnect(server: &AdbServer, serial: &str) -> AppResult<()> {
    let mut stream = server.open(&format!("host:disconnect:{serial}")).await?;
    let _ = read_length_prefixed(&mut stream).await;
    Ok(())
}

/// Pairs with a phone's pairing service (`host:pair:<code>:<address>`,
/// what `adb pair` sends). Returns the paired device's guid, which is also
/// the instance name of its `_adb-tls-connect` service.
pub async fn pair(server: &AdbServer, address: &str, code: &str) -> AppResult<String> {
    if code.is_empty() || code.contains(':') || code.contains(char::is_whitespace) {
        return Err(AppError::InvalidInput("bad pairing code".into()));
    }
    let mut stream = server.open(&format!("host:pair:{code}:{address}")).await?;
    // The pairing result comes as a second status: OKAY or FAIL + message.
    read_second_status(&mut stream).await?;
    let message = read_length_prefixed(&mut stream).await?;
    parse_pair_reply(&message)
}

async fn read_second_status<R: AsyncRead + Unpin>(stream: &mut R) -> AppResult<()> {
    let mut status = [0u8; 4];
    stream.read_exact(&mut status).await?;
    match &status {
        b"OKAY" => Ok(()),
        b"FAIL" => {
            let message = read_length_prefixed(stream).await?;
            Err(AppError::Device(clean_failure(&message)))
        }
        other => Err(AppError::Protocol(format!(
            "unexpected status {:?}",
            String::from_utf8_lossy(other)
        ))),
    }
}

fn clean_failure(message: &str) -> String {
    message
        .trim()
        .strip_prefix("Failed: ")
        .unwrap_or(message.trim())
        .to_owned()
}

/// `Successfully paired to 192.168.1.42:41823 [guid=adb-R5CW30ABCDE-xyzAbC]`.
fn parse_pair_reply(message: &str) -> AppResult<String> {
    let m = message.trim();
    if !m.starts_with("Successfully paired") {
        return Err(AppError::Device(clean_failure(m)));
    }
    let guid = m
        .split_once("[guid=")
        .and_then(|(_, rest)| rest.split_once(']'))
        .map(|(guid, _)| guid.to_owned())
        .unwrap_or_default();
    Ok(guid)
}

/// Kicks a transport so it reconnects and re-runs authentication (shows the
/// RSA prompt again for an unauthorized phone). `host-serial:<s>:reconnect`.
pub async fn reconnect(server: &AdbServer, serial: &str) -> AppResult<()> {
    let mut stream = server
        .open(&format!("host-serial:{serial}:reconnect"))
        .await?;
    let _ = read_length_prefixed(&mut stream).await;
    Ok(())
}

/// Reconnects every offline device (`host:reconnect-offline`).
pub async fn reconnect_offline(server: &AdbServer) -> AppResult<()> {
    let mut stream = server.open("host:reconnect-offline").await?;
    let _ = read_length_prefixed(&mut stream).await;
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RebootMode {
    System,
    Recovery,
    Bootloader,
    Sideload,
}

impl RebootMode {
    fn service(self) -> &'static str {
        match self {
            Self::System => "reboot:",
            Self::Recovery => "reboot:recovery",
            Self::Bootloader => "reboot:bootloader",
            Self::Sideload => "reboot:sideload",
        }
    }
}

pub async fn reboot(server: &AdbServer, serial: &str, mode: RebootMode) -> AppResult<()> {
    let mut stream = server.open_device(serial, mode.service()).await?;
    // adbd closes the stream once it starts rebooting.
    let mut sink = Vec::new();
    let _ = stream.read_to_end(&mut sink).await;
    Ok(())
}

/// Puts a USB device's adbd into TCP mode (`adb tcpip <port>`).
pub async fn tcpip(server: &AdbServer, serial: &str, port: u16) -> AppResult<()> {
    let mut stream = server.open_device(serial, &format!("tcpip:{port}")).await?;
    let mut out = Vec::new();
    let _ = stream.read_to_end(&mut out).await;
    let text = String::from_utf8_lossy(&out);
    if text.contains("restarting in TCP mode") || text.trim().is_empty() {
        Ok(())
    } else {
        Err(AppError::Device(text.trim().to_owned()))
    }
}

/// Wi-Fi IPv4 address of a device, from `ip -f inet addr show wlan0`.
pub async fn device_ip(server: &AdbServer, serial: &str) -> AppResult<Option<String>> {
    let out = server
        .exec_text(serial, "ip -f inet addr show wlan0")
        .await?;
    Ok(parse_inet(&out))
}

pub fn parse_inet(text: &str) -> Option<String> {
    text.lines().find_map(|line| {
        let rest = line.trim().strip_prefix("inet ")?;
        let addr = rest.split(['/', ' ']).next()?;
        (!addr.is_empty()).then(|| addr.to_owned())
    })
}

/// Random service name and password for QR pairing. The phone that scans
/// `WIFI:T:ADB;S:<name>;P:<password>;;` advertises a pairing service with
/// that instance name.
pub fn qr_credentials() -> AppResult<(String, String)> {
    const ALPHABET: &[u8] = b"abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let mut bytes = [0u8; 22];
    getrandom::fill(&mut bytes).map_err(|e| AppError::Device(e.to_string()))?;
    let pick = |b: &[u8]| -> String {
        b.iter()
            .map(|x| ALPHABET[*x as usize % ALPHABET.len()] as char)
            .collect()
    };
    Ok((format!("tether-{}", pick(&bytes[..10])), pick(&bytes[10..])))
}

pub fn qr_payload(name: &str, password: &str) -> String {
    format!("WIFI:T:ADB;S:{name};P:{password};;")
}

/// QR modules of `payload` (row-major, `true` = dark), with high error
/// correction so a logo can cover the center.
pub fn qr_modules(payload: &str) -> AppResult<(usize, Vec<bool>)> {
    let code = qrcode::QrCode::with_error_correction_level(payload, qrcode::EcLevel::H)
        .map_err(|e| AppError::InvalidInput(e.to_string()))?;
    let modules = code
        .to_colors()
        .into_iter()
        .map(|c| c == qrcode::Color::Dark)
        .collect();
    Ok((code.width(), modules))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_mdns_services() {
        let text = "adb-R5CW30ABCDE-xyzAbC\t_adb-tls-connect._tcp\t192.168.1.42:37115\n\
                    adb-R5CW30ABCDE-xyzAbC\t_adb-tls-pairing._tcp.\t192.168.1.42:41823\n\
                    studio-Xk3pQ9\t_adb-tls-pairing._tcp\t192.168.1.61:38211\n\
                    adb-8f3a2c91\t_adb._tcp\t10.0.0.23:5555\n\
                    broken line\n";
        let services = parse_services(text);
        assert_eq!(services.len(), 4);
        assert_eq!(services[0].kind, ServiceKind::Connect);
        assert_eq!(services[1].kind, ServiceKind::Pairing);
        assert_eq!(services[1].address, "192.168.1.42:41823");
        assert_eq!(services[2].name, "studio-Xk3pQ9");
        assert_eq!(services[3].kind, ServiceKind::Other);
        assert!(parse_services("").is_empty());
    }

    #[test]
    fn connect_replies() {
        assert!(parse_connect_reply("connected to 192.168.1.42:5555").is_ok());
        assert!(parse_connect_reply("already connected to 192.168.1.42:5555").is_ok());
        // Real replies captured from adb 37.0.1.
        let err = parse_connect_reply("failed to connect to '127.0.0.1:5599': Connection refused")
            .unwrap_err();
        assert!(matches!(err, AppError::Device(m) if m.contains("Connection refused")));
        assert!(
            parse_connect_reply(
                "failed to resolve host: 'nonsense': nodename nor servname provided, or not known"
            )
            .is_err()
        );
    }

    #[test]
    fn pair_replies() {
        assert_eq!(
            parse_pair_reply(
                "Successfully paired to 192.168.1.42:41823 [guid=adb-R5CW30ABCDE-xyzAbC]"
            )
            .unwrap(),
            "adb-R5CW30ABCDE-xyzAbC"
        );
        let err =
            parse_pair_reply("Failed: Wrong password or connection was dropped.").unwrap_err();
        assert!(
            matches!(err, AppError::Device(m) if m == "Wrong password or connection was dropped.")
        );
    }

    #[tokio::test]
    async fn pair_failure_arrives_as_second_status() {
        use tokio::io::{AsyncWriteExt, duplex};
        let (mut client, mut server) = duplex(128);
        server
            .write_all(b"FAIL0027Failed: Unable to start pairing client.")
            .await
            .unwrap();
        let err = read_second_status(&mut client).await.unwrap_err();
        assert!(matches!(err, AppError::Device(m) if m == "Unable to start pairing client."));
    }

    #[test]
    fn normalizes_addresses() {
        assert_eq!(
            normalize_address(" 192.168.1.42 ").unwrap(),
            "192.168.1.42:5555"
        );
        assert_eq!(
            normalize_address("192.168.1.42:37115").unwrap(),
            "192.168.1.42:37115"
        );
        assert_eq!(
            normalize_address("[fe80::1]:5555").unwrap(),
            "[fe80::1]:5555"
        );
        assert!(normalize_address("192.168.1.42:99999").is_err());
        assert!(normalize_address("").is_err());
        assert!(normalize_address("a b").is_err());
    }

    #[test]
    fn parses_wlan_address() {
        // Captured from the Android 16 emulator.
        let out = "16: wlan0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc noqueue state UP group default qlen 1000\n    \
                   inet 10.0.2.16/24 brd 10.0.2.255 scope global wlan0\n       \
                   valid_lft forever preferred_lft forever\n";
        assert_eq!(parse_inet(out).as_deref(), Some("10.0.2.16"));
        assert_eq!(parse_inet("Device \"wlan0\" does not exist.\n"), None);
    }

    #[test]
    fn qr_session_is_scannable_shape() {
        let (name, password) = qr_credentials().unwrap();
        assert!(name.starts_with("tether-"));
        assert_eq!(password.len(), 12);
        let payload = qr_payload(&name, &password);
        assert!(payload.starts_with("WIFI:T:ADB;S:tether-"));
        let (width, modules) = qr_modules(&payload).unwrap();
        assert_eq!(modules.len(), width * width);
        assert!(width >= 21);
    }
}
