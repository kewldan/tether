pub mod adb;
mod commands;
pub mod device;
pub mod error;
mod state;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(state::AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::adb::locate_adb,
            commands::adb::install_platform_tools,
            commands::adb::cancel_platform_tools_install,
            commands::devices::watch_devices,
            commands::devices::device_info,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
