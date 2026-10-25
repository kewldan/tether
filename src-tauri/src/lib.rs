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
        .manage(commands::overview::OverviewState::default())
        .manage(commands::bugreport::BugreportState::default())
        .manage(commands::shell::ShellSessions::default())
        .manage(commands::perf::PerfSubscriptions::default())
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
            commands::overview::device_snapshot,
            commands::overview::reboot_device,
            commands::overview::take_screenshot,
            commands::overview::start_recording,
            commands::overview::stop_recording,
            commands::overview::recording_status,
            commands::gallery::list_captures,
            commands::gallery::delete_capture,
            commands::dev_settings::read_dev_settings,
            commands::dev_settings::apply_dev_setting,
            commands::bugreport::create_bugreport,
            commands::bugreport::cancel_bugreport,
            commands::bugreport::list_bugreports,
            commands::bugreport::delete_bugreport,
            commands::shell::shell_open,
            commands::shell::shell_write,
            commands::shell::shell_resize,
            commands::shell::shell_close,
            commands::shell::shell_exec,
            commands::ports::ports_list,
            commands::ports::ports_add,
            commands::ports::ports_remove,
            commands::ports::ports_remove_all,
            commands::ports::ports_free_host_port,
            commands::intents::intent_send,
            commands::intents::intent_command,
            commands::intents::input_text,
            commands::intents::input_key,
            commands::perf::perf_subscribe,
            commands::perf::perf_unsubscribe,
            commands::perf::perf_processes,
            commands::perf::perf_kill,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
