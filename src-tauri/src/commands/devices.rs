use std::time::Duration;

use serde::Serialize;
use tauri::State;
use tauri::ipc::Channel;

use crate::adb::devices::{self, Device};
use crate::device::props::{self, DeviceInfo};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

const RETRY_DELAY: Duration = Duration::from_secs(2);

#[derive(Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum DevicesEvent {
    Devices { devices: Vec<Device> },
    ServerDown { error: AppError },
}

/// Streams device list snapshots to `on_event`. Restarts the adb server and
/// resubscribes whenever the connection drops. Calling it again replaces the
/// previous subscription.
#[tauri::command]
pub fn watch_devices(state: State<'_, AppState>, on_event: Channel<DevicesEvent>) -> AppResult<()> {
    let adb = state.adb().ok_or(AppError::AdbNotFound)?;
    let server = state.server;

    let handle = tauri::async_runtime::spawn(async move {
        loop {
            let result = async {
                server.ensure_running(&adb.path).await?;
                devices::track(&server, |devices| {
                    let _ = on_event.send(DevicesEvent::Devices { devices });
                })
                .await
            }
            .await;

            if let Err(error) = result {
                let _ = on_event.send(DevicesEvent::ServerDown { error });
            }
            tokio::time::sleep(RETRY_DELAY).await;
        }
    });

    let mut watcher = state
        .device_watcher
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if let Some(previous) = watcher.replace(handle) {
        previous.abort();
    }
    Ok(())
}

#[tauri::command]
pub async fn device_info(state: State<'_, AppState>, serial: String) -> AppResult<DeviceInfo> {
    props::device_info(&state.server, &serial).await
}
