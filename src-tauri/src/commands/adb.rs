use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use std::path::PathBuf;
use std::time::Duration;

use serde::Serialize;

use crate::adb::installer::{self, InstallEvent};
use crate::adb::locator::{self, ADB_EXE, AdbInstall, AdbSource, LocationCheck, LocatorEnv};
use crate::adb::server::{DEFAULT_PORT, send_request};
use crate::adb::{diagnostics, hostkey};
use crate::commands::connection::ConnectionState;
use crate::error::{AppError, AppResult};
use crate::state::{AppState, lock};

/// Lookup inputs. `custom_path` is the adb chosen in settings; with
/// `prefer_bundled` Tether's own platform-tools win over everything else.
fn locator_env(app: &AppHandle, custom_path: Option<String>, prefer_bundled: bool) -> LocatorEnv {
    let app_data = app.path().app_data_dir().ok();
    let bundled = app_data
        .as_ref()
        .map(|d| d.join("platform-tools").join(ADB_EXE))
        .filter(|p| prefer_bundled && p.is_file());
    let custom = custom_path.filter(|p| !p.is_empty()).map(PathBuf::from);
    LocatorEnv::from_process(bundled.or(custom), app_data)
}

/// The settings slot also carries "prefer Tether's copy"; report that as
/// bundled rather than as a custom path.
fn fix_source(app: &AppHandle, mut install: AdbInstall) -> AdbInstall {
    let bundled = app
        .path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("platform-tools").join(ADB_EXE));
    if bundled.as_deref() == Some(install.path.as_path()) {
        install.source = AdbSource::Bundled;
    }
    install
}

/// Looks for adb and remembers the result for later commands.
#[tauri::command]
pub async fn locate_adb(
    app: AppHandle,
    state: State<'_, AppState>,
    custom_path: Option<String>,
    prefer_bundled: Option<bool>,
) -> AppResult<Option<AdbInstall>> {
    let env = locator_env(&app, custom_path, prefer_bundled.unwrap_or(false));
    let found = locator::locate(&env).await.map(|i| fix_source(&app, i));
    state.set_adb(found.clone());
    Ok(found)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdbScan {
    /// Every place that was checked, in priority order.
    pub checks: Vec<LocationCheck>,
    /// The adb that will be used: the first one found.
    pub install: Option<AdbInstall>,
}

/// Like [`locate_adb`], but reports every location it looked at for the
/// onboarding search list.
#[tauri::command]
pub async fn adb_scan(
    app: AppHandle,
    state: State<'_, AppState>,
    custom_path: Option<String>,
    prefer_bundled: Option<bool>,
) -> AppResult<AdbScan> {
    let env = locator_env(&app, custom_path, prefer_bundled.unwrap_or(false));
    let checks = tokio::task::spawn_blocking(move || locator::scan(&env))
        .await
        .map_err(|e| AppError::Io(std::io::Error::other(e)))?;
    let first = checks
        .iter()
        .find_map(|c| Some((c.found.clone()?, c.source)));
    let install = match first {
        Some((path, source)) => Some(fix_source(&app, locator::inspect(path, source).await)),
        None => None,
    };
    state.set_adb(install.clone());
    Ok(AdbScan { checks, install })
}

/// Validates an adb binary the user picked and makes it the active one.
#[tauri::command]
pub async fn adb_use_path(state: State<'_, AppState>, path: String) -> AppResult<AdbInstall> {
    let install = locator::inspect_custom(PathBuf::from(&path))
        .await
        .ok_or_else(|| AppError::InvalidInput(format!("{path} is not a working adb")))?;
    state.set_adb(Some(install.clone()));
    Ok(install)
}

/// Fingerprint of this computer's adb key as the phone shows it in
/// "Allow USB debugging?". `None` until adb generated a key.
#[tauri::command]
pub fn adb_key_fingerprint() -> Option<String> {
    hostkey::android_user_home().and_then(|dir| hostkey::fingerprint_in(&dir))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    pub running: bool,
    pub version: Option<u32>,
    pub port: u16,
    pub started_by_us: bool,
    pub uptime_secs: Option<u64>,
    pub binary: Option<PathBuf>,
}

#[tauri::command]
pub async fn adb_server_status(
    state: State<'_, AppState>,
    conn: State<'_, ConnectionState>,
) -> AppResult<ServerStatus> {
    let (version, process) = tokio::join!(
        state.server.version(),
        diagnostics::server_process(DEFAULT_PORT)
    );
    Ok(ServerStatus {
        running: version.is_ok(),
        version: version.ok(),
        port: DEFAULT_PORT,
        started_by_us: lock(&conn.server_started_at).is_some(),
        uptime_secs: process.uptime_secs,
        binary: process.binary,
    })
}

/// Starts the server with the active adb if nothing listens yet.
#[tauri::command]
pub async fn adb_ensure_server(
    state: State<'_, AppState>,
    conn: State<'_, ConnectionState>,
) -> AppResult<u32> {
    let adb = state.adb().ok_or(AppError::AdbNotFound)?;
    if let Ok(version) = state.server.version().await {
        return Ok(version);
    }
    state.server.ensure_running(&adb.path).await?;
    conn.server_started();
    state.server.version().await
}

/// Kills the running server (whoever started it) and starts it again with
/// the active adb. Other tools on the server reconnect on their own.
#[tauri::command]
pub async fn adb_restart_server(
    state: State<'_, AppState>,
    conn: State<'_, ConnectionState>,
) -> AppResult<u32> {
    let adb = state.adb().ok_or(AppError::AdbNotFound)?;
    let server = state.server;
    conn.log("restarting the adb server".into());
    // `host:kill` answers OKAY and then the server exits.
    if let Ok(mut stream) = server.connect().await {
        let _ = send_request(&mut stream, "host:kill").await;
    }
    for _ in 0..30 {
        if server.version().await.is_err() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    server.ensure_running(&adb.path).await?;
    conn.server_started();
    server.version().await
}

/// Downloads platform-tools from Google into the app data directory and
/// makes the bundled adb the active one. The frontend must have shown the
/// license and obtained the user's consent before calling this.
#[tauri::command]
pub async fn install_platform_tools(
    app: AppHandle,
    state: State<'_, AppState>,
    on_event: Channel<InstallEvent>,
) -> AppResult<AdbInstall> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Download(e.to_string()))?;

    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut slot = lock(&state.install_cancel);
        if slot.is_some() {
            return Err(AppError::Download("a download is already running".into()));
        }
        *slot = Some(cancel.clone());
    }

    let result = installer::install(&app_data, &cancel, |event| {
        let _ = on_event.send(event);
    })
    .await;
    *lock(&state.install_cancel) = None;

    let install = locator::inspect(result?, AdbSource::Bundled).await;
    state.set_adb(Some(install.clone()));
    Ok(install)
}

#[tauri::command]
pub fn cancel_platform_tools_install(state: State<'_, AppState>) {
    if let Some(cancel) = lock(&state.install_cancel).as_ref() {
        cancel.store(true, Ordering::Relaxed);
    }
}
