use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use tauri::async_runtime::JoinHandle;

use crate::adb::locator::AdbInstall;
use crate::adb::server::AdbServer;

#[derive(Default)]
pub struct AppState {
    pub server: AdbServer,
    pub adb: Mutex<Option<AdbInstall>>,
    /// The single device tracking loop; replaced when the UI resubscribes.
    pub device_watcher: Mutex<Option<JoinHandle<()>>>,
    /// Cancellation flag of the running platform-tools download, if any.
    pub install_cancel: Mutex<Option<Arc<AtomicBool>>>,
}

impl AppState {
    pub fn adb(&self) -> Option<AdbInstall> {
        lock(&self.adb).clone()
    }

    pub fn set_adb(&self, install: Option<AdbInstall>) {
        *lock(&self.adb) = install;
    }
}

/// Locks a mutex, ignoring poisoning: the guarded values stay consistent
/// even if a holder panicked.
pub fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}
