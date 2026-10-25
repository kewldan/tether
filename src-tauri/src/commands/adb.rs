use tauri::{AppHandle, Manager, State};

use crate::adb::locator::{self, AdbInstall, LocatorEnv};
use crate::error::AppResult;
use crate::state::AppState;

/// Looks for adb and remembers the result for later commands.
#[tauri::command]
pub async fn locate_adb(
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<Option<AdbInstall>> {
    let app_data = app.path().app_data_dir().ok();
    let env = LocatorEnv::from_process(None, app_data);
    let found = locator::locate(&env).await;
    *state.adb.lock().unwrap_or_else(|e| e.into_inner()) = found.clone();
    Ok(found)
}
