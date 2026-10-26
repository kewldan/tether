//! The newest stable platform-tools release, read from Google's SDK
//! repository manifest (the one Android Studio's SDK Manager uses).
//!
//! The manifest is ~400 KB, so the answer is cached in the app data folder
//! and refreshed at most once a day. Every failure (offline, proxy, a
//! changed format) is silent: the caller just gets the cached value or
//! nothing.

use std::fmt;
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

pub const MANIFEST_URL: &str = "https://dl.google.com/android/repository/repository2-3.xml";
const CACHE_FILE: &str = "platform-tools-latest.json";
const CHECK_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
const FETCH_TIMEOUT: Duration = Duration::from_secs(15);
/// `<channel id="channel-0">stable</channel>` in the manifest.
const STABLE_CHANNEL: &str = "channel-0";

/// A platform-tools revision such as `37.0.1`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Revision {
    pub major: u32,
    pub minor: u32,
    pub micro: u32,
}

impl Revision {
    /// Parses `37.0.1`, `37.0.1-15733141` (from `adb version`) or `37`.
    pub fn parse(version: &str) -> Option<Self> {
        let core = version.trim().split(['-', ' ']).next()?;
        let mut parts = core.split('.');
        let major = parts.next()?.parse().ok()?;
        let minor = parts.next().map_or(Ok(0), str::parse).ok()?;
        let micro = parts.next().map_or(Ok(0), str::parse).ok()?;
        Some(Self {
            major,
            minor,
            micro,
        })
    }
}

impl fmt::Display for Revision {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.micro)
    }
}

/// Text between `<tag>` and `</tag>`, trimmed.
fn element<'a>(xml: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = xml.find(&open)? + open.len();
    let end = start + xml[start..].find(&close)?;
    Some(xml[start..end].trim())
}

