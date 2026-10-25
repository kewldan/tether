pub mod adb;
mod commands;
pub mod device;
pub mod error;
mod state;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(state::AppState::default())
        .manage(commands::files::FilesState::default())
        .manage(commands::logcat::LogcatSessions::default())
        .invoke_handler(tauri::generate_handler![
            commands::adb::locate_adb,
            commands::adb::install_platform_tools,
            commands::adb::cancel_platform_tools_install,
            commands::devices::watch_devices,
            commands::devices::device_info,
            commands::files::files_list,
            commands::files::files_mkdir,
            commands::files::files_rename,
            commands::files::files_delete,
            commands::files::files_chmod,
            commands::files::files_storage,
            commands::files::files_preview,
            commands::files::files_default_download_dir,
            commands::files::files_local_summary,
            commands::files::files_pull,
            commands::files::files_push,
            commands::files::files_transfer_control,
            commands::logcat::logcat_start,
            commands::logcat::logcat_stop,
            commands::logcat::logcat_clear,
            commands::logcat::logcat_packages,
            commands::logcat::logcat_package_processes,
            commands::logcat::logcat_export,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
