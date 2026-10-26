use tauri::ipc::Channel;
use tauri::{AppHandle, State};

use crate::error::{AppError, AppResult};
use crate::tray::view::TrayConfig;
use crate::tray::{self, TrayEvent, TrayState};

/// Pushes display names, the selected device, localized labels and the
/// tray preferences. Async so it never runs on the main thread, which the
/// menu rebuild waits for.
#[tauri::command]
pub async fn tray_sync(app: AppHandle, config: TrayConfig) -> AppResult<()> {
    tray::sync(&app, config).map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))
}

/// Subscribes to tray menu clicks; replaces the previous subscription.
#[tauri::command]
pub fn tray_watch(tray: State<'_, TrayState>, on_event: Channel<TrayEvent>) {
    tray.watch(on_event);
}
