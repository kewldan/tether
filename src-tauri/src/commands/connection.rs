//! Connection lifecycle: Wi-Fi pairing and connect, reconnects, reboot,
//! emulators, and the bookkeeping diagnostics needs (server restarts).

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use crate::adb::avd::{self, Avd};
use crate::adb::devices::{self, Device, Transport};
use crate::adb::server::{AdbServer, read_length_prefixed};
use crate::adb::wireless::{self, MdnsService, ServiceKind};
use crate::device::summary::{self, DeviceSummary};
use crate::error::{AppError, AppResult};
use crate::state::{AppState, lock};

const QR_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const POLL: Duration = Duration::from_millis(1000);
const LOG_LIMIT: usize = 20;

/// Connection bookkeeping shared by the device watcher, diagnostics and
/// pairing.
#[derive(Default)]
pub struct ConnectionState {
    /// When Tether itself launched the running server.
    pub server_started_at: Mutex<Option<SystemTime>>,
    /// When the device stream lost the server.
    pub server_drops: Mutex<VecDeque<Instant>>,
    pub server_log: Mutex<VecDeque<(SystemTime, String)>>,
    pub pairing_cancel: Mutex<Option<Arc<AtomicBool>>>,
}

impl ConnectionState {
    pub fn server_started(&self) {
        *lock(&self.server_started_at) = Some(SystemTime::now());
        self.log("adb server started by Tether".into());
    }

    pub fn server_dropped(&self, error: &AppError) {
        let mut drops = lock(&self.server_drops);
        drops.push_back(Instant::now());
        while drops.len() > LOG_LIMIT {
            drops.pop_front();
        }
        drop(drops);
        *lock(&self.server_started_at) = None;
        self.log(format!("lost the adb server: {error}"));
    }

    pub fn drops_last_minute(&self) -> u32 {
        let drops = lock(&self.server_drops);
        let n = drops
            .iter()
            .filter(|t| t.elapsed() < Duration::from_secs(60))
            .count();
        u32::try_from(n).unwrap_or(u32::MAX)
    }

    pub fn log(&self, line: String) {
        let mut log = lock(&self.server_log);
        log.push_back((SystemTime::now(), line));
        while log.len() > LOG_LIMIT {
            log.pop_front();
        }
    }

    /// Log lines prefixed with how long ago they happened.
    pub fn log_lines(&self) -> Vec<String> {
        lock(&self.server_log)
            .iter()
            .map(|(at, line)| {
                let ago = at.elapsed().map(|d| d.as_secs()).unwrap_or(0);
                format!("-{ago}s  {line}")
            })
            .collect()
    }
}

