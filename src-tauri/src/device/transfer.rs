//! Recursive pull / push over the sync protocol with progress, pause and
//! cancellation.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use super::files::{basename, join, normalize};
use crate::adb::server::AdbServer;
use crate::adb::sync::{DATA_MAX, RemoteStat, S_IFREG, SyncConn};
use crate::error::{AppError, AppResult};

const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);
const PAUSE_POLL: Duration = Duration::from_millis(100);

/// Cancel and pause switches of one running transfer.
#[derive(Debug, Default)]
pub struct TransferControl {
    pub cancel: AtomicBool,
    pub pause: AtomicBool,
}

impl TransferControl {
    /// Waits while paused; fails once cancelled.
    async fn checkpoint(&self) -> AppResult<()> {
        loop {
            if self.cancel.load(Ordering::Relaxed) {
                return Err(AppError::Cancelled);
            }
            if !self.pause.load(Ordering::Relaxed) {
                return Ok(());
            }
            tokio::time::sleep(PAUSE_POLL).await;
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum TransferEvent {
    /// Walking folders to find out what to copy.
    Scanning,
    /// Totals are known; copying starts.
    Started { total_bytes: u64, total_files: u64 },
    Progress {
        bytes: u64,
        total_bytes: u64,
        files_done: u64,
        total_files: u64,
        /// Path (relative to the transfer root) of the file being copied.
        current: String,
    },
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TransferSummary {
    pub bytes: u64,
    pub files: u64,
    /// Entries that could not be read and were left out (folders the shell
    /// user may not list, broken links).
    pub skipped: u64,
    /// Top-level destinations, local paths for pulls and device paths for
    /// pushes.
    pub destinations: Vec<String>,
}

struct Progress<'a, F: FnMut(TransferEvent)> {
    emit: F,
    bytes: u64,
    total_bytes: u64,
    files_done: u64,
    total_files: u64,
    last: Instant,
    current: &'a str,
}

impl<F: FnMut(TransferEvent)> Progress<'_, F> {
    fn report(&mut self, force: bool) {
        if !force && self.last.elapsed() < PROGRESS_INTERVAL {
            return;
        }
        self.last = Instant::now();
        (self.emit)(TransferEvent::Progress {
            bytes: self.bytes,
            total_bytes: self.total_bytes,
            files_done: self.files_done,
            total_files: self.total_files,
            current: self.current.to_owned(),
        });
    }
}

// ---------------------------------------------------------------- pull --

struct PullFile {
    remote: String,
    local: PathBuf,
    rel: String,
    size: u64,
    mtime: i64,
}

#[derive(Default)]
struct PullPlan {
    dirs: Vec<PathBuf>,
    files: Vec<PullFile>,
    skipped: u64,
    destinations: Vec<String>,
}

/// Copies device files and folders into `local_dir`. Top-level names that
/// already exist locally get a ` (1)` suffix instead of being overwritten.
pub async fn pull(
    server: &AdbServer,
    serial: &str,
    remotes: &[String],
    local_dir: &Path,
    control: &TransferControl,
    emit: impl FnMut(TransferEvent),
) -> AppResult<TransferSummary> {
    let mut conn = SyncConn::open(server, serial).await?;
    let result = pull_with(&mut conn, remotes, local_dir, control, emit).await;
    if result.is_ok() {
        conn.quit().await.ok();
    }
    result
}

pub async fn pull_with<S: AsyncRead + AsyncWrite + Unpin>(
    conn: &mut SyncConn<S>,
    remotes: &[String],
    local_dir: &Path,
    control: &TransferControl,
    mut emit: impl FnMut(TransferEvent),
) -> AppResult<TransferSummary> {
    emit(TransferEvent::Scanning);
    if !tokio::fs::metadata(local_dir)
        .await
        .map(|m| m.is_dir())
        .unwrap_or(false)
    {
        return Err(AppError::InvalidInput(format!(
            "{} is not a folder",
            local_dir.display()
        )));
    }

    let mut plan = PullPlan::default();
    let mut taken = HashSet::new();
    for remote in remotes {
        control.checkpoint().await?;
        let remote = normalize(remote);
        let name = basename(&remote).to_owned();
        let local = unique_local_path(local_dir, &name, &mut taken);
        let rel = local
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or(name);
        plan.destinations.push(local.to_string_lossy().into_owned());

        let stat = stat_follow(conn, &remote)
            .await?
            .ok_or_else(|| AppError::Device(format!("{remote}: no such file or folder")))?;
        if stat.is_dir() {
            plan.dirs.push(local.clone());
            walk_remote(conn, &remote, &local, &rel, control, &mut plan).await?;
        } else {
            plan.files.push(PullFile {
                remote,
                local,
                rel,
                size: stat.size,
                mtime: stat.mtime,
            });
        }
    }

    let total_bytes = plan.files.iter().map(|f| f.size).sum();
    let total_files = plan.files.len() as u64;
    emit(TransferEvent::Started {
        total_bytes,
        total_files,
    });

    for dir in &plan.dirs {
        tokio::fs::create_dir_all(dir).await?;
    }

    let mut progress = Progress {
        emit,
        bytes: 0,
        total_bytes,
        files_done: 0,
        total_files,
        last: Instant::now(),
        current: "",
    };
    for file in &plan.files {
        progress.current = &file.rel;
        progress.report(true);
        if let Err(e) = recv_file(conn, file, control, &mut progress).await {
            tokio::fs::remove_file(&file.local).await.ok();
            return Err(e);
        }
        progress.files_done += 1;
    }
    progress.report(true);

    Ok(TransferSummary {
        bytes: progress.bytes,
        files: total_files,
        skipped: plan.skipped,
        destinations: plan.destinations,
    })
}

/// `stat` that also follows links to folders on devices without
/// `stat_v2` (whose `STAT` is an `lstat`).
async fn stat_follow<S: AsyncRead + AsyncWrite + Unpin>(
    conn: &mut SyncConn<S>,
    path: &str,
) -> AppResult<Option<RemoteStat>> {
    let stat = conn.stat(path).await?;
    if let Some(st) = stat
        && st.is_symlink()
        && let Some(target) = conn.stat(&format!("{path}/")).await?
        && target.is_dir()
    {
        return Ok(Some(target));
    }
    Ok(stat)
}

/// Depth-first walk collecting files to pull; folders the device does not
/// let us list are skipped.
async fn walk_remote<S: AsyncRead + AsyncWrite + Unpin>(
    conn: &mut SyncConn<S>,
    remote_root: &str,
    local_root: &Path,
    rel_root: &str,
    control: &TransferControl,
    plan: &mut PullPlan,
) -> AppResult<()> {
    let mut stack = vec![(
        remote_root.to_owned(),
        local_root.to_path_buf(),
        rel_root.to_owned(),
    )];
    while let Some((remote, local, rel)) = stack.pop() {
        control.checkpoint().await?;
        // Unreadable folders list as empty; they are still created locally.
        for entry in conn.list(&remote).await? {
            if entry.name == "." || entry.name == ".." {
                continue;
            }
            let child_remote = join(&remote, &entry.name);
            let child_local = local.join(sanitize_local_name(&entry.name));
            let child_rel = format!("{rel}/{}", entry.name);
            if entry.error.is_some() {
                plan.skipped += 1;
            } else if entry.stat.is_dir() {
                plan.dirs.push(child_local.clone());
                stack.push((child_remote, child_local, child_rel));
            } else if entry.stat.is_file() {
                plan.files.push(PullFile {
                    remote: child_remote,
                    local: child_local,
                    rel: child_rel,
                    size: entry.stat.size,
                    mtime: entry.stat.mtime,
                });
            } else if entry.stat.is_symlink() {
                // Copy what file links point to (like `adb pull`); links to
                // folders could loop, so they are left out.
                match conn.stat(&child_remote).await {
                    Ok(Some(target)) if target.is_file() => plan.files.push(PullFile {
                        remote: child_remote,
                        local: child_local,
                        rel: child_rel,
                        size: target.size,
                        mtime: target.mtime,
                    }),
                    _ => plan.skipped += 1,
                }
            } else {
                // Sockets, pipes and device nodes.
                plan.skipped += 1;
            }
        }
    }
    Ok(())
}

async fn recv_file<S, F>(
    conn: &mut SyncConn<S>,
    file: &PullFile,
    control: &TransferControl,
    progress: &mut Progress<'_, F>,
) -> AppResult<()>
where
    S: AsyncRead + AsyncWrite + Unpin,
    F: FnMut(TransferEvent),
{
    let mut out = tokio::fs::File::create(&file.local).await?;
    conn.recv_start(&file.remote).await?;
    loop {
        control.checkpoint().await?;
        let Some(chunk) = conn.recv_chunk().await? else {
            break;
        };
        out.write_all(chunk).await?;
        progress.bytes += chunk.len() as u64;
        progress.report(false);
    }
    out.flush().await?;
    let out = out.into_std().await;
    if let Ok(secs) = u64::try_from(file.mtime) {
        out.set_modified(UNIX_EPOCH + Duration::from_secs(secs))
            .ok();
    }
    Ok(())
}

/// `dir/name`, or `dir/name (1).ext` … if that exists or was already used
/// by this transfer.
pub fn unique_local_path(dir: &Path, name: &str, taken: &mut HashSet<PathBuf>) -> PathBuf {
    let name = sanitize_local_name(name);
    let (stem, ext) = split_ext(&name);
    for n in 0.. {
        let candidate = if n == 0 {
            dir.join(&name)
        } else {
            dir.join(format!("{stem} ({n}){ext}"))
        };
        if !taken.contains(&candidate) && std::fs::symlink_metadata(&candidate).is_err() {
            taken.insert(candidate.clone());
            return candidate;
        }
    }
    unreachable!("ran out of candidate names")
}

/// Splits `photo.jpg` into (`photo`, `.jpg`); dotfiles keep their name.
pub fn split_ext(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    }
}

/// Makes a device file name safe for the local file system: Windows does
/// not allow `<>:"\|?*` or trailing dots and spaces.
pub fn sanitize_local_name(name: &str) -> String {
    if !cfg!(windows) {
        return name.replace('\0', "_");
    }
    let replaced: String = name
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '\\' | '|' | '?' | '*' => '_',
            c if (c as u32) < 32 => '_',
            c => c,
        })
        .collect();
    let trimmed = replaced.trim_end_matches(['.', ' ']);
    if trimmed.is_empty() {
        "_".into()
    } else {
        trimmed.to_owned()
    }
}

