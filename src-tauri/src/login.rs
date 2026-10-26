//! "Open at login" (`tauri-plugin-autostart`: a LaunchAgent on macOS, the
//! Run registry key on Windows, an XDG autostart `.desktop` file on Linux).
//!
//! The login item starts Tether with [`AUTOSTART_ARG`]. Such a launch
//! begins with the main window hidden; once the webview has read its
//! preferences it calls `commands::login::login_launch_settle`, which
//! shows the window unless the user chose "start hidden in the menu bar"
//! and the tray icon is on.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{App, AppHandle, Manager};

/// Command-line flag the login item passes.
pub const AUTOSTART_ARG: &str = "--autostart";

/// Whether this process was started by the login item and still waits for
/// the webview to decide on the window.
#[derive(Default)]
pub struct LoginLaunch(AtomicBool);

pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_autostart::init(
        tauri_plugin_autostart::MacosLauncher::LaunchAgent,
        Some(vec![AUTOSTART_ARG]),
    )
}

/// Hides the main window of a login launch before it is drawn.
pub fn setup(app: &App) {
    if !std::env::args().any(|a| a == AUTOSTART_ARG) {
        return;
    }
    app.state::<LoginLaunch>().0.store(true, Ordering::Relaxed);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

/// Clears the login-launch flag; true when this process was started by
/// the login item and the webview had not settled it yet.
pub fn take(app: &AppHandle) -> bool {
    app.state::<LoginLaunch>().0.swap(false, Ordering::Relaxed)
}
