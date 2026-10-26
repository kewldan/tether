//! The computer side of the two-pane file manager: local folder listings,
//! the usual places (home, Downloads, volumes) and the staging folders that
//! device files are pulled into before they are dragged out of the app.

use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::device::files::{EntryKind, FileEntry, permissions_string};
use crate::error::{AppError, AppResult};

#[cfg(not(unix))]
const S_IFDIR: u32 = 0o040000;
#[cfg(not(unix))]
const S_IFREG: u32 = 0o100000;
const S_IFLNK: u32 = 0o120000;

/// A local entry: the same shape as a device entry, so the UI can reuse its
/// table, plus the platform's own "hidden" flag.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalEntry {
    #[serde(flatten)]
    pub entry: FileEntry,
    /// Dotfiles, `UF_HIDDEN` on macOS (`~/Library`) and the hidden
    /// attribute on Windows.
    pub hidden: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Crumb {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalListing {
    pub path: String,
    /// `None` at a file system root.
    pub parent: Option<String>,
    /// From the root down to `path`.
    pub crumbs: Vec<Crumb>,
    pub entries: Vec<LocalEntry>,
    /// The folder exists but may not be read (permissions, macOS privacy).
    pub denied: bool,
}

/// Removes `.` and resolves `..` without touching the file system (so
/// symlinked folders keep the path the user came through).
pub fn clean(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                if out.parent().is_some() {
                    out.pop();
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    if out.as_os_str().is_empty() {
        out.push(Component::RootDir.as_os_str());
    }
    out
}

/// Turns what the user typed into an absolute path: `~` is the home
/// folder, relative input is taken from `base`.
pub fn resolve(base: &Path, input: &str, home: Option<&Path>) -> PathBuf {
    let input = input.trim();
    let path = match (input, home) {
        ("" | "~", Some(home)) => home.to_path_buf(),
        (s, Some(home)) if s.starts_with("~/") || s.starts_with("~\\") => home.join(&s[2..]),
        (s, _) if Path::new(s).is_absolute() => PathBuf::from(s),
        (s, _) => base.join(s),
    };
    clean(&path)
}

/// Root-first chain of folders for the breadcrumb.
pub fn crumbs(path: &Path) -> Vec<Crumb> {
    let mut out: Vec<Crumb> = path
        .ancestors()
        .map(|p| Crumb {
            name: p
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| p.to_string_lossy().into_owned()),
            path: p.to_string_lossy().into_owned(),
        })
        .collect();
    out.reverse();
    out
}

fn unix_seconds(time: std::io::Result<SystemTime>) -> i64 {
    time.ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(unix)]
fn mode_of(meta: &std::fs::Metadata) -> u32 {
    use std::os::unix::fs::MetadataExt;
    meta.mode()
}

#[cfg(not(unix))]
fn mode_of(meta: &std::fs::Metadata) -> u32 {
    let kind = if meta.is_symlink() {
        S_IFLNK
    } else if meta.is_dir() {
        S_IFDIR
    } else {
        S_IFREG
    };
    let perm = match (meta.is_dir(), meta.permissions().readonly()) {
        (true, _) => 0o755,
        (false, true) => 0o444,
        (false, false) => 0o644,
    };
    kind | perm
}

fn platform_hidden(meta: &std::fs::Metadata) -> bool {
    #[cfg(target_os = "macos")]
    {
        use std::os::macos::fs::MetadataExt;
        const UF_HIDDEN: u32 = 0x8000;
        meta.st_flags() & UF_HIDDEN != 0
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
        meta.file_attributes() & FILE_ATTRIBUTE_HIDDEN != 0
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = meta;
        false
    }
}

/// Describes one local path; `None` when it vanished meanwhile.
pub fn entry(path: &Path) -> Option<LocalEntry> {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned());
    let path_str = path.to_string_lossy().into_owned();
    let link = match std::fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == ErrorKind::NotFound => return None,
        Err(_) => {
            return Some(LocalEntry {
                hidden: name.starts_with('.'),
                entry: FileEntry {
                    name,
                    path: path_str,
                    kind: EntryKind::Other,
                    link_to_dir: false,
                    size: 0,
                    mtime: 0,
                    mode: 0,
                    permissions: "?".repeat(10),
                    owner: None,
                    group: None,
                    unreadable: true,
                },
            });
        }
    };
    let is_link = link.file_type().is_symlink();
    // Links report their target's size and kind, like Finder does.
    let target = if is_link {
        std::fs::metadata(path).ok()
    } else {
        None
    };
    let meta = target.as_ref().unwrap_or(&link);
    let kind = if is_link {
        EntryKind::Symlink
    } else if link.is_dir() {
        EntryKind::Dir
    } else if link.is_file() {
        EntryKind::File
    } else {
        EntryKind::Other
    };
    let mut mode = mode_of(&link);
    if is_link && mode & 0o170000 != S_IFLNK {
        mode = S_IFLNK | (mode & 0o7777);
    }
    Some(LocalEntry {
        hidden: name.starts_with('.') || platform_hidden(&link),
        entry: FileEntry {
            name,
            path: path_str,
            kind,
            link_to_dir: is_link && meta.is_dir(),
            size: if meta.is_dir() { 0 } else { meta.len() },
            mtime: unix_seconds(meta.modified()),
            permissions: permissions_string(mode),
            mode,
            owner: None,
            group: None,
            unreadable: false,
        },
    })
}