// ---------------------------------------------------------------- push --

struct PushFile {
    local: PathBuf,
    remote: String,
    rel: String,
    size: u64,
    mode: u32,
    mtime: u32,
}

#[derive(Default)]
struct PushPlan {
    dirs: Vec<String>,
    files: Vec<PushFile>,
    skipped: u64,
    destinations: Vec<String>,
}

/// Copies local files and folders into `remote_dir`. Top-level names that
/// already exist on the device get a ` (1)` suffix.
pub async fn push(
    server: &AdbServer,
    serial: &str,
    locals: &[PathBuf],
    remote_dir: &str,
    control: &TransferControl,
    emit: impl FnMut(TransferEvent),
) -> AppResult<TransferSummary> {
    let mut conn = SyncConn::open(server, serial).await?;
    let mut emit = emit;
    emit(TransferEvent::Scanning);
    let plan = plan_push(&mut conn, locals, remote_dir, control).await?;
    if !plan.dirs.is_empty() {
        super::files::mkdirs(server, serial, &plan.dirs).await?;
    }
    let result = send_plan(&mut conn, plan, control, emit).await;
    if result.is_ok() {
        conn.quit().await.ok();
    }
    result
}

async fn plan_push<S: AsyncRead + AsyncWrite + Unpin>(
    conn: &mut SyncConn<S>,
    locals: &[PathBuf],
    remote_dir: &str,
    control: &TransferControl,
) -> AppResult<PushPlan> {
    let remote_dir = normalize(remote_dir);
    match conn.stat(&format!("{remote_dir}/")).await? {
        Some(st) if st.is_dir() => {}
        _ => {
            return Err(AppError::InvalidInput(format!(
                "{remote_dir} is not a folder"
            )));
        }
    }

    let mut plan = PushPlan::default();
    let mut taken = HashSet::new();
    for local in locals {
        control.checkpoint().await?;
        let meta = tokio::fs::metadata(local).await?;
        let name = local
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .ok_or_else(|| {
                AppError::InvalidInput(format!("{} has no file name", local.display()))
            })?;
        let remote = unique_remote_path(conn, &remote_dir, &name, &mut taken).await?;
        let rel = basename(&remote).to_owned();
        plan.destinations.push(remote.clone());

        if meta.is_dir() {
            plan.dirs.push(remote.clone());
            walk_local(local, &remote, &rel, control, &mut plan).await?;
        } else {
            plan.files
                .push(push_file(local.clone(), remote, rel, &meta));
        }
    }
    Ok(plan)
}