/// One-shot `host:devices-l` snapshot.
pub async fn list_devices(server: &AdbServer) -> AppResult<Vec<Device>> {
    let mut stream = server.open("host:devices-l").await?;
    Ok(devices::parse_devices(
        &read_length_prefixed(&mut stream).await?,
    ))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MdnsSnapshot {
    /// False when the server's mDNS discovery is disabled.
    pub available: bool,
    pub services: Vec<MdnsService>,
}

#[tauri::command]
pub async fn wifi_mdns_services(state: State<'_, AppState>) -> AppResult<MdnsSnapshot> {
    let available = wireless::mdns_check(&state.server).await.is_ok();
    let services = if available {
        wireless::mdns_services(&state.server).await?
    } else {
        Vec::new()
    };
    Ok(MdnsSnapshot {
        available,
        services,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QrSession {
    pub name: String,
    pub password: String,
    pub payload: String,
    pub width: usize,
    /// Row-major modules, `1` = dark.
    pub modules: String,
}

#[tauri::command]
pub fn wifi_qr_session() -> AppResult<QrSession> {
    let (name, password) = wireless::qr_credentials()?;
    let payload = wireless::qr_payload(&name, &password);
    let (width, modules) = wireless::qr_modules(&payload)?;
    Ok(QrSession {
        name,
        password,
        payload,
        width,
        modules: modules.iter().map(|&d| if d { '1' } else { '0' }).collect(),
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum PairTarget {
    /// Wait for the phone that scanned our QR code.
    Qr { name: String, password: String },
    /// A pairing service the user picked or typed, plus its 6-digit code.
    Code { address: String, code: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum PairEvent {
    Waiting,
    Pairing { address: String },
    Paired { guid: String },
    Connecting { address: String },
}

/// Pairs and connects a phone over Wi-Fi. Returns the new device's serial.
/// Progress goes to `on_event`; [`wifi_cancel_pair`] stops the wait.
#[tauri::command]
pub async fn wifi_pair(
    state: State<'_, AppState>,
    conn: State<'_, ConnectionState>,
    target: PairTarget,
    on_event: Channel<PairEvent>,
) -> AppResult<String> {
    let cancel = Arc::new(AtomicBool::new(false));
    if let Some(previous) = lock(&conn.pairing_cancel).replace(cancel.clone()) {
        previous.store(true, Ordering::Relaxed);
    }
    let send = |e: PairEvent| {
        let _ = on_event.send(e);
    };
    let result = pair_flow(&state.server, target, &cancel, send).await;
    let mut slot = lock(&conn.pairing_cancel);
    if slot.as_ref().is_some_and(|c| Arc::ptr_eq(c, &cancel)) {
        *slot = None;
    }
    result
}

#[tauri::command]
pub fn wifi_cancel_pair(conn: State<'_, ConnectionState>) {
    if let Some(cancel) = lock(&conn.pairing_cancel).take() {
        cancel.store(true, Ordering::Relaxed);
    }
}

async fn pair_flow(
    server: &AdbServer,
    target: PairTarget,
    cancel: &AtomicBool,
    send: impl Fn(PairEvent),
) -> AppResult<String> {
    let (address, code) = match target {
        PairTarget::Qr { name, password } => {
            send(PairEvent::Waiting);
            let mut wait = Waiter::new(cancel, QR_TIMEOUT);
            let address = loop {
                let services = wireless::mdns_services(server).await.unwrap_or_default();
                if let Some(s) = services
                    .into_iter()
                    .find(|s| s.kind == ServiceKind::Pairing && s.name == name)
                {
                    break s.address;
                }
                if !wait.next().await? {
                    return Err(AppError::Device("no phone scanned the code in time".into()));
                }
            };
            (address, password)
        }
        PairTarget::Code { address, code } => (wireless::normalize_address(&address)?, code),
    };

    send(PairEvent::Pairing {
        address: address.clone(),
    });
    let guid = wireless::pair(server, &address, code.trim()).await?;
    send(PairEvent::Paired { guid: guid.clone() });

    // After pairing the phone advertises `_adb-tls-connect` under its guid;
    // the server may auto-connect it (serial `<guid>._adb-tls-connect._tcp`)
    // or we connect to the advertised address.
    let host_prefix = address
        .rsplit_once(':')
        .map(|(h, _)| format!("{h}:"))
        .unwrap_or_default();
    let mut wait = Waiter::new(cancel, CONNECT_TIMEOUT);
    loop {
        let devices = list_devices(server).await.unwrap_or_default();
        if let Some(d) = devices.iter().find(|d| {
            d.transport == Transport::Wifi
                && ((!guid.is_empty() && d.serial.starts_with(&guid))
                    || d.serial.starts_with(&host_prefix))
        }) {
            return Ok(d.serial.clone());
        }
        let services = wireless::mdns_services(server).await.unwrap_or_default();
        if let Some(service) = services.into_iter().find(|s| {
            s.kind == ServiceKind::Connect
                && (s.name == guid || s.address.starts_with(&host_prefix))
        }) {
            send(PairEvent::Connecting {
                address: service.address.clone(),
            });
            return wireless::connect(server, &service.address).await;
        }
        if !wait.next().await? {
            return Err(AppError::Device(
                "paired, but the phone did not offer a connection; connect by IP from \
                 Wireless debugging"
                    .into(),
            ));
        }
    }
}

/// Paces a polling loop: one step per second until the timeout, failing
/// fast once `cancel` is set.
struct Waiter<'a> {
    cancel: &'a AtomicBool,
    deadline: Instant,
}

impl<'a> Waiter<'a> {
    fn new(cancel: &'a AtomicBool, timeout: Duration) -> Self {
        Self {
            cancel,
            deadline: Instant::now() + timeout,
        }
    }

    /// Sleeps until the next step; `Ok(false)` once time is up.
    async fn next(&mut self) -> AppResult<bool> {
        if self.cancel.load(Ordering::Relaxed) {
            return Err(AppError::Cancelled);
        }
        tokio::time::sleep(POLL).await;
        if self.cancel.load(Ordering::Relaxed) {
            return Err(AppError::Cancelled);
        }
        Ok(Instant::now() < self.deadline)
    }
}

/// `adb connect <address>`; returns the address used as the serial.
#[tauri::command]
pub async fn wifi_connect(state: State<'_, AppState>, address: String) -> AppResult<String> {
    wireless::connect(&state.server, &address).await
}

#[tauri::command]
pub async fn wifi_disconnect(state: State<'_, AppState>, serial: String) -> AppResult<()> {
    wireless::disconnect(&state.server, &serial).await
}

/// Legacy `adb tcpip <port>` + `adb connect <wifi ip>:<port>` for a device
/// plugged in over USB. Returns the new serial.
#[tauri::command]
pub async fn wifi_tcpip(
    state: State<'_, AppState>,
    serial: String,
    port: u16,
) -> AppResult<String> {
    let server = &state.server;
    let ip = wireless::device_ip(server, &serial)
        .await?
        .ok_or_else(|| AppError::Device("the device is not on Wi-Fi".into()))?;
    wireless::tcpip(server, &serial, port).await?;
    let address = format!("{ip}:{port}");
    // adbd restarts in TCP mode; give it a moment to listen.
    let never = AtomicBool::new(false);
    let mut wait = Waiter::new(&never, Duration::from_secs(10));
    loop {
        match wireless::connect(server, &address).await {
            Ok(serial) => return Ok(serial),
            Err(e) => {
                if !wait.next().await? {
                    return Err(e);
                }
            }
        }
    }
}

#[tauri::command]
pub async fn device_wifi_ip(
    state: State<'_, AppState>,
    serial: String,
) -> AppResult<Option<String>> {
    wireless::device_ip(&state.server, &serial).await
}

/// Re-runs the transport handshake (shows the RSA prompt again).
#[tauri::command]
pub async fn devices_reconnect(state: State<'_, AppState>, serial: String) -> AppResult<()> {
    wireless::reconnect(&state.server, &serial).await
}

#[tauri::command]
pub async fn devices_reconnect_offline(state: State<'_, AppState>) -> AppResult<()> {
    wireless::reconnect_offline(&state.server).await
}

#[tauri::command]
pub async fn devices_summary(
    state: State<'_, AppState>,
    serial: String,
) -> AppResult<DeviceSummary> {
    summary::device_summary(&state.server, &serial).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvdEntry {
    #[serde(flatten)]
    pub avd: Avd,
    /// Serial of the running emulator for this AVD, if any.
    pub running: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvdList {
    /// False when no SDK `emulator` binary was found.
    pub can_launch: bool,
    pub avds: Vec<AvdEntry>,
}

#[tauri::command]
pub async fn avd_list(state: State<'_, AppState>) -> AppResult<AvdList> {
    let adb = state.adb();
    let can_launch = avd::emulator_binary(adb.as_ref().map(|a| a.path.as_path())).is_some();
    let avds = avd::avd_home()
        .map(|home| avd::list_in(&home))
        .unwrap_or_default();

    // Map running emulators to their AVD via ro.boot.qemu.avd_name.
    let mut running = Vec::new();
    for d in list_devices(&state.server).await.unwrap_or_default() {
        if d.transport != Transport::Emulator {
            continue;
        }
        if let Ok(name) = state
            .server
            .exec_text(&d.serial, "getprop ro.boot.qemu.avd_name")
            .await
        {
            running.push((name.trim().to_owned(), d.serial));
        }
    }
    let avds = avds
        .into_iter()
        .map(|avd| AvdEntry {
            running: running
                .iter()
                .find(|(name, _)| *name == avd.name)
                .map(|(_, s)| s.clone()),
            avd,
        })
        .collect();
    Ok(AvdList { can_launch, avds })
}

#[tauri::command]
pub fn avd_launch(state: State<'_, AppState>, name: String) -> AppResult<()> {
    let adb = state.adb();
    let emulator = avd::emulator_binary(adb.as_ref().map(|a| a.path.as_path()))
        .ok_or_else(|| AppError::Device("the Android emulator is not installed".into()))?;
    avd::launch(&emulator, &name)
}

/// Runs a shell command (no PTY) for the multi-device "Run command…".
#[tauri::command]
pub async fn devices_exec(
    state: State<'_, AppState>,
    serial: String,
    command: String,
) -> AppResult<String> {
    if command.trim().is_empty() {
        return Err(AppError::InvalidInput("empty command".into()));
    }
    state.server.exec_text(&serial, &command).await
}

/// Saves `screencap -p` to `<dir>/Screenshot_<serial>_<unix ms>.png`
/// (`dir` defaults to `<Pictures>/Tether`). Returns the file path.
#[tauri::command]
pub async fn devices_screenshot(
    app: AppHandle,
    state: State<'_, AppState>,
    serial: String,
    dir: Option<String>,
) -> AppResult<String> {
    let dir = match dir.filter(|d| !d.is_empty()) {
        Some(d) => PathBuf::from(d),
        None => app
            .path()
            .picture_dir()
            .map_err(|e| AppError::Device(e.to_string()))?
            .join("Tether"),
    };
    let png = state.server.exec(&serial, "screencap -p").await?;
    if !png.starts_with(b"\x89PNG") {
        let head = &png[..png.len().min(200)];
        return Err(AppError::Device(
            String::from_utf8_lossy(head).trim().to_owned(),
        ));
    }
    tokio::fs::create_dir_all(&dir).await?;
    let stamp = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let safe: String = serial
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    let path = dir.join(format!("Screenshot_{safe}_{stamp}.png"));
    tokio::fs::write(&path, png).await?;
    Ok(path.display().to_string())
}
