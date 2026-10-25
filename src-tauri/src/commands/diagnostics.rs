use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::State;

use crate::adb::diagnostics::{self, Check, Facts};
use crate::adb::locator;
use crate::adb::server::DEFAULT_PORT;
use crate::adb::{usb, wireless};
use crate::commands::connection::{ConnectionState, list_devices};
use crate::error::AppResult;
use crate::state::{AppState, lock};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsReport {
    /// Unix time in milliseconds.
    pub checked_at: u64,
    pub checks: Vec<Check>,
    pub facts: Facts,
}

/// Runs the "Can't see your device?" checklist against the live system.
#[tauri::command]
pub async fn diagnostics_run(
    state: State<'_, AppState>,
    conn: State<'_, ConnectionState>,
) -> AppResult<DiagnosticsReport> {
    let server = state.server;
    let adb = state.adb();
    let os = std::env::consts::OS;

    let client_version = async {
        match &adb {
            Some(a) => locator::client_protocol_version(&a.path).await,
            None => None,
        }
    };
    let (server_version, client_version, process, devices, usb, mdns) = tokio::join!(
        server.version(),
        client_version,
        diagnostics::server_process(DEFAULT_PORT),
        list_devices(&server),
        usb::scan(),
        wireless::mdns_check(&server),
    );
    let (server_version, server_error) = match server_version {
        Ok(v) => (Some(v), None),
        Err(e) => (None, Some(e.to_string())),
    };

    let facts = Facts {
        os,
        adb_path: adb.as_ref().map(|a| a.path.clone()),
        adb_version: adb.as_ref().and_then(|a| a.version.clone()),
        client_version,
        server_version,
        server_error,
        server_port: DEFAULT_PORT,
        process,
        started_by_us: lock(&conn.server_started_at).is_some(),
        server_drops: conn.drops_last_minute(),
        server_log: conn.log_lines(),
        devices: devices.unwrap_or_default(),
        usb: Some(usb),
        mdns: mdns.ok(),
        udev_rules: (os == "linux").then(diagnostics::udev_rules),
    };
    let checked_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0);
    Ok(DiagnosticsReport {
        checked_at,
        checks: diagnostics::evaluate(&facts),
        facts,
    })
}
