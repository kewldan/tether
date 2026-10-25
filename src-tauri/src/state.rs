use std::sync::Mutex;

use tauri::async_runtime::JoinHandle;

use crate::adb::locator::AdbInstall;
use crate::adb::server::AdbServer;

#[derive(Default)]
pub struct AppState {
    pub server: AdbServer,
    pub adb: Mutex<Option<AdbInstall>>,
    /// The single device tracking loop; replaced when the UI resubscribes.
    pub device_watcher: Mutex<Option<JoinHandle<()>>>,
}

impl AppState {
    pub fn adb(&self) -> Option<AdbInstall> {
        self.adb.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
}
