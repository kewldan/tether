use tauri::AppHandle;

use crate::{login, tray};

/// Shows the window of a login launch unless it should stay in the tray
/// (`stay_hidden`). Returns whether this was a login launch; later calls
/// are no-ops.
#[tauri::command]
pub fn login_launch_settle(app: AppHandle, stay_hidden: bool) -> bool {
    let at_login = login::take(&app);
    if at_login && !stay_hidden {
        tray::show_main_window(&app);
    }
    at_login
}
