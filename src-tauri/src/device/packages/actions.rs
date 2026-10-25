//! One-shot package actions. Each returns `AppError::Device` with the
//! device's own message when the command reports a failure.

use serde::Deserialize;

use super::parse::pm_failure;
use super::{check_package, quote};
use crate::adb::server::AdbServer;
use crate::error::{AppError, AppResult};

async fn run(server: &AdbServer, serial: &str, command: &str) -> AppResult<String> {
    let out = server.exec_text(serial, &format!("{command} 2>&1")).await?;
    match pm_failure(&out) {
        Some(message) => Err(AppError::Device(message)),
        None => Ok(out),
    }
}

/// Starts the launcher activity, falling back to `monkey` when the
/// launcher cannot be resolved (old releases without `cmd package`).
pub async fn launch(server: &AdbServer, serial: &str, package: &str) -> AppResult<()> {
    let package = check_package(package)?;
    let resolved = server
        .exec_text(
            serial,
            &format!(
                "cmd package resolve-activity --brief -a android.intent.action.MAIN \
                 -c android.intent.category.LAUNCHER {package} 2>/dev/null"
            ),
        )
        .await
        .unwrap_or_default();
    if let Some(component) = resolved
        .lines()
        .rev()
        .map(str::trim)
        .find(|l| l.starts_with(&format!("{package}/")))
    {
        return start_activity(server, serial, component).await;
    }
    let out = server
        .exec_text(
            serial,
            &format!("monkey -p {package} -c android.intent.category.LAUNCHER 1 2>&1"),
        )
        .await?;
    if out.contains("No activities found") || out.contains("monkey aborted") {
        return Err(AppError::Device(format!(
            "{package} has no launcher activity"
        )));
    }
    Ok(())
}

/// `am start -n pkg/.Activity`.
pub async fn start_activity(server: &AdbServer, serial: &str, component: &str) -> AppResult<()> {
    let valid = component.split_once('/').is_some_and(|(p, c)| {
        check_package(p).is_ok()
            && !c.is_empty()
            && c.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._$".contains(&b))
    });
    if !valid {
        return Err(AppError::InvalidInput(format!(
            "not a component: {component:?}"
        )));
    }
    let out = server
        .exec_text(serial, &format!("am start -n {} 2>&1", quote(component)))
        .await?;
    if let Some(line) = out
        .lines()
        .map(str::trim)
        .find(|l| l.starts_with("Error") || l.contains("Exception"))
    {
        return Err(AppError::Device(line.to_owned()));
    }
    Ok(())
}

pub async fn force_stop(server: &AdbServer, serial: &str, package: &str) -> AppResult<()> {
    let package = check_package(package)?;
    run(server, serial, &format!("am force-stop {package}")).await?;
    Ok(())
}

pub async fn clear(
    server: &AdbServer,
    serial: &str,
    package: &str,
    cache_only: bool,
) -> AppResult<()> {
    let package = check_package(package)?;
    let flag = if cache_only { " --cache-only" } else { "" };
    let out = server
        .exec_text(serial, &format!("pm clear{flag} {package} 2>&1"))
        .await?;
    if out.trim() == "Success" || out.lines().any(|l| l.trim() == "Success") {
        return Ok(());
    }
    if cache_only && (out.contains("Unknown option") || out.contains("--cache-only")) {
        return Err(AppError::Device(
            "Clearing only the cache needs Android 14 or newer.".into(),
        ));
    }
    Err(AppError::Device(pm_failure(&out).unwrap_or_else(|| {
        format!("pm clear failed: {}", out.trim())
    })))
}

pub async fn set_enabled(
    server: &AdbServer,
    serial: &str,
    package: &str,
    enabled: bool,
) -> AppResult<()> {
    let package = check_package(package)?;
    let command = if enabled {
        format!("pm enable {package}")
    } else {
        format!("pm disable-user --user 0 {package}")
    };
    let out = run(server, serial, &command).await?;
    if out.contains("new state") {
        Ok(())
    } else {
        Err(AppError::Device(out.trim().to_owned()))
    }
}

/// Uninstalls an app. System apps can only be removed for user 0; they stay
/// on the system partition and come back with [`install_existing`].
pub async fn uninstall(
    server: &AdbServer,
    serial: &str,
    package: &str,
    keep_data: bool,
    system: bool,
) -> AppResult<()> {
    let package = check_package(package)?;
    let user = if system { " --user 0" } else { "" };
    let keep = if keep_data { " -k" } else { "" };
    let out = server
        .exec_text(serial, &format!("pm uninstall{user}{keep} {package} 2>&1"))
        .await?;
    if out.lines().any(|l| l.trim() == "Success") {
        Ok(())
    } else {
        Err(AppError::Device(
            pm_failure(&out).unwrap_or_else(|| out.trim().to_owned()),
        ))
    }
}

