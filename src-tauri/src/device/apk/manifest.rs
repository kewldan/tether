//! `AndroidManifest.xml` facts: identity, SDK levels, label/icon resource
//! ids and declared components.

use serde::Serialize;

use super::Value;
use super::axml::{self, Element};

/// Framework attribute ids (`android.R.attr`).
mod attr {
    pub const LABEL: u32 = 0x0101_0001;
    pub const ICON: u32 = 0x0101_0002;
    pub const NAME: u32 = 0x0101_0003;
    pub const PERMISSION: u32 = 0x0101_0006;
    pub const ENABLED: u32 = 0x0101_000e;
    pub const DEBUGGABLE: u32 = 0x0101_000f;
    pub const EXPORTED: u32 = 0x0101_0010;
    pub const MIN_SDK: u32 = 0x0101_020c;
    pub const VERSION_CODE: u32 = 0x0101_021b;
    pub const VERSION_NAME: u32 = 0x0101_021c;
    pub const TARGET_ACTIVITY: u32 = 0x0101_0202;
    pub const TARGET_SDK: u32 = 0x0101_0270;
    pub const TEST_ONLY: u32 = 0x0101_0272;
    pub const ROUND_ICON: u32 = 0x0101_052c;
    pub const VERSION_CODE_MAJOR: u32 = 0x0101_0576;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ComponentKind {
    Activity,
    Alias,
    Service,
    Receiver,
    Provider,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Component {
    pub kind: ComponentKind,
    /// Fully qualified class name.
    pub name: String,
    pub exported: bool,
    pub enabled: bool,
    pub permission: Option<String>,
    pub actions: Vec<String>,
    pub categories: Vec<String>,
    /// `targetActivity` of an `<activity-alias>`.
    pub target: Option<String>,
}

impl Component {
    pub fn is_launcher(&self) -> bool {
        matches!(self.kind, ComponentKind::Activity | ComponentKind::Alias)
            && self
                .actions
                .iter()
                .any(|a| a == "android.intent.action.MAIN")
            && self
                .categories
                .iter()
                .any(|c| c == "android.intent.category.LAUNCHER")
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Manifest {
    pub package: String,
    /// `versionCodeMajor << 32 | versionCode`.
    pub version_code: u64,
    pub version_name: Option<String>,
    pub min_sdk: Option<u32>,
    pub target_sdk: Option<u32>,
    /// Name of a split APK (`config.arm64_v8a`); `None` for the base APK.
    pub split: Option<String>,
    pub label: Option<Value>,
    pub icon: Option<u32>,
    pub round_icon: Option<u32>,
    pub debuggable: bool,
    pub test_only: bool,
    pub permissions: Vec<String>,
    pub components: Vec<Component>,
}

impl Manifest {
    pub fn parse(data: &[u8]) -> Option<Self> {
        let root = axml::parse(data)?;
        if root.name != "manifest" {
            return None;
        }
        let package = root.plain_attr("package")?.as_str()?.to_owned();
        let code = root
            .attr(attr::VERSION_CODE, "versionCode")
            .and_then(Value::as_int)
            .unwrap_or(0);
        let major = root
            .attr(attr::VERSION_CODE_MAJOR, "versionCodeMajor")
            .and_then(Value::as_int)
            .unwrap_or(0);
        let sdk = root.child("uses-sdk");
        let sdk_attr = |id, name| sdk.and_then(|s| s.attr(id, name)).and_then(Value::as_int);
        let app = root.child("application");
        let app_attr = |id, name| app.and_then(|a| a.attr(id, name));
        let reference = |v: Option<&Value>| match v {
            Some(Value::Reference(id)) if *id != 0 => Some(*id),
            _ => None,
        };

        let permissions = ["uses-permission", "uses-permission-sdk-23"]
            .iter()
            .flat_map(|tag| root.children_named(tag))
            .filter_map(|p| p.attr(attr::NAME, "name")?.as_str().map(str::to_owned))
            .collect();

        let components = app.map(|a| components(a, &package)).unwrap_or_default();

        Some(Self {
            version_code: (u64::from(major) << 32) | u64::from(code),
            version_name: root
                .attr(attr::VERSION_NAME, "versionName")
                .and_then(Value::as_str)
                .map(str::to_owned),
            min_sdk: sdk_attr(attr::MIN_SDK, "minSdkVersion"),
            target_sdk: sdk_attr(attr::TARGET_SDK, "targetSdkVersion"),
            split: root
                .plain_attr("split")
                .and_then(Value::as_str)
                .map(str::to_owned),
            label: app_attr(attr::LABEL, "label").cloned(),
            icon: reference(app_attr(attr::ICON, "icon")),
            round_icon: reference(app_attr(attr::ROUND_ICON, "roundIcon")),
            debuggable: app_attr(attr::DEBUGGABLE, "debuggable")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            test_only: app_attr(attr::TEST_ONLY, "testOnly")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            permissions,
            components,
            package,
        })
    }
}

fn components(app: &Element, package: &str) -> Vec<Component> {
    let mut out = Vec::new();
    for child in &app.children {
        let kind = match child.name.as_str() {
            "activity" => ComponentKind::Activity,
            "activity-alias" => ComponentKind::Alias,
            "service" => ComponentKind::Service,
            "receiver" => ComponentKind::Receiver,
            "provider" => ComponentKind::Provider,
            _ => continue,
        };
        let Some(name) = child.attr(attr::NAME, "name").and_then(Value::as_str) else {
            continue;
        };
        let mut actions = Vec::new();
        let mut categories = Vec::new();
        for filter in child.children_named("intent-filter") {
            for item in &filter.children {
                let Some(value) = item.attr(attr::NAME, "name").and_then(Value::as_str) else {
                    continue;
                };
                let list = match item.name.as_str() {
                    "action" => &mut actions,
                    "category" => &mut categories,
                    _ => continue,
                };
                if !list.iter().any(|v| v == value) {
                    list.push(value.to_owned());
                }
            }
        }
        let has_filter = child.child("intent-filter").is_some();
        out.push(Component {
            kind,
            name: qualify(package, name),
            // Before Android 12 the default was "exported if it has filters".
            exported: child
                .attr(attr::EXPORTED, "exported")
                .and_then(Value::as_bool)
                .unwrap_or(has_filter),
            enabled: child
                .attr(attr::ENABLED, "enabled")
                .and_then(Value::as_bool)
                .unwrap_or(true),
            permission: child
                .attr(attr::PERMISSION, "permission")
                .and_then(Value::as_str)
                .map(str::to_owned),
            target: child
                .attr(attr::TARGET_ACTIVITY, "targetActivity")
                .and_then(Value::as_str)
                .map(|t| qualify(package, t)),
            actions,
            categories,
        });
    }
    out
}

/// `.Main` → `pkg.Main`, `Main` → `pkg.Main`, full names stay as they are.
pub fn qualify(package: &str, name: &str) -> String {
    if let Some(rest) = name.strip_prefix('.') {
        format!("{package}.{rest}")
    } else if !name.contains('.') {
        format!("{package}.{name}")
    } else {
        name.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::super::fixtures;
    use super::*;

    #[test]
    fn reads_fixture_manifest() {
        let xml = fixtures::zip_entry(fixtures::PLAIN_APK, "AndroidManifest.xml");
        let m = Manifest::parse(&xml).unwrap();
        assert_eq!(m.package, "dev.tether.fixture");
        assert_eq!(m.version_code, 2150);
        assert_eq!(m.version_name.as_deref(), Some("2.15.0"));
        assert_eq!((m.min_sdk, m.target_sdk), (Some(26), Some(35)));
        assert!(m.debuggable && m.test_only);
        assert_eq!(m.split, None);
        assert!(m.icon.is_some() && m.round_icon.is_some());
        assert_eq!(
            m.permissions,
            ["android.permission.CAMERA", "android.permission.INTERNET"]
        );

        let names: Vec<_> = m
            .components
            .iter()
            .map(|c| (c.kind, c.name.as_str()))
            .collect();
        assert_eq!(
            names,
            [
                (ComponentKind::Activity, "dev.tether.fixture.MainActivity"),
                (
                    ComponentKind::Activity,
                    "dev.tether.fixture.checkout.CheckoutActivity"
                ),
                (ComponentKind::Alias, "dev.tether.fixture.Alias"),
                (ComponentKind::Service, "dev.tether.fixture.SyncService"),
                (ComponentKind::Receiver, "dev.tether.fixture.BootReceiver"),
                (ComponentKind::Provider, "dev.tether.fixture.Files"),
            ]
        );
        let main = &m.components[0];
        assert!(main.is_launcher() && main.exported);
        assert!(!m.components[1].exported);
        assert_eq!(
            m.components[2].target.as_deref(),
            Some("dev.tether.fixture.MainActivity")
        );
        assert!(!m.components[3].enabled);
        assert_eq!(
            m.components[4].permission.as_deref(),
            Some("android.permission.RECEIVE_BOOT_COMPLETED")
        );
        assert_eq!(
            m.components[4].actions,
            ["android.intent.action.BOOT_COMPLETED"]
        );
    }

    #[test]
    fn reads_real_camera2_manifest() {
        let m = Manifest::parse(fixtures::CAMERA2_MANIFEST).unwrap();
        assert_eq!(m.package, "com.android.camera2");
        assert_eq!(m.version_code, 20_002_000);
        assert!(
            m.permissions
                .iter()
                .any(|p| p == "android.permission.CAMERA")
        );
        assert!(m.components.iter().any(Component::is_launcher));
        assert!(matches!(m.label, Some(Value::Reference(_))));
        assert!(m.icon.is_some());
    }

    #[test]
    fn qualifies_class_names() {
        assert_eq!(qualify("a.b", ".Main"), "a.b.Main");
        assert_eq!(qualify("a.b", "Main"), "a.b.Main");
        assert_eq!(qualify("a.b", "x.y.Main"), "x.y.Main");
    }
}
