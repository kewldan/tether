use serde::Serialize;
use tauri::State;

use crate::adb::forward::{self, Direction, PortRule};
use crate::adb::host_ports::{self, HostPortUsage};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortRules {
    pub forward: Vec<PortRule>,
    pub reverse: Vec<PortRule>,
}

#[tauri::command]
pub async fn ports_list(state: State<'_, AppState>, serial: String) -> AppResult<PortRules> {
    let forward = forward::list_forward(&state.server, &serial).await?;
    let reverse = forward::list_reverse(&state.server, &serial).await?;
    Ok(PortRules { forward, reverse })
}

/// Adds a rule. `local` is the listening side (host for forward, device for
/// reverse), `remote` where connections go. Returns the port adb picked
/// when `local` is `tcp:0`.
#[tauri::command]
pub async fn ports_add(
    state: State<'_, AppState>,
    serial: String,
    direction: Direction,
    local: String,
    remote: String,
    no_rebind: Option<bool>,
) -> AppResult<Option<u16>> {
    let no_rebind = no_rebind.unwrap_or(false);
    match direction {
        Direction::Forward => {
            forward::forward(&state.server, &serial, &local, &remote, no_rebind).await
        }
        Direction::Reverse => {
            forward::reverse(&state.server, &serial, &local, &remote, no_rebind).await
        }
    }
}

#[tauri::command]
pub async fn ports_remove(
    state: State<'_, AppState>,
    serial: String,
    direction: Direction,
    local: String,
) -> AppResult<()> {
    match direction {
        Direction::Forward => forward::kill_forward(&state.server, &serial, &local).await,
        Direction::Reverse => forward::kill_reverse(&state.server, &serial, &local).await,
    }
}

#[tauri::command]
pub async fn ports_remove_all(state: State<'_, AppState>, serial: String) -> AppResult<()> {
    forward::kill_all(&state.server, &serial).await
}

/// Connections on each host port and the process listening on it.
#[tauri::command]
pub async fn ports_host_usage(ports: Vec<u16>) -> AppResult<Vec<HostPortUsage>> {
    tokio::task::spawn_blocking(move || host_ports::usage(&ports))
        .await
        .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))
}

/// First free port on this computer at or after `start`.
#[tauri::command]
pub fn ports_free_host_port(start: u16) -> Option<u16> {
    forward::free_host_port(start)
}
