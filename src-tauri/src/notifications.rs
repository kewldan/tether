//! System notifications are composed and sent by the webview through
//! `tauri-plugin-notification`. This hook only brings the window back when
//! one is clicked, which works even while the hidden webview is throttled;
//! the webview's own `onAction` listener then routes the click (select the
//! device, open Logcat).

use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

/// Registers the click handler. A notification opts out of focusing the
/// window with `extra: { focus: false }`.
pub fn setup(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.notification().on_action(move |performed| {
        let focus = performed
            .notification()
            .and_then(|n| n.extra().get("focus"))
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(true);
        if focus {
            crate::tray::show_main_window(&handle);
        }
    });
}