/// Reinstalls a package for user 0 from the copy already on the device.
pub async fn install_existing(server: &AdbServer, serial: &str, package: &str) -> AppResult<()> {
    let package = check_package(package)?;
    let out = run(
        server,
        serial,
        &format!("cmd package install-existing {package}"),
    )
    .await?;
    if out.contains("installed for user") {
        Ok(())
    } else {
        Err(AppError::Device(out.trim().to_owned()))
    }
}

fn check_permission(name: &str) -> AppResult<&str> {
    let ok = !name.is_empty()
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'.');
    if ok {
        Ok(name)
    } else {
        Err(AppError::InvalidInput(format!(
            "not a permission: {name:?}"
        )))
    }
}

pub async fn set_permission(
    server: &AdbServer,
    serial: &str,
    package: &str,
    permission: &str,
    granted: bool,
) -> AppResult<()> {
    let package = check_package(package)?;
    let permission = check_permission(permission)?;
    let verb = if granted { "grant" } else { "revoke" };
    run(server, serial, &format!("pm {verb} {package} {permission}")).await?;
    Ok(())
}

/// Revokes the given runtime permissions and clears the user-set/fixed
/// flags, which is what "reset to default" means for a regular app
/// (`pm reset-permissions` would reset every app on the device).
pub async fn reset_permissions(
    server: &AdbServer,
    serial: &str,
    package: &str,
    permissions: &[String],
) -> AppResult<()> {
    let package = check_package(package)?;
    let mut script = Vec::new();
    for p in permissions {
        let p = check_permission(p)?;
        script.push(format!("pm revoke {package} {p}"));
        script.push(format!(
            "pm clear-permission-flags {package} {p} user-set user-fixed"
        ));
    }
    if script.is_empty() {
        return Ok(());
    }
    // Some permissions are fixed by policy; report but keep going.
    let out = server
        .exec_text(serial, &format!("{} 2>&1; true", script.join(" 2>&1; ")))
        .await?;
    match pm_failure(&out) {
        Some(message) if !message.contains("SecurityException") => Err(AppError::Device(message)),
        _ => Ok(()),
    }
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OpMode {
    Allow,
    Ignore,
    Deny,
    Default,
    Foreground,
}

impl OpMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Allow => "allow",
            Self::Ignore => "ignore",
            Self::Deny => "deny",
            Self::Default => "default",
            Self::Foreground => "foreground",
        }
    }
}

pub async fn set_app_op(
    server: &AdbServer,
    serial: &str,
    package: &str,
    op: &str,
    mode: OpMode,
    uid_scope: bool,
) -> AppResult<()> {
    let package = check_package(package)?;
    if op.is_empty()
        || !op
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
    {
        return Err(AppError::InvalidInput(format!("not an app op: {op:?}")));
    }
    let scope = if uid_scope { " --uid" } else { "" };
    let out = server
        .exec_text(
            serial,
            &format!(
                "cmd appops set{scope} {package} {op} {} 2>&1",
                mode.as_str()
            ),
        )
        .await?;
    if out.trim().is_empty() {
        Ok(())
    } else {
        Err(AppError::Device(pm_failure(&out).unwrap_or_else(|| {
            out.lines().next().unwrap_or("").trim().to_owned()
        })))
    }
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StandbyBucket {
    Active,
    WorkingSet,
    Frequent,
    Rare,
    Restricted,
}

pub async fn set_standby_bucket(
    server: &AdbServer,
    serial: &str,
    package: &str,
    bucket: StandbyBucket,
) -> AppResult<()> {
    let package = check_package(package)?;
    let name = match bucket {
        StandbyBucket::Active => "active",
        StandbyBucket::WorkingSet => "working_set",
        StandbyBucket::Frequent => "frequent",
        StandbyBucket::Rare => "rare",
        StandbyBucket::Restricted => "restricted",
    };
    let out = server
        .exec_text(
            serial,
            &format!("am set-standby-bucket {package} {name} 2>&1"),
        )
        .await?;
    match pm_failure(&out) {
        Some(message) => Err(AppError::Device(message)),
        None => Ok(()),
    }
}

/// Adds or removes the app from the Doze / battery optimization allowlist.
pub async fn set_battery_unrestricted(
    server: &AdbServer,
    serial: &str,
    package: &str,
    unrestricted: bool,
) -> AppResult<()> {
    let package = check_package(package)?;
    let sign = if unrestricted { '+' } else { '-' };
    let out = server
        .exec_text(
            serial,
            &format!("dumpsys deviceidle whitelist {sign}{package} 2>&1"),
        )
        .await?;
    if out.contains("Unknown package") || out.contains("Exception") {
        Err(AppError::Device(out.trim().to_owned()))
    } else {
        Ok(())
    }
}
