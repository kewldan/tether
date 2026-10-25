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