/// Highest stable `platform-tools` revision listed in the manifest.
///
/// A deliberately small scanner instead of an XML parser: the manifest is
/// machine-written and we need four tags from one element.
pub fn parse_manifest(xml: &str) -> Option<Revision> {
    let mut best = None;
    let mut rest = xml;
    while let Some(at) = rest.find("<remotePackage ") {
        rest = &rest[at..];
        let head_end = rest.find('>')?;
        let head = &rest[..head_end];
        let body_end = rest.find("</remotePackage>").unwrap_or(rest.len());
        let body = &rest[head_end..body_end];
        rest = &rest[body_end..];

        if !head.contains(r#"path="platform-tools""#) {
            continue;
        }
        let stable = match body.find("<channelRef ref=\"") {
            Some(i) => body[i + 17..].starts_with(&format!("{STABLE_CHANNEL}\"")),
            None => true,
        };
        if !stable || body.contains("<preview>") {
            continue;
        }
        let Some(revision) = element(body, "revision") else {
            continue;
        };
        let part = |tag| element(revision, tag).map_or(Some(0), |v| v.parse().ok());
        let (Some(major), Some(minor), Some(micro)) = (
            element(revision, "major").and_then(|v| v.parse().ok()),
            part("minor"),
            part("micro"),
        ) else {
            continue;
        };
        let found = Revision {
            major,
            minor,
            micro,
        };
        best = best.max(Some(found));
    }
    best
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Cache {
    /// Unix seconds of the last successful check.
    checked_at: u64,
    version: String,
}

fn unix_secs(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn read_cache(path: &Path) -> Option<(u64, Revision)> {
    let text = std::fs::read_to_string(path).ok()?;
    let cache: Cache = serde_json::from_str(&text).ok()?;
    Some((cache.checked_at, Revision::parse(&cache.version)?))
}

fn write_cache(path: &Path, now: SystemTime, revision: Revision) {
    let cache = Cache {
        checked_at: unix_secs(now),
        version: revision.to_string(),
    };
    if let Ok(text) = serde_json::to_string(&cache) {
        let _ = std::fs::create_dir_all(path.parent().unwrap_or(Path::new(".")));
        let _ = std::fs::write(path, text);
    }
}

/// Whether a cache written at `checked_at` is still good at `now`.
fn is_fresh(checked_at: u64, now: SystemTime) -> bool {
    unix_secs(now).saturating_sub(checked_at) < CHECK_INTERVAL.as_secs()
}

async fn fetch_manifest() -> Option<String> {
    let client = reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .build()
        .ok()?;
    let response = client
        .get(MANIFEST_URL)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .ok()?;
    response.text().await.ok()
}

/// Latest stable platform-tools, from the daily cache in `app_data` or the
/// network. `force` skips the cache age check. Never fails: offline it
/// returns the last known value, if any.
pub async fn latest(app_data: &Path, force: bool) -> Option<Revision> {
    let path = app_data.join(CACHE_FILE);
    let now = SystemTime::now();
    let cached = read_cache(&path);
    if let Some((checked_at, revision)) = cached
        && !force
        && is_fresh(checked_at, now)
    {
        return Some(revision);
    }
    match fetch_manifest().await.as_deref().and_then(parse_manifest) {
        Some(revision) => {
            write_cache(&path, now, revision);
            Some(revision)
        }
        None => cached.map(|(_, r)| r),
    }
}

/// True when `installed` (as `adb version` prints it) is older than
/// `latest`. Unknown versions never count as outdated.
pub fn is_outdated(installed: Option<&str>, latest: Revision) -> bool {
    installed
        .and_then(Revision::parse)
        .is_some_and(|current| current < latest)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("../../tests/fixtures/sdk/repository2-3-trimmed.xml");

    fn rev(major: u32, minor: u32, micro: u32) -> Revision {
        Revision {
            major,
            minor,
            micro,
        }
    }

    #[test]
    fn parses_versions() {
        assert_eq!(Revision::parse("37.0.1-15733141"), Some(rev(37, 0, 1)));
        assert_eq!(Revision::parse("36.0.0"), Some(rev(36, 0, 0)));
        assert_eq!(Revision::parse("35"), Some(rev(35, 0, 0)));
        assert_eq!(Revision::parse("garbage"), None);
        assert_eq!(rev(37, 0, 1).to_string(), "37.0.1");
        assert!(rev(36, 9, 9) < rev(37, 0, 0));
        assert!(rev(37, 0, 1) < rev(37, 0, 10));
    }

    #[test]
    fn finds_stable_platform_tools_in_manifest() {
        // The fixture also holds a preview platform-tools on the canary
        // channel and other packages with higher revisions.
        assert_eq!(parse_manifest(FIXTURE), Some(rev(37, 0, 1)));
    }

    #[test]
    fn handles_missing_or_broken_manifest() {
        assert_eq!(parse_manifest(""), None);
        assert_eq!(parse_manifest("<html>captive portal</html>"), None);
        let broken = r#"<remotePackage path="platform-tools"><revision><major>x</major></revision></remotePackage>"#;
        assert_eq!(parse_manifest(broken), None);
        let no_minor = r#"<remotePackage path="platform-tools"><revision><major>38</major></revision></remotePackage>"#;
        assert_eq!(parse_manifest(no_minor), Some(rev(38, 0, 0)));
    }

    #[test]
    fn compares_installed_version() {
        let latest = rev(37, 0, 1);
        assert!(is_outdated(Some("36.0.0-13206524"), latest));
        assert!(!is_outdated(Some("37.0.1-15733141"), latest));
        assert!(!is_outdated(Some("38.0.0"), latest));
        assert!(!is_outdated(None, latest));
        assert!(!is_outdated(Some("weird"), latest));
    }

    #[test]
    fn cache_round_trip_and_age() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sub").join(CACHE_FILE);
        let now = SystemTime::now();
        write_cache(&path, now, rev(37, 0, 1));
        let (checked_at, revision) = read_cache(&path).unwrap();
        assert_eq!(revision, rev(37, 0, 1));
        assert!(is_fresh(checked_at, now));
        assert!(!is_fresh(checked_at, now + CHECK_INTERVAL));
        std::fs::write(&path, "not json").unwrap();
        assert!(read_cache(&path).is_none());
    }

    #[tokio::test]
    async fn fresh_cache_skips_the_network() {
        let dir = tempfile::tempdir().unwrap();
        write_cache(
            &dir.path().join(CACHE_FILE),
            SystemTime::now(),
            rev(36, 0, 0),
        );
        assert_eq!(latest(dir.path(), false).await, Some(rev(36, 0, 0)));
    }
}