async fn walk_local(
    local_root: &Path,
    remote_root: &str,
    rel_root: &str,
    control: &TransferControl,
    plan: &mut PushPlan,
) -> AppResult<()> {
    let mut stack = vec![(
        local_root.to_path_buf(),
        remote_root.to_owned(),
        rel_root.to_owned(),
    )];
    let mut seen = HashSet::new();
    while let Some((local, remote, rel)) = stack.pop() {
        control.checkpoint().await?;
        // Guards against symlink loops.
        if let Ok(canonical) = tokio::fs::canonicalize(&local).await
            && !seen.insert(canonical)
        {
            continue;
        }
        let mut dir = match tokio::fs::read_dir(&local).await {
            Ok(dir) => dir,
            Err(_) => {
                plan.skipped += 1;
                continue;
            }
        };
        while let Some(entry) = dir.next_entry().await? {
            let name = entry.file_name().to_string_lossy().into_owned();
            let path = entry.path();
            let Ok(meta) = tokio::fs::metadata(&path).await else {
                plan.skipped += 1;
                continue;
            };
            let child_remote = join(&remote, &name);
            let child_rel = format!("{rel}/{name}");
            if meta.is_dir() {
                plan.dirs.push(child_remote.clone());
                stack.push((path, child_remote, child_rel));
            } else if meta.is_file() {
                plan.files
                    .push(push_file(path, child_remote, child_rel, &meta));
            } else {
                plan.skipped += 1;
            }
        }
    }
    Ok(())
}

