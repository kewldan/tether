use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use crate::adb::installer::{self, InstallEvent};
use crate::adb::locator::{self, AdbInstall, AdbSource, LocatorEnv};
use crate::error::{AppError, AppResult};
use crate::state::{AppState, lock};

/// Looks for adb and remembers the result for later commands.
#[tauri::command]
pub async fn locate_adb(
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<Option<AdbInstall>> {
    let app_data = app.path().app_data_dir().ok();
    let env = LocatorEnv::from_process(None, app_data);
    let found = locator::locate(&env).await;
    state.set_adb(found.clone());
    Ok(found)
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
