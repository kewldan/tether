//! File manager operations: directory listings over the sync protocol and
//! file operations (`mkdir`, `mv`, `rm`, `chmod`) through `exec:`.

use serde::Serialize;

use crate::adb::server::AdbServer;
use crate::adb::sync::{RemoteDirEntry, RemoteStat, S_IFDIR, S_IFLNK, S_IFMT, S_IFREG, SyncConn};
use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EntryKind {
    File,
    Dir,
    Symlink,
    Other,
}

impl EntryKind {
    fn from_mode(mode: u32) -> Self {
        match mode & S_IFMT {
            S_IFREG => Self::File,
            S_IFDIR => Self::Dir,
            S_IFLNK => Self::Symlink,
            _ => Self::Other,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub kind: EntryKind,
    /// For symlinks: whether the target is a directory (navigable).
    pub link_to_dir: bool,
    pub size: u64,
    /// Seconds since the Unix epoch.
    pub mtime: i64,
    pub mode: u32,
    /// `ls -l` style, e.g. `drwxrwx--x`.
    pub permissions: String,
    pub owner: Option<String>,
    pub group: Option<String>,
    /// Set when the device could not `lstat` the entry.
    pub unreadable: bool,
}

impl FileEntry {
    fn new(dir: &str, name: String, stat: RemoteStat, unreadable: bool) -> Self {
        Self {
            path: join(dir, &name),
            name,
            kind: EntryKind::from_mode(stat.mode),
            link_to_dir: false,
            size: stat.size,
            mtime: stat.mtime,
            mode: stat.mode,
            permissions: if unreadable {
                "?".repeat(10)
            } else {
                permissions_string(stat.mode)
            },
            owner: stat.uid.map(android_id_name),
            group: stat.gid.map(android_id_name),
            unreadable,
        }
    }

    pub fn is_dir_like(&self) -> bool {
        self.kind == EntryKind::Dir || (self.kind == EntryKind::Symlink && self.link_to_dir)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirListing {
    /// Normalized path that was listed.
    pub path: String,
    pub entries: Vec<FileEntry>,
    /// The folder exists but the shell user may not read it.
    pub denied: bool,
}

/// Lists `path` (without `.` and `..`), resolving whether symlinks point to
/// directories so the UI can navigate into `/sdcard` and friends.
pub async fn list_dir(server: &AdbServer, serial: &str, path: &str) -> AppResult<DirListing> {
    let path = normalize(path);
    let mut conn = SyncConn::open(server, serial).await?;
    let mut listing = list_with(&mut conn, &path).await;
    conn.quit().await.ok();
    if let Ok(l) = &mut listing
        && l.denied
    {
        // An empty answer is either an empty folder (FUSE storage reports
        // no `.`/`..`) or one we may not open; `ls` tells them apart.
        let probe = format!("ls -a -- {} > /dev/null", shell_quote(&path));
        l.denied = run_checked(server, serial, &probe).await.is_err();
    }
    listing
}

pub async fn list_with<S>(conn: &mut SyncConn<S>, path: &str) -> AppResult<DirListing>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    match conn.stat(&dir_probe(path)).await? {
        None => {
            return Err(match conn.lstat(path).await? {
                Some(_) => AppError::InvalidInput(format!("{path} is not a folder")),
                None => AppError::Device(format!("{path}: no such file or folder")),
            });
        }
        Some(st) if !st.is_dir() => {
            return Err(AppError::InvalidInput(format!("{path} is not a folder")));
        }
        Some(_) => {}
    }

    let raw = conn.list(path).await?;
    // A folder that cannot be opened lists as nothing at all, not even `.`
    // (but FUSE-backed storage never reports `.`, so empty folders look the
    // same; [`list_dir`] double-checks).
    let denied = raw.is_empty();
    let mut entries = entries_from(path, raw);
    for entry in entries.iter_mut().filter(|e| e.kind == EntryKind::Symlink) {
        // A trailing slash makes even v1 `lstat` resolve links to folders.
        entry.link_to_dir = matches!(
            conn.stat(&dir_probe(&entry.path)).await,
            Ok(Some(st)) if st.is_dir()
        );
    }
    Ok(DirListing {
        path: path.to_owned(),
        entries,
        denied,
    })
}

fn entries_from(dir: &str, raw: Vec<RemoteDirEntry>) -> Vec<FileEntry> {
    raw.into_iter()
        .filter(|e| e.name != "." && e.name != "..")
        .map(|e| FileEntry::new(dir, e.name, e.stat, e.error.is_some()))
        .collect()
}

/// `path` with a trailing `/`, so `stat` resolves a symlink to a folder.
fn dir_probe(path: &str) -> String {
    if path.ends_with('/') {
        path.to_owned()
    } else {
        format!("{path}/")
    }
}

/// Lexically normalizes a device path: absolute, no `.`/`..`/empty
/// segments, no trailing slash (except the root).
pub fn normalize(path: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    format!("/{}", parts.join("/"))
}

pub fn join(dir: &str, name: &str) -> String {
    if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

/// Last path component (`/` for the root).
pub fn basename(path: &str) -> &str {
    let trimmed = path.trim_end_matches('/');
    match trimmed.rsplit_once('/') {
        Some((_, name)) if !name.is_empty() => name,
        _ if trimmed.is_empty() => "/",
        _ => trimmed,
    }
}

/// `ls -l` permission string for an `st_mode`.
pub fn permissions_string(mode: u32) -> String {
    let kind = match mode & S_IFMT {
        S_IFDIR => 'd',
        S_IFLNK => 'l',
        S_IFREG => '-',
        0o020000 => 'c',
        0o060000 => 'b',
        0o010000 => 'p',
        0o140000 => 's',
        _ => '?',
    };
    let bit = |mask: u32, c: char| if mode & mask != 0 { c } else { '-' };
    let special = |exec: bool, set: bool, on: char, off: char| match (exec, set) {
        (true, true) => on,
        (false, true) => off,
        (true, false) => 'x',
        (false, false) => '-',
    };
    let mut s = String::with_capacity(10);
    s.push(kind);
    s.push(bit(0o400, 'r'));
    s.push(bit(0o200, 'w'));
    s.push(special(mode & 0o100 != 0, mode & 0o4000 != 0, 's', 'S'));
    s.push(bit(0o040, 'r'));
    s.push(bit(0o020, 'w'));
    s.push(special(mode & 0o010 != 0, mode & 0o2000 != 0, 's', 'S'));
    s.push(bit(0o004, 'r'));
    s.push(bit(0o002, 'w'));
    s.push(special(mode & 0o001 != 0, mode & 0o1000 != 0, 't', 'T'));
    s
}

/// Name of an Android user/group id (`system/core/libcutils/include/
/// private/android_filesystem_config.h`, `bionic` `getpwuid`): fixed AIDs
/// by table, app ids as `u0_a212`, isolated processes as `u0_i3`.
pub fn android_id_name(id: u32) -> String {
    const AIDS: &[(u32, &str)] = &[
        (0, "root"),
        (1000, "system"),
        (1001, "radio"),
        (1002, "bluetooth"),
        (1003, "graphics"),
        (1004, "input"),
        (1005, "audio"),
        (1006, "camera"),
        (1007, "log"),
        (1008, "compass"),
        (1009, "mount"),
        (1010, "wifi"),
        (1011, "adb"),
        (1012, "install"),
        (1013, "media"),
        (1014, "dhcp"),
        (1015, "sdcard_rw"),
        (1016, "vpn"),
        (1017, "keystore"),
        (1018, "usb"),
        (1019, "drm"),
        (1020, "mdnsr"),
        (1021, "gps"),
        (1023, "media_rw"),
        (1024, "mtp"),
        (1026, "drmrpc"),
        (1027, "nfc"),
        (1028, "sdcard_r"),
        (1029, "clat"),
        (1036, "logd"),
        (1037, "shared_relro"),
        (1041, "audioserver"),
        (1047, "cameraserver"),
        (1057, "everybody_rw"),
        (1065, "reserved_disk"),
        (1077, "external_storage"),
        (1078, "ext_data_rw"),
        (1079, "ext_obb_rw"),
        (2000, "shell"),
        (2001, "cache"),
        (2002, "diag"),
        (3001, "net_bt_admin"),
        (3002, "net_bt"),
        (3003, "inet"),
        (3004, "net_raw"),
        (3005, "net_admin"),
        (3006, "net_bw_stats"),
        (3009, "readproc"),
        (9997, "everybody"),
        (9998, "misc"),
        (9999, "nobody"),
    ];
    const PER_USER: u32 = 100_000;

    let user = id / PER_USER;
    let app = id % PER_USER;
    match app {
        10_000..=19_999 => format!("u{user}_a{}", app - 10_000),
        20_000..=29_999 => format!("u{user}_a{}_cache", app - 20_000),
        50_000..=59_999 => format!("all_a{}", app - 50_000),
        90_000..=99_999 => format!("u{user}_i{}", app - 90_000),
        _ => match AIDS.iter().find(|(aid, _)| *aid == app) {
            Some((_, name)) if user == 0 => (*name).to_owned(),
            Some((_, name)) => format!("u{user}_{name}"),
            None => id.to_string(),
        },
    }
}

/// Quotes one argument for the device's `/system/bin/sh`.
pub fn shell_quote(arg: &str) -> String {
    let safe = !arg.is_empty()
        && arg
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"/._-+=:,@%".contains(&b));
    if safe {
        arg.to_owned()
    } else {
        format!("'{}'", arg.replace('\'', r"'\''"))
    }
}

fn quote_all<S: AsRef<str>>(args: &[S]) -> String {
    args.iter()
        .map(|a| shell_quote(a.as_ref()))
        .collect::<Vec<_>>()
        .join(" ")
}

const EXIT_MARKER: &str = "__tether_exit=";

/// Runs a shell command via `exec:` and fails with its combined output if
/// the exit status is non-zero. `exec:` reports no status itself, so the
/// command prints it after a marker.
pub async fn run_checked(server: &AdbServer, serial: &str, command: &str) -> AppResult<String> {
    let wrapped = format!("({command}) 2>&1; echo \"{EXIT_MARKER}$?\"");
    let output = server.exec_text(serial, &wrapped).await?;
    parse_checked(&output)
}

fn parse_checked(output: &str) -> AppResult<String> {
    let (body, status) = output
        .trim_end()
        .rsplit_once(EXIT_MARKER)
        .ok_or_else(|| AppError::Protocol("command produced no exit status".into()))?;
    let body = body.trim_end().to_owned();
    match status.trim().parse::<i32>() {
        Ok(0) => Ok(body),
        Ok(_) => Err(AppError::Device(clean_error(&body))),
        Err(_) => Err(AppError::Protocol(format!("bad exit status {status:?}"))),
    }
}

/// Toybox prefixes messages with the applet name (`mkdir: /x: …`).
fn clean_error(output: &str) -> String {
    let line = output.lines().find(|l| !l.trim().is_empty()).unwrap_or("");
    let line = line.trim();
    if line.is_empty() {
        return "command failed".into();
    }
    line.to_owned()
}

fn check_target(path: &str) -> AppResult<String> {
    let normalized = normalize(path);
    if normalized == "/" {
        return Err(AppError::InvalidInput("refusing to modify /".into()));
    }
    Ok(normalized)
}

pub async fn mkdir(server: &AdbServer, serial: &str, path: &str) -> AppResult<()> {
    let path = check_target(path)?;
    let q = shell_quote(&path);
    let cmd = format!("if [ -e {q} ]; then echo {q}: already exists; exit 17; fi; mkdir -p -- {q}");
    run_checked(server, serial, &cmd).await.map(drop)
}

/// Renames or moves `from` to `to`; never overwrites an existing entry.
pub async fn rename(server: &AdbServer, serial: &str, from: &str, to: &str) -> AppResult<()> {
    let from = check_target(from)?;
    let to = check_target(to)?;
    if from == to {
        return Ok(());
    }
    let (f, t) = (shell_quote(&from), shell_quote(&to));
    let cmd = format!(
        "if [ -e {t} ] || [ -L {t} ]; then echo {t}: already exists; exit 17; fi; mv -- {f} {t}"
    );
    run_checked(server, serial, &cmd).await.map(drop)
}

/// Deletes files and folders recursively.
pub async fn delete(server: &AdbServer, serial: &str, paths: &[String]) -> AppResult<()> {
    let targets = paths
        .iter()
        .map(|p| check_target(p))
        .collect::<AppResult<Vec<_>>>()?;
    if targets.is_empty() {
        return Ok(());
    }
    for chunk in targets.chunks(64) {
        run_checked(server, serial, &format!("rm -rf -- {}", quote_all(chunk))).await?;
    }
    Ok(())
}

/// Accepts octal (`644`, `0755`, `4755`) or symbolic (`u+x,g-w`) modes.
pub fn validate_mode(mode: &str) -> AppResult<()> {
    let octal = (1..=4).contains(&mode.len()) && mode.bytes().all(|b| (b'0'..=b'7').contains(&b));
    let symbolic = !mode.is_empty()
        && mode.split(',').all(|clause| {
            let ops = clause.trim_start_matches(['u', 'g', 'o', 'a']);
            !ops.is_empty()
                && ops.starts_with(['+', '-', '='])
                && ops.bytes().all(|b| b"+-=rwxXstugo".contains(&b))
        });
    if octal || symbolic {
        Ok(())
    } else {
        Err(AppError::InvalidInput(format!("invalid mode {mode:?}")))
    }
}

pub async fn chmod(
    server: &AdbServer,
    serial: &str,
    paths: &[String],
    mode: &str,
    recursive: bool,
) -> AppResult<()> {
    validate_mode(mode)?;
    let targets = paths
        .iter()
        .map(|p| check_target(p))
        .collect::<AppResult<Vec<_>>>()?;
    let flag = if recursive { "-R " } else { "" };
    for chunk in targets.chunks(64) {
        let cmd = format!("chmod {flag}{mode} -- {}", quote_all(chunk));
        run_checked(server, serial, &cmd).await?;
    }
    Ok(())
}

/// Creates folders (and parents), ignoring ones that exist.
pub async fn mkdirs(server: &AdbServer, serial: &str, paths: &[String]) -> AppResult<()> {
    for chunk in paths.chunks(64) {
        run_checked(server, serial, &format!("mkdir -p -- {}", quote_all(chunk))).await?;
    }
    Ok(())
}

/// Reads at most `max` bytes from the start of a file (previews). The
/// session is dropped afterwards, so stopping early is fine.
pub async fn read_head(
    server: &AdbServer,
    serial: &str,
    path: &str,
    max: usize,
) -> AppResult<Vec<u8>> {
    let mut conn = SyncConn::open(server, serial).await?;
    conn.recv_start(path).await?;
    let mut out = Vec::new();
    while out.len() < max {
        let Some(chunk) = conn.recv_chunk().await? else {
            break;
        };
        let take = chunk.len().min(max - out.len());
        out.extend_from_slice(&chunk[..take]);
    }
    Ok(out)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageInfo {
    pub total: u64,
    pub used: u64,
    pub available: u64,
    pub mount: String,
}

pub async fn storage(server: &AdbServer, serial: &str, path: &str) -> AppResult<StorageInfo> {
    let output = run_checked(server, serial, &format!("df -k {}", shell_quote(path))).await?;
    parse_df(&output).ok_or_else(|| AppError::Protocol(format!("unexpected df output: {output}")))
}

/// Parses the first data line of `df -k` (toybox):
///
/// ```text
/// Filesystem       1K-blocks    Used Available Use% Mounted on
/// /dev/fuse          6082144 3094096   2845836  53% /storage/emulated
/// ```
pub fn parse_df(output: &str) -> Option<StorageInfo> {
    let line = output
        .lines()
        .skip_while(|l| !l.starts_with("Filesystem"))
        .nth(1)?;
    let cols: Vec<&str> = line.split_whitespace().collect();
    if cols.len() < 6 {
        return None;
    }
    let kib = |s: &str| s.parse::<u64>().ok().map(|v| v * 1024);
    Some(StorageInfo {
        total: kib(cols[1])?,
        used: kib(cols[2])?,
        available: kib(cols[3])?,
        mount: cols[5..].join(" "),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adb::sync::SyncFeatures;
    use crate::adb::sync::tests::{dent_v2, read_req, stat_v2_body};
    use tokio::io::{AsyncWriteExt, duplex};

    #[test]
    fn normalizes_paths() {
        assert_eq!(normalize("/sdcard/DCIM/"), "/sdcard/DCIM");
        assert_eq!(normalize("sdcard//DCIM/./Camera"), "/sdcard/DCIM/Camera");
        assert_eq!(normalize("/sdcard/DCIM/../Download"), "/sdcard/Download");
        assert_eq!(normalize("/../.."), "/");
        assert_eq!(normalize(""), "/");
    }

    #[test]
    fn joins_and_splits() {
        assert_eq!(join("/", "sdcard"), "/sdcard");
        assert_eq!(join("/sdcard", "a b.jpg"), "/sdcard/a b.jpg");
        assert_eq!(basename("/sdcard/DCIM/"), "DCIM");
        assert_eq!(basename("/"), "/");
        assert_eq!(basename("file"), "file");
    }

    #[test]
    fn formats_permissions_like_ls() {
        assert_eq!(permissions_string(S_IFDIR | 0o771), "drwxrwx--x");
        assert_eq!(permissions_string(S_IFREG | 0o660), "-rw-rw----");
        assert_eq!(permissions_string(S_IFLNK | 0o777), "lrwxrwxrwx");
        // /sdcard folders are setgid: drwxrws---
        assert_eq!(permissions_string(S_IFDIR | 0o2770), "drwxrws---");
        assert_eq!(permissions_string(S_IFDIR | 0o1777), "drwxrwxrwt");
        assert_eq!(permissions_string(S_IFREG | 0o4644), "-rwSr--r--");
    }

    #[test]
    fn names_android_ids() {
        assert_eq!(android_id_name(0), "root");
        assert_eq!(android_id_name(1023), "media_rw");
        assert_eq!(android_id_name(2000), "shell");
        assert_eq!(android_id_name(10_200), "u0_a200");
        assert_eq!(android_id_name(1_010_212), "u10_a212");
        assert_eq!(android_id_name(20_212), "u0_a212_cache");
        assert_eq!(android_id_name(50_212), "all_a212");
        assert_eq!(android_id_name(99_003), "u0_i9003");
        assert_eq!(android_id_name(101_000), "u1_system");
        assert_eq!(android_id_name(4321), "4321");
    }

    #[test]
    fn quotes_shell_arguments() {
        assert_eq!(shell_quote("/sdcard/DCIM"), "/sdcard/DCIM");
        assert_eq!(shell_quote("a b"), "'a b'");
        assert_eq!(shell_quote(""), "''");
        assert_eq!(shell_quote("it's"), r"'it'\''s'");
        assert_eq!(shell_quote("$(reboot)"), "'$(reboot)'");
        assert_eq!(shell_quote("x;rm -rf /"), "'x;rm -rf /'");
        assert_eq!(shell_quote("Как установить"), "'Как установить'");
        assert_eq!(shell_quote("-rf"), "-rf");
        assert_eq!(
            quote_all(&["/sdcard/a", "/sdcard/b c"]),
            "/sdcard/a '/sdcard/b c'"
        );
    }

    #[test]
    fn checks_exit_status() {
        assert_eq!(parse_checked("__tether_exit=0\n").unwrap(), "");
        assert_eq!(parse_checked("hello\n__tether_exit=0\n").unwrap(), "hello");
        let err =
            parse_checked("mkdir: '/data/x': Permission denied\n__tether_exit=1\n").unwrap_err();
        assert!(matches!(err, AppError::Device(m) if m == "mkdir: '/data/x': Permission denied"));
        assert!(matches!(
            parse_checked("garbage"),
            Err(AppError::Protocol(_))
        ));
    }

    #[test]
    fn validates_modes() {
        for ok in [
            "644",
            "0755",
            "4755",
            "7",
            "u+x",
            "g-w,o-rwx",
            "a=r",
            "+x",
            "u=rwX",
        ] {
            assert!(validate_mode(ok).is_ok(), "{ok}");
        }
        for bad in ["", "888", "12345", "u+q", "644; reboot", "u", "rwx", "u+x,"] {
            assert!(validate_mode(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn refuses_root_targets() {
        assert!(check_target("/").is_err());
        assert!(check_target("/sdcard/..").is_err());
        assert_eq!(check_target("/sdcard/x/").unwrap(), "/sdcard/x");
    }

    #[test]
    fn parses_df_from_emulator() {
        let out = "Filesystem       1K-blocks    Used Available Use% Mounted on\n\
                   /dev/fuse          6082144 3094096   2845836  53% /storage/emulated\n";
        let info = parse_df(out).unwrap();
        assert_eq!(info.total, 6_082_144 * 1024);
        assert_eq!(info.used, 3_094_096 * 1024);
        assert_eq!(info.available, 2_845_836 * 1024);
        assert_eq!(info.mount, "/storage/emulated");
        assert_eq!(parse_df("df: /nope: No such file or directory"), None);
    }

    #[tokio::test]
    async fn lists_and_resolves_symlinks() {
        let (client, mut dev) = duplex(1 << 16);
        tokio::spawn(async move {
            // stat("/") → dir
            let (id, path) = read_req(&mut dev).await;
            assert_eq!((id.as_str(), path.as_slice()), ("STA2", &b"/"[..]));
            let mut out = b"STA2".to_vec();
            out.extend(stat_v2_body(0, S_IFDIR | 0o755, 0, 0, 4096, 1));
            dev.write_all(&out).await.unwrap();
            // LIS2 /
            let (id, _) = read_req(&mut dev).await;
            assert_eq!(id, "LIS2");
            let mut out = Vec::new();
            out.extend(dent_v2(b"DNT2", S_IFDIR | 0o755, 4096, 1, "."));
            out.extend(dent_v2(b"DNT2", S_IFDIR | 0o755, 4096, 1, ".."));
            out.extend(dent_v2(b"DNT2", S_IFLNK | 0o777, 21, 1, "sdcard"));
            out.extend(dent_v2(b"DNT2", S_IFLNK | 0o644, 11, 1, "bin"));
            out.extend(dent_v2(b"DNT2", S_IFDIR | 0o771, 4096, 1, "data"));
            out.extend(dent_v2(b"DONE", 0, 0, 0, ""));
            dev.write_all(&out).await.unwrap();
            // stat("/sdcard/") → dir, stat("/bin/") → dir
            for expected in ["/sdcard/", "/bin/"] {
                let (_, path) = read_req(&mut dev).await;
                assert_eq!(path, expected.as_bytes());
                let mut out = b"STA2".to_vec();
                out.extend(stat_v2_body(0, S_IFDIR | 0o751, 0, 0, 4096, 1));
                dev.write_all(&out).await.unwrap();
            }
            dev
        });

        let features = SyncFeatures {
            stat_v2: true,
            ls_v2: true,
        };
        let mut conn = SyncConn::new(client, features);
        let listing = list_with(&mut conn, "/").await.unwrap();
        assert!(!listing.denied);
        let names: Vec<_> = listing.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["sdcard", "bin", "data"]);
        assert!(listing.entries[0].link_to_dir);
        assert!(listing.entries[0].is_dir_like());
        assert_eq!(listing.entries[0].path, "/sdcard");
        assert_eq!(listing.entries[2].owner.as_deref(), Some("media_rw"));
    }

    #[tokio::test]
    async fn empty_listing_means_denied() {
        let (client, mut dev) = duplex(1 << 16);
        tokio::spawn(async move {
            read_req(&mut dev).await;
            let mut out = b"STA2".to_vec();
            out.extend(stat_v2_body(0, S_IFDIR | 0o771, 1000, 1000, 4096, 1));
            dev.write_all(&out).await.unwrap();
            read_req(&mut dev).await;
            dev.write_all(&dent_v2(b"DONE", 0, 0, 0, "")).await.unwrap();
            dev
        });
        let features = SyncFeatures {
            stat_v2: true,
            ls_v2: true,
        };
        let mut conn = SyncConn::new(client, features);
        let listing = list_with(&mut conn, "/data").await.unwrap();
        assert!(listing.denied);
        assert!(listing.entries.is_empty());
    }
}
