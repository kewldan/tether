use std::time::Duration;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use crate::adb::devices::{self, Device};
use crate::commands::connection::ConnectionState;
use crate::device::props::{self, DeviceInfo};
use crate::error::{AppError, AppResult};
use crate::state::{AppState, lock};
use crate::tray;

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
pub fn watch_devices(
    app: AppHandle,
    state: State<'_, AppState>,
    on_event: Channel<DevicesEvent>,
) -> AppResult<()> {
    let adb = state.adb().ok_or(AppError::AdbNotFound)?;
    let server = state.server;

    let handle = tauri::async_runtime::spawn(async move {
        let conn = app.state::<ConnectionState>();
        loop {
            let mut tracking = false;
            let result = async {
                let was_running = server.version().await.is_ok();
                server.ensure_running(&adb.path).await?;
                if !was_running {
                    conn.server_started();
                }
                tracking = true;
                devices::track(&server, |devices| {
                    tray::set_devices(&app, &devices);
                    let _ = on_event.send(DevicesEvent::Devices { devices });
                })
                .await
            }
            .await;

            if let Err(error) = result {
                // Losing a live subscription means someone killed or
                // restarted the server; diagnostics counts these.
                if tracking {
                    conn.server_dropped(&error);
                }
                tray::set_devices(&app, &[]);
                let _ = on_event.send(DevicesEvent::ServerDown { error });
            }
            tokio::time::sleep(RETRY_DELAY).await;
        }
    });

    let mut watcher = lock(&state.device_watcher);
    if let Some(previous) = watcher.replace(handle) {
        previous.abort();
    }
    Ok(())
}

#[tauri::command]
pub async fn device_info(state: State<'_, AppState>, serial: String) -> AppResult<DeviceInfo> {
    props::device_info(&state.server, &serial).await
}