fn push_file(local: PathBuf, remote: String, rel: String, meta: &std::fs::Metadata) -> PushFile {
    #[cfg(unix)]
    let perm = {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o777
    };
    #[cfg(not(unix))]
    let perm = 0o644;
    let mtime = meta
        .modified()
        .unwrap_or_else(|_| SystemTime::now())
        .duration_since(UNIX_EPOCH)
        .map(|d| u32::try_from(d.as_secs()).unwrap_or(u32::MAX))
        .unwrap_or(0);
    PushFile {
        local,
        remote,
        rel,
        size: meta.len(),
        mode: S_IFREG | perm,
        mtime,
    }
}

async fn unique_remote_path<S: AsyncRead + AsyncWrite + Unpin>(
    conn: &mut SyncConn<S>,
    dir: &str,
    name: &str,
    taken: &mut HashSet<String>,
) -> AppResult<String> {
    let (stem, ext) = split_ext(name);
    for n in 0..10_000 {
        let candidate = if n == 0 {
            join(dir, name)
        } else {
            join(dir, &format!("{stem} ({n}){ext}"))
        };
        if !taken.contains(&candidate) && conn.lstat(&candidate).await?.is_none() {
            taken.insert(candidate.clone());
            return Ok(candidate);
        }
    }
    Err(AppError::InvalidInput(format!("too many copies of {name}")))
}

