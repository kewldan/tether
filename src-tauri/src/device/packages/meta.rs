//! App labels and launcher icons. Android has no shell command that
//! prints them, so we read `AndroidManifest.xml` and `resources.arsc` out
//! of the base APK with the device's `unzip -p` and resolve them ourselves.
//! Results are cached in memory and on disk, keyed by package, version and
//! update time, so each APK is read once.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use super::read_apk_entry;
use crate::adb::server::AdbServer;
use crate::device::apk::Value;
use crate::device::apk::arsc::ResourceTable;
use crate::device::apk::icon::{self, AppIcon, IconPlan, Layer};
use crate::device::apk::manifest::Manifest;
use crate::state::lock;

/// What the frontend knows about an app, enough to find and key it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetaRequest {
    pub package: String,
    pub apk_path: String,
    pub version_code: u64,
    pub last_update: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppMeta {
    pub package: String,
    pub label: Option<String>,
    pub icon: Option<AppIcon>,
}

/// Memory + disk cache of resolved metadata.
#[derive(Default)]
pub struct MetaCache {
    dir: Mutex<Option<PathBuf>>,
    memory: Mutex<HashMap<String, AppMeta>>,
}

impl MetaCache {
    pub fn set_dir(&self, dir: PathBuf) {
        *lock(&self.dir) = Some(dir);
    }

    fn key(req: &MetaRequest, locale: &str) -> String {
        let raw = format!(
            "{}@{}@{}@{}",
            req.package,
            req.version_code,
            req.last_update.unwrap_or(0),
            locale
        );
        raw.chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '.' || c == '@' {
                    c
                } else {
                    '_'
                }
            })
            .collect()
    }

    pub fn get(&self, req: &MetaRequest, locale: &str) -> Option<AppMeta> {
        let key = Self::key(req, locale);
        if let Some(hit) = lock(&self.memory).get(&key) {
            return Some(hit.clone());
        }
        let dir = lock(&self.dir).clone()?;
        let text = std::fs::read_to_string(dir.join(format!("{key}.json"))).ok()?;
        let meta: AppMeta = serde_json::from_str(&text).ok()?;
        lock(&self.memory).insert(key, meta.clone());
        Some(meta)
    }

    pub fn put(&self, req: &MetaRequest, locale: &str, meta: &AppMeta) {
        let key = Self::key(req, locale);
        lock(&self.memory).insert(key.clone(), meta.clone());
        let Some(dir) = lock(&self.dir).clone() else {
            return;
        };
        if std::fs::create_dir_all(&dir).is_ok()
            && let Ok(json) = serde_json::to_string(meta)
        {
            let _ = std::fs::write(dir.join(format!("{key}.json")), json);
        }
    }
}

/// Reads label and icon of one installed app from its base APK.
pub async fn load(server: &AdbServer, serial: &str, req: &MetaRequest, locale: &str) -> AppMeta {
    let mut meta = AppMeta {
        package: req.package.clone(),
        label: None,
        icon: None,
    };
    let apk = req.apk_path.as_str();
    let Ok(xml) = read_apk_entry(server, serial, apk, "AndroidManifest.xml").await else {
        return meta;
    };
    let Some(manifest) = Manifest::parse(&xml) else {
        return meta;
    };
    if let Some(Value::String(label)) = &manifest.label {
        meta.label = Some(label.clone());
    }
    let Ok(arsc) = read_apk_entry(server, serial, apk, "resources.arsc").await else {
        return meta;
    };
    let Some(table) = ResourceTable::parse(&arsc) else {
        return meta;
    };
    if meta.label.is_none()
        && let Some(Value::Reference(id)) = manifest.label
    {
        meta.label = table
            .resolve_string(id, locale)
            .filter(|l| !l.trim().is_empty());
    }

    let read = |entry: String| async move {
        read_apk_entry(server, serial, apk, &entry)
            .await
            .ok()
            .filter(|d| !d.is_empty())
    };
    for candidate in icon::plan(&table, &manifest) {
        match candidate {
            IconPlan::Bitmap(path) => {
                if let Some(data) = read(path.clone()).await {
                    meta.icon = Some(AppIcon::Bitmap {
                        src: icon::data_url(&path, &data),
                    });
                    break;
                }
            }
            IconPlan::Adaptive(path) => {
                let Some(xml) = read(path).await else {
                    continue;
                };
                let Some((bg, fg)) = icon::adaptive_layers(&table, &xml) else {
                    continue;
                };
                let render = |layer: Option<Layer>| async move {
                    match layer? {
                        Layer::Color(c) => Some(icon::css_color(c)),
                        Layer::Bitmap(p) => read(p.clone()).await.map(|d| icon::data_url(&p, &d)),
                    }
                };
                let foreground = render(fg).await;
                if foreground.is_none() {
                    continue;
                }
                meta.icon = Some(AppIcon::Adaptive {
                    background: render(bg).await,
                    foreground,
                });
                break;
            }
        }
    }
    meta
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_round_trips_through_disk() {
        let dir = tempfile::tempdir().unwrap();
        let req = MetaRequest {
            package: "com.example.shop".into(),
            apk_path: "/data/app/x/base.apk".into(),
            version_code: 2140,
            last_update: Some(1_791_316_863_000),
        };
        let meta = AppMeta {
            package: req.package.clone(),
            label: Some("Example Shop".into()),
            icon: Some(AppIcon::Adaptive {
                background: Some("#e8603cff".into()),
                foreground: Some("data:image/png;base64,AAAA".into()),
            }),
        };
        let cache = MetaCache::default();
        cache.set_dir(dir.path().to_owned());
        cache.put(&req, "en-US", &meta);

        let fresh = MetaCache::default();
        fresh.set_dir(dir.path().to_owned());
        assert_eq!(fresh.get(&req, "en-US"), Some(meta));
        assert_eq!(fresh.get(&req, "ru"), None);
        assert!(MetaCache::key(&req, "en-US").starts_with("com.example.shop@2140@"));
    }
}