/// Lists a local folder (without `.` and `..`).
pub fn list(path: &Path) -> AppResult<LocalListing> {
    let path = clean(path);
    let meta = std::fs::metadata(&path).map_err(|e| match e.kind() {
        ErrorKind::NotFound => {
            AppError::InvalidInput(format!("{}: no such file or folder", path.display()))
        }
        _ => AppError::Io(e),
    })?;
    if !meta.is_dir() {
        return Err(AppError::InvalidInput(format!(
            "{} is not a folder",
            path.display()
        )));
    }
    let (entries, denied) = match std::fs::read_dir(&path) {
        Ok(dir) => (
            dir.flatten().filter_map(|e| entry(&e.path())).collect(),
            false,
        ),
        Err(e) if e.kind() == ErrorKind::PermissionDenied => (Vec::new(), true),
        Err(e) => return Err(AppError::Io(e)),
    };
    Ok(LocalListing {
        parent: path.parent().map(|p| p.to_string_lossy().into_owned()),
        crumbs: crumbs(&path),
        path: path.to_string_lossy().into_owned(),
        entries,
        denied,
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalPlace {
    /// `home`, `desktop`, … for the well-known folders (the UI translates
    /// them), `volume` for disks and mounts.
    pub key: String,
    pub label: String,
    pub path: String,
}

/// Disks and mounted volumes: `/` and `/Volumes/*` on macOS, drive letters
/// on Windows, `/` and the desktop mount folders on Linux.
pub fn volumes() -> Vec<LocalPlace> {
    let mut out = Vec::new();
    let place = |label: String, path: PathBuf| LocalPlace {
        key: "volume".into(),
        label,
        path: path.to_string_lossy().into_owned(),
    };
    #[cfg(windows)]
    {
        for letter in b'A'..=b'Z' {
            let root = PathBuf::from(format!("{}:\\", letter as char));
            if root.is_dir() {
                out.push(place(format!("{}:", letter as char), root));
            }
        }
    }
    #[cfg(not(windows))]
    {
        out.push(place("/".into(), PathBuf::from("/")));
        let mut mounts: Vec<PathBuf> = Vec::new();
        if cfg!(target_os = "macos") {
            mounts.push("/Volumes".into());
        } else if let Some(user) = std::env::var_os("USER") {
            mounts.push(Path::new("/media").join(&user));
            mounts.push(Path::new("/run/media").join(&user));
        }
        for dir in mounts {
            let Ok(read) = std::fs::read_dir(&dir) else {
                continue;
            };
            let mut found: Vec<PathBuf> = read
                .flatten()
                .map(|e| e.path())
                // `/Volumes/Macintosh HD` is a link back to `/`.
                .filter(|p| p.is_dir() && !p.is_symlink())
                .collect();
            found.sort();
            for path in found {
                let label = path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default();
                out.push(place(label, path));
            }
        }
    }
    out
}

// ------------------------------------------------------------- staging --

/// Staging folders older than this are removed when a new drag starts;
/// by then the drop target has long finished copying.
pub const STAGE_MAX_AGE: Duration = Duration::from_secs(60 * 60);

/// Root of the staging folders for drag-out.
pub fn stage_root() -> PathBuf {
    std::env::temp_dir().join("tether-drag")
}

/// Creates `root/<id>` for one drag (ids come from the frontend, so only
/// plain names are accepted) and sweeps stale siblings.
pub fn create_stage(root: &Path, id: &str, max_age: Duration) -> AppResult<PathBuf> {
    let valid = !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !valid {
        return Err(AppError::InvalidInput(format!("bad staging id {id:?}")));
    }
    sweep_stages(root, max_age);
    let dir = root.join(id);
    if dir.exists() {
        std::fs::remove_dir_all(&dir)?;
    }
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Deletes staging folders not touched for `max_age`.
pub fn sweep_stages(root: &Path, max_age: Duration) {
    let Ok(dir) = std::fs::read_dir(root) else {
        return;
    };
    let now = SystemTime::now();
    for entry in dir.flatten() {
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| now.duration_since(t).ok())
            .is_some_and(|age| age >= max_age);
        if old {
            let path = entry.path();
            let _ = if path.is_dir() {
                std::fs::remove_dir_all(&path)
            } else {
                std::fs::remove_file(&path)
            };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleans_paths_lexically() {
        assert_eq!(clean(Path::new("/a/./b/../c")), PathBuf::from("/a/c"));
        assert_eq!(clean(Path::new("/../..")), PathBuf::from("/"));
        assert_eq!(clean(Path::new("/a/b/")), PathBuf::from("/a/b"));
    }

    #[cfg(unix)]
    #[test]
    fn resolves_typed_paths() {
        let home = Path::new("/Users/me");
        let base = Path::new("/Users/me/Downloads");
        assert_eq!(resolve(base, "~", Some(home)), home);
        assert_eq!(resolve(base, "", Some(home)), home);
        assert_eq!(
            resolve(base, "~/Desktop", Some(home)),
            PathBuf::from("/Users/me/Desktop")
        );
        assert_eq!(
            resolve(base, "../Pictures", Some(home)),
            PathBuf::from("/Users/me/Pictures")
        );
        assert_eq!(resolve(base, " /tmp ", Some(home)), PathBuf::from("/tmp"));
        assert_eq!(
            resolve(base, "sub", None),
            PathBuf::from("/Users/me/Downloads/sub")
        );
    }

    #[cfg(unix)]
    #[test]
    fn builds_crumbs_from_root() {
        let names: Vec<_> = crumbs(Path::new("/Users/me/Downloads"))
            .into_iter()
            .map(|c| (c.name, c.path))
            .collect();
        assert_eq!(
            names,
            vec![
                ("/".to_owned(), "/".to_owned()),
                ("Users".to_owned(), "/Users".to_owned()),
                ("me".to_owned(), "/Users/me".to_owned()),
                ("Downloads".to_owned(), "/Users/me/Downloads".to_owned()),
            ]
        );
    }

    #[test]
    fn lists_files_folders_and_hidden() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("photo.jpg"), b"12345").unwrap();
        std::fs::write(dir.path().join(".env"), b"x").unwrap();
        std::fs::create_dir(dir.path().join("Camera")).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(dir.path().join("Camera"), dir.path().join("cam")).unwrap();

        let listing = list(dir.path()).unwrap();
        assert!(!listing.denied);
        assert_eq!(listing.crumbs.last().unwrap().path, listing.path);
        let find = |name: &str| {
            listing
                .entries
                .iter()
                .find(|e| e.entry.name == name)
                .unwrap_or_else(|| panic!("{name} missing"))
        };
        let photo = find("photo.jpg");
        assert_eq!(photo.entry.kind, EntryKind::File);
        assert_eq!(photo.entry.size, 5);
        assert!(photo.entry.mtime > 0);
        assert!(photo.entry.permissions.starts_with('-'));
        assert!(!photo.hidden);
        assert!(find(".env").hidden);
        let camera = find("Camera");
        assert_eq!(camera.entry.kind, EntryKind::Dir);
        assert!(camera.entry.is_dir_like());
        assert!(camera.entry.permissions.starts_with('d'));
        #[cfg(unix)]
        {
            let cam = find("cam");
            assert_eq!(cam.entry.kind, EntryKind::Symlink);
            assert!(cam.entry.link_to_dir);
            assert!(cam.entry.permissions.starts_with('l'));
        }
    }

    #[test]
    fn refuses_files_and_missing_paths() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.txt");
        std::fs::write(&file, b"a").unwrap();
        assert!(matches!(list(&file), Err(AppError::InvalidInput(_))));
        assert!(matches!(
            list(&dir.path().join("nope")),
            Err(AppError::InvalidInput(_))
        ));
    }

    #[test]
    fn serializes_like_a_device_entry() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), b"a").unwrap();
        let listing = list(dir.path()).unwrap();
        let json = serde_json::to_value(&listing.entries[0]).unwrap();
        for key in [
            "name",
            "path",
            "kind",
            "linkToDir",
            "size",
            "mtime",
            "hidden",
        ] {
            assert!(json.get(key).is_some(), "{key} missing in {json}");
        }
    }

    #[test]
    fn stages_and_sweeps() {
        let root = tempfile::tempdir().unwrap();
        let old = create_stage(root.path(), "drag-old", STAGE_MAX_AGE).unwrap();
        std::fs::write(old.join("f"), b"x").unwrap();
        // A zero max age sweeps everything that came before.
        let new = create_stage(root.path(), "drag-new", Duration::ZERO).unwrap();
        assert!(!old.exists());
        assert!(new.is_dir());
        assert!(create_stage(root.path(), "../escape", STAGE_MAX_AGE).is_err());
        assert!(create_stage(root.path(), "", STAGE_MAX_AGE).is_err());
    }

    #[test]
    fn lists_a_volume() {
        assert!(!volumes().is_empty());
    }
}