async fn send_plan<S, F>(
    conn: &mut SyncConn<S>,
    plan: PushPlan,
    control: &TransferControl,
    mut emit: F,
) -> AppResult<TransferSummary>
where
    S: AsyncRead + AsyncWrite + Unpin,
    F: FnMut(TransferEvent),
{
    let total_bytes = plan.files.iter().map(|f| f.size).sum();
    let total_files = plan.files.len() as u64;
    emit(TransferEvent::Started {
        total_bytes,
        total_files,
    });
    let mut progress = Progress {
        emit,
        bytes: 0,
        total_bytes,
        files_done: 0,
        total_files,
        last: Instant::now(),
        current: "",
    };
    for file in &plan.files {
        progress.current = &file.rel;
        progress.report(true);
        send_file(conn, file, control, &mut progress).await?;
        progress.files_done += 1;
    }
    progress.report(true);
    Ok(TransferSummary {
        bytes: progress.bytes,
        files: total_files,
        skipped: plan.skipped,
        destinations: plan.destinations,
    })
}

async fn send_file<S, F>(
    conn: &mut SyncConn<S>,
    file: &PushFile,
    control: &TransferControl,
    progress: &mut Progress<'_, F>,
) -> AppResult<()>
where
    S: AsyncRead + AsyncWrite + Unpin,
    F: FnMut(TransferEvent),
{
    let mut input = tokio::fs::File::open(&file.local).await?;
    conn.send_start(&file.remote, file.mode).await?;
    let mut buf = vec![0u8; DATA_MAX];
    loop {
        control.checkpoint().await?;
        let n = input.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        if let Err(e) = conn.send_data(&buf[..n]).await {
            // The device answers FAIL and hangs up when it cannot store
            // the data; prefer its message over "broken pipe".
            return Err(conn.read_send_status().await.err().unwrap_or(e));
        }
        progress.bytes += n as u64;
        progress.report(false);
    }
    conn.send_finish(file.mtime).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adb::sync::tests::{dent_v1, read_req};
    use crate::adb::sync::{S_IFDIR, SyncFeatures};
    use tokio::io::duplex;

    const V1: SyncFeatures = SyncFeatures {
        stat_v2: false,
        ls_v2: false,
    };

    #[test]
    fn splits_extensions() {
        assert_eq!(split_ext("photo.jpg"), ("photo", ".jpg"));
        assert_eq!(split_ext("archive.tar.gz"), ("archive.tar", ".gz"));
        assert_eq!(split_ext(".thumbnails"), (".thumbnails", ""));
        assert_eq!(split_ext("README"), ("README", ""));
    }

    #[test]
    fn picks_unique_local_names() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.jpg"), b"x").unwrap();
        std::fs::write(dir.path().join("a (1).jpg"), b"x").unwrap();
        let mut taken = HashSet::new();
        assert_eq!(
            unique_local_path(dir.path(), "a.jpg", &mut taken),
            dir.path().join("a (2).jpg")
        );
        assert_eq!(
            unique_local_path(dir.path(), "a.jpg", &mut taken),
            dir.path().join("a (3).jpg")
        );
        assert_eq!(
            unique_local_path(dir.path(), "DCIM", &mut taken),
            dir.path().join("DCIM")
        );
    }

    #[tokio::test]
    async fn checkpoint_waits_while_paused_and_stops_on_cancel() {
        let control = std::sync::Arc::new(TransferControl::default());
        control.pause.store(true, Ordering::Relaxed);
        let c = control.clone();
        let waiter = tokio::spawn(async move { c.checkpoint().await });
        tokio::time::sleep(Duration::from_millis(250)).await;
        assert!(!waiter.is_finished());
        control.cancel.store(true, Ordering::Relaxed);
        assert!(matches!(waiter.await.unwrap(), Err(AppError::Cancelled)));
    }

    fn data(payload: &[u8]) -> Vec<u8> {
        let mut m = b"DATA".to_vec();
        m.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        m.extend_from_slice(payload);
        m
    }

    #[tokio::test]
    async fn pulls_folder_recursively() {
        let (client, mut dev) = duplex(1 << 16);
        tokio::spawn(async move {
            let stat = |mode: u32, size: u32| {
                let mut m = b"STAT".to_vec();
                for v in [mode, size, 1_761_419_404] {
                    m.extend_from_slice(&v.to_le_bytes());
                }
                m
            };
            // stat /sdcard/DCIM
            let (id, path) = read_req(&mut dev).await;
            assert_eq!(
                (id.as_str(), path.as_slice()),
                ("STAT", &b"/sdcard/DCIM"[..])
            );
            dev.write_all(&stat(S_IFDIR | 0o771, 4096)).await.unwrap();
            // LIST /sdcard/DCIM
            let (id, _) = read_req(&mut dev).await;
            assert_eq!(id, "LIST");
            let mut out = Vec::new();
            out.extend(dent_v1(b"DENT", S_IFDIR | 0o771, 0, 0, "."));
            out.extend(dent_v1(b"DENT", S_IFDIR | 0o771, 0, 0, ".."));
            out.extend(dent_v1(b"DENT", S_IFREG | 0o660, 5, 1_761_419_404, "a.jpg"));
            out.extend(dent_v1(b"DENT", S_IFDIR | 0o771, 0, 0, "Camera"));
            out.extend(dent_v1(b"DONE", 0, 0, 0, ""));
            dev.write_all(&out).await.unwrap();
            // LIST /sdcard/DCIM/Camera (unreadable → empty)
            let (_, path) = read_req(&mut dev).await;
            assert_eq!(path, b"/sdcard/DCIM/Camera");
            dev.write_all(&dent_v1(b"DONE", 0, 0, 0, "")).await.unwrap();
            // RECV a.jpg
            let (id, path) = read_req(&mut dev).await;
            assert_eq!(
                (id.as_str(), path.as_slice()),
                ("RECV", &b"/sdcard/DCIM/a.jpg"[..])
            );
            let mut out = data(b"hello");
            out.extend_from_slice(b"DONE\0\0\0\0");
            dev.write_all(&out).await.unwrap();
            dev
        });

        let dir = tempfile::tempdir().unwrap();
        let mut conn = SyncConn::new(client, V1);
        let control = TransferControl::default();
        let mut events = Vec::new();
        let summary = pull_with(
            &mut conn,
            &["/sdcard/DCIM".into()],
            dir.path(),
            &control,
            |e| events.push(e),
        )
        .await
        .unwrap();

        assert_eq!(summary.files, 1);
        assert_eq!(summary.bytes, 5);
        assert_eq!(summary.skipped, 0);
        let pulled = dir.path().join("DCIM/a.jpg");
        assert_eq!(std::fs::read(&pulled).unwrap(), b"hello");
        assert!(dir.path().join("DCIM/Camera").is_dir());
        let mtime = std::fs::metadata(&pulled).unwrap().modified().unwrap();
        assert_eq!(
            mtime.duration_since(UNIX_EPOCH).unwrap().as_secs(),
            1_761_419_404
        );
        assert_eq!(events[0], TransferEvent::Scanning);
        assert_eq!(
            events[1],
            TransferEvent::Started {
                total_bytes: 5,
                total_files: 1
            }
        );
        assert!(matches!(
            events.last(),
            Some(TransferEvent::Progress {
                bytes: 5,
                files_done: 1,
                ..
            })
        ));
    }

    #[tokio::test]
    async fn failed_pull_removes_partial_file() {
        let (client, mut dev) = duplex(1 << 16);
        tokio::spawn(async move {
            read_req(&mut dev).await;
            let mut m = b"STAT".to_vec();
            for v in [S_IFREG | 0o600, 10, 0] {
                m.extend_from_slice(&v.to_le_bytes());
            }
            dev.write_all(&m).await.unwrap();
            read_req(&mut dev).await;
            let mut out = data(b"part");
            let msg = b"read failed: I/O error";
            out.extend_from_slice(b"FAIL");
            out.extend_from_slice(&(msg.len() as u32).to_le_bytes());
            out.extend_from_slice(msg);
            dev.write_all(&out).await.unwrap();
            dev
        });

        let dir = tempfile::tempdir().unwrap();
        let mut conn = SyncConn::new(client, V1);
        let err = pull_with(
            &mut conn,
            &["/data/local/tmp/x".into()],
            dir.path(),
            &TransferControl::default(),
            |_| {},
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::Device(m) if m.contains("I/O error")));
        assert!(!dir.path().join("x").exists());
    }

    #[tokio::test]
    async fn pushes_folder_with_unique_name() {
        let src = tempfile::tempdir().unwrap();
        let root = src.path().join("assets");
        std::fs::create_dir_all(root.join("img")).unwrap();
        std::fs::write(root.join("img/logo.png"), b"PNG!").unwrap();

        let (client, mut dev) = duplex(1 << 16);
        let device = tokio::spawn(async move {
            let stat = |mode: u32| {
                let mut m = b"STAT".to_vec();
                for v in [mode, 0, 0] {
                    m.extend_from_slice(&v.to_le_bytes());
                }
                m
            };
            // remote dir check
            let (_, path) = read_req(&mut dev).await;
            assert_eq!(path, b"/sdcard/Download/");
            dev.write_all(&stat(S_IFDIR | 0o771)).await.unwrap();
            // "assets" exists, "assets (1)" does not
            let (_, path) = read_req(&mut dev).await;
            assert_eq!(path, b"/sdcard/Download/assets");
            dev.write_all(&stat(S_IFDIR | 0o771)).await.unwrap();
            let (_, path) = read_req(&mut dev).await;
            assert_eq!(path, b"/sdcard/Download/assets (1)");
            dev.write_all(&stat(0)).await.unwrap();
            // SEND
            let (id, spec) = read_req(&mut dev).await;
            assert_eq!(id, "SEND");
            let spec = String::from_utf8(spec).unwrap();
            assert!(spec.starts_with("/sdcard/Download/assets (1)/img/logo.png,"));
            let (id, payload) = read_req(&mut dev).await;
            assert_eq!((id.as_str(), payload.as_slice()), ("DATA", &b"PNG!"[..]));
            let mut done = [0u8; 8];
            dev.read_exact(&mut done).await.unwrap();
            assert_eq!(&done[..4], b"DONE");
            dev.write_all(b"OKAY\0\0\0\0").await.unwrap();
            dev
        });

        let mut conn = SyncConn::new(client, V1);
        let control = TransferControl::default();
        let plan = plan_push(&mut conn, &[root], "/sdcard/Download", &control)
            .await
            .unwrap();
        assert_eq!(
            plan.dirs,
            [
                "/sdcard/Download/assets (1)",
                "/sdcard/Download/assets (1)/img"
            ]
        );
        let summary = send_plan(&mut conn, plan, &control, |_| {}).await.unwrap();
        device.await.unwrap();
        assert_eq!(summary.files, 1);
        assert_eq!(summary.bytes, 4);
        assert_eq!(summary.destinations, ["/sdcard/Download/assets (1)"]);
    }

    #[tokio::test]
    async fn cancelled_pull_stops_before_copying() {
        let (client, _dev) = duplex(64);
        let dir = tempfile::tempdir().unwrap();
        let mut conn = SyncConn::new(client, V1);
        let control = TransferControl::default();
        control.cancel.store(true, Ordering::Relaxed);
        let err = pull_with(&mut conn, &["/x".into()], dir.path(), &control, |_| {})
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Cancelled));
    }
}
