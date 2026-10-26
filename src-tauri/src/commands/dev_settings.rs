//! Developer toggles.

use tauri::State;

use crate::device::dev_settings::{self, DevChange, DevSettings};
use crate::error::AppResult;
use crate::state::AppState;

#[tauri::command]
pub async fn read_dev_settings(
    state: State<'_, AppState>,
    serial: String,
) -> AppResult<DevSettings> {
    dev_settings::read(&state.server, &serial).await
}

/// Applies one change and returns the settings as the device reports them
/// afterwards.
#[tauri::command]
pub async fn apply_dev_setting(
    state: State<'_, AppState>,
    serial: String,
    change: DevChange,
) -> AppResult<DevSettings> {
    dev_settings::apply(&state.server, &serial, &change).await
}

/// Locales the system language can be switched to (Android 16+).
#[tauri::command]
pub async fn device_locales(state: State<'_, AppState>, serial: String) -> AppResult<Vec<String>> {
    dev_settings::device_locales(&state.server, &serial).await
}

/// An app's own languages (Android 13+); empty = follows the system.
#[tauri::command]
pub async fn app_locales(
    state: State<'_, AppState>,
    serial: String,
    package: String,
) -> AppResult<Vec<String>> {
    dev_settings::app_locales(&state.server, &serial, &package).await
}

#[tauri::command]
pub async fn set_app_locales(
    state: State<'_, AppState>,
    serial: String,
    package: String,
    locales: Vec<String>,
) -> AppResult<Vec<String>> {
    dev_settings::set_app_locales(&state.server, &serial, &package, &locales).await
}
