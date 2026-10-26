//! Commands of the Apps page: package list and details, per-app actions,
//! APK install (multi-device, cancellable) and APK extraction.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use crate::device::apk::file::{self, PackageFile};
use crate::device::apk::signing::SigningInfo;
use crate::device::packages::actions::{self, OpMode, StandbyBucket};
use crate::device::packages::extract::{self, ExtractEvent};
use crate::device::packages::install::{self, InstallEvent, InstallOptions, InstalledVersion};
use crate::device::packages::meta::{self, AppMeta, MetaCache, MetaRequest};
use crate::device::packages::network::{self, NetworkUsage};
use crate::device::packages::signing;
use crate::device::packages::{
    self, AppBattery, AppComponents, AppDetails, AppOps, AppStorage, AppSummary,
};
use crate::error::{AppError, AppResult};
use crate::state::{AppState, lock};

/// How many APKs are read at once while resolving labels and icons.
const META_PARALLEL: usize = 4;

/// Apps-specific state, registered with `.manage(AppsState::default())`.
#[derive(Default)]
pub struct AppsState {
    meta: Arc<MetaCache>,
    /// Bumped per serial on every `load_app_meta`, stopping older loads.
    meta_generation: Mutex<HashMap<String, Arc<AtomicU64>>>,
    /// Cancellation flags of installs/extractions: `job` and `job:serial`.
    jobs: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl AppsState {
    fn job_flag(&self, key: &str) -> Arc<AtomicBool> {
        lock(&self.jobs)
            .entry(key.to_owned())
            .or_insert_with(|| Arc::new(AtomicBool::new(false)))
            .clone()
    }

    fn finish_job(&self, key: &str) {
        lock(&self.jobs).remove(key);
    }
}

#[tauri::command]
pub async fn list_apps(state: State<'_, AppState>, serial: String) -> AppResult<Vec<AppSummary>> {
    packages::list(&state.server, &serial).await
}

#[tauri::command]
pub async fn app_details(
    state: State<'_, AppState>,
    serial: String,
    package: String,
) -> AppResult<AppDetails> {
    packages::details(&state.server, &serial, &package).await
}

#[tauri::command]
pub async fn app_components(
    state: State<'_, AppState>,
    serial: String,
    package: String,
) -> AppResult<AppComponents> {
    packages::components(&state.server, &serial, &package).await
}

#[tauri::command]
pub async fn app_storage(
    state: State<'_, AppState>,
    serial: String,
    package: String,
) -> AppResult<AppStorage> {
    packages::storage(&state.server, &serial, &package).await
}

#[tauri::command]
pub async fn app_ops(
    state: State<'_, AppState>,
    serial: String,
    package: String,
    uid: Option<u32>,
) -> AppResult<AppOps> {
    packages::app_ops(&state.server, &serial, &package, uid).await
}

#[tauri::command]
pub async fn app_battery(
    state: State<'_, AppState>,
    serial: String,
    package: String,
) -> AppResult<AppBattery> {
    packages::battery(&state.server, &serial, &package).await
}

#[tauri::command]
pub async fn app_signing(
    state: State<'_, AppState>,
    serial: String,
    package: String,
) -> AppResult<SigningInfo> {
    signing::signing(&state.server, &serial, &package).await
}

#[tauri::command]
pub async fn app_network(
    state: State<'_, AppState>,
    serial: String,
    uid: u32,
) -> AppResult<NetworkUsage> {
    network::network_usage(&state.server, &serial, uid).await
}

/// Streams labels and icons for `apps`. Cached entries arrive first; a new
/// call for the same device stops the previous one.
#[tauri::command]
pub async fn load_app_meta(
    app: AppHandle,
    state: State<'_, AppState>,
    apps_state: State<'_, AppsState>,
    serial: String,
    apps: Vec<MetaRequest>,
    on_event: Channel<Vec<AppMeta>>,
) -> AppResult<()> {
    if let Ok(dir) = app.path().app_cache_dir() {
        apps_state.meta.set_dir(dir.join("app-meta"));
    }
    let generation = lock(&apps_state.meta_generation)
        .entry(serial.clone())
        .or_default()
        .clone();
    let mine = generation.fetch_add(1, Ordering::SeqCst) + 1;

    let server = state.server;
    let locale_out = server
        .exec_text(
            &serial,
            "getprop persist.sys.locale; getprop ro.product.locale",
        )
        .await
        .unwrap_or_default();
    let locale = locale_out
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("en-US")
        .to_owned();

    let cache = apps_state.meta.clone();
    let mut cached = Vec::new();
    let mut missing = Vec::new();
    for req in apps {
        match cache.get(&req, &locale) {
            Some(hit) => cached.push(hit),
            None => missing.push(req),
        }
    }
    if !cached.is_empty() {
        let _ = on_event.send(cached);
    }

    tauri::async_runtime::spawn(async move {
        let queue = Arc::new(tokio::sync::Mutex::new(missing.into_iter()));
        let mut workers = tokio::task::JoinSet::new();
        for _ in 0..META_PARALLEL {
            let queue = queue.clone();
            let cache = cache.clone();
            let generation = generation.clone();
            let serial = serial.clone();
            let locale = locale.clone();
            let on_event = on_event.clone();
            workers.spawn(async move {
                loop {
                    if generation.load(Ordering::SeqCst) != mine {
                        return;
                    }
                    let Some(req) = queue.lock().await.next() else {
                        return;
                    };
                    let meta = meta::load(&server, &serial, &req, &locale).await;
                    cache.put(&req, &locale, &meta);
                    if on_event.send(vec![meta]).is_err() {
                        return;
                    }
                }
            });
        }
        while workers.join_next().await.is_some() {}
    });
    Ok(())
}

#[tauri::command]
pub async fn launch_app(
    state: State<'_, AppState>,
    serial: String,
    package: String,
) -> AppResult<()> {
    actions::launch(&state.server, &serial, &package).await
}

#[tauri::command]
pub async fn start_activity(
    state: State<'_, AppState>,
    serial: String,
    component: String,
) -> AppResult<()> {
    actions::start_activity(&state.server, &serial, &component).await
}

#[tauri::command]
pub async fn force_stop_app(
    state: State<'_, AppState>,
    serial: String,
    package: String,
) -> AppResult<()> {
    actions::force_stop(&state.server, &serial, &package).await
}

#[tauri::command]
pub async fn clear_app_data(
    state: State<'_, AppState>,
    serial: String,
    package: String,
    cache_only: bool,
) -> AppResult<()> {
    actions::clear(&state.server, &serial, &package, cache_only).await
}

#[tauri::command]
pub async fn set_app_enabled(
    state: State<'_, AppState>,
    serial: String,
    package: String,
    enabled: bool,
) -> AppResult<()> {
    actions::set_enabled(&state.server, &serial, &package, enabled).await
}

#[tauri::command]
pub async fn uninstall_app(
    state: State<'_, AppState>,
    serial: String,
    package: String,
    keep_data: bool,
    system: bool,
) -> AppResult<()> {
    actions::uninstall(&state.server, &serial, &package, keep_data, system).await
}

#[tauri::command]
pub async fn install_existing_app(
    state: State<'_, AppState>,
    serial: String,
    package: String,
) -> AppResult<()> {
    actions::install_existing(&state.server, &serial, &package).await
}

#[tauri::command]
pub async fn set_app_permission(
    state: State<'_, AppState>,
    serial: String,
    package: String,
    permission: String,
    granted: bool,
) -> AppResult<()> {
    actions::set_permission(&state.server, &serial, &package, &permission, granted).await
}

#[tauri::command]
pub async fn reset_app_permissions(
    state: State<'_, AppState>,
    serial: String,
    package: String,
    permissions: Vec<String>,
) -> AppResult<()> {
    actions::reset_permissions(&state.server, &serial, &package, &permissions).await
}

#[tauri::command]
pub async fn set_app_op(
    state: State<'_, AppState>,
    serial: String,
    package: String,
    op: String,
    mode: OpMode,
    uid_scope: bool,
) -> AppResult<()> {
    actions::set_app_op(&state.server, &serial, &package, &op, mode, uid_scope).await
}

#[tauri::command]
pub async fn set_standby_bucket(
    state: State<'_, AppState>,
    serial: String,
    package: String,
    bucket: StandbyBucket,
) -> AppResult<()> {
    actions::set_standby_bucket(&state.server, &serial, &package, bucket).await
}

#[tauri::command]
pub async fn set_battery_unrestricted(
    state: State<'_, AppState>,
    serial: String,
    package: String,
    unrestricted: bool,
) -> AppResult<()> {
    actions::set_battery_unrestricted(&state.server, &serial, &package, unrestricted).await
}

/// Reads identity, label, icon and signing of a local `.apk/.apks/.xapk`.
#[tauri::command]
pub async fn inspect_package_file(path: String, locale: String) -> AppResult<PackageFile> {
    tauri::async_runtime::spawn_blocking(move || file::inspect(&PathBuf::from(path), &locale))
        .await
        .map_err(|e| AppError::Device(e.to_string()))?
}

#[tauri::command]
pub async fn installed_version(
    state: State<'_, AppState>,
    serial: String,
    package: String,
) -> AppResult<Option<InstalledVersion>> {
    install::installed_version(&state.server, &serial, &package).await
}

/// Installs a package file on every serial in parallel. Per-device events
/// go to `on_event`; the command returns when all devices finished.
#[tauri::command]
pub async fn install_package(
    state: State<'_, AppState>,
    apps_state: State<'_, AppsState>,
    job_id: String,
    serials: Vec<String>,
    path: String,
    options: InstallOptions,
    on_event: Channel<InstallEvent>,
) -> AppResult<()> {
    let pkg = tauri::async_runtime::spawn_blocking({
        let path = path.clone();
        move || file::inspect(&PathBuf::from(path), "en")
    })
    .await
    .map_err(|e| AppError::Device(e.to_string()))??;
    let pkg = Arc::new(pkg);

    let mut tasks = tokio::task::JoinSet::new();
    let mut keys = Vec::new();
    for serial in serials {
        let key = format!("{job_id}:{serial}");
        let cancel = apps_state.job_flag(&key);
        keys.push(key);
        let server = state.server;
        let pkg = pkg.clone();
        let on_event = on_event.clone();
        tasks.spawn(install::install_on(
            server,
            serial,
            pkg,
            options,
            cancel,
            move |e| {
                let _ = on_event.send(e);
            },
        ));
    }
    while tasks.join_next().await.is_some() {}
    for key in keys {
        apps_state.finish_job(&key);
    }
    Ok(())
}

/// Cancels an install or extraction job, or one device of an install.
#[tauri::command]
pub fn cancel_apps_job(apps_state: State<'_, AppsState>, job_id: String, serial: Option<String>) {
    let jobs = lock(&apps_state.jobs);
    for (key, flag) in jobs.iter() {
        let hit = match &serial {
            Some(s) => *key == format!("{job_id}:{s}"),
            None => *key == job_id || key.starts_with(&format!("{job_id}:")),
        };
        if hit {
            flag.store(true, Ordering::Relaxed);
        }
    }
}

/// Copies APKs of `packages` into `dest`, one after another.
#[tauri::command]
pub async fn extract_apks(
    state: State<'_, AppState>,
    apps_state: State<'_, AppsState>,
    job_id: String,
    serial: String,
    packages: Vec<String>,
    dest: String,
    on_event: Channel<ExtractEvent>,
) -> AppResult<Vec<String>> {
    let dest = PathBuf::from(dest);
    if !dest.is_dir() {
        return Err(AppError::InvalidInput(format!(
            "{} is not a folder",
            dest.display()
        )));
    }
    let cancel = apps_state.job_flag(&job_id);
    let emit = |e: ExtractEvent| {
        let _ = on_event.send(e);
    };
    let mut written = Vec::new();
    for package in packages {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        match extract::extract(&state.server, &serial, &package, &dest, &cancel, &emit).await {
            Ok(path) => {
                let path = path.to_string_lossy().into_owned();
                emit(ExtractEvent::Done {
                    package,
                    path: path.clone(),
                });
                written.push(path);
            }
            Err(AppError::Cancelled) => break,
            Err(e) => emit(ExtractEvent::Failed {
                package,
                message: e.to_string(),
            }),
        }
    }
    apps_state.finish_job(&job_id);
    Ok(written)
}
