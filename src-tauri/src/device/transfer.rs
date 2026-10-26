//! Recursive pull / push over the sync protocol with progress, pause and
//! cancellation. Files travel compressed (`sendrecv_v2`) when the device
//! supports it and the content is likely to shrink.

use std::collections::HashSet;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use super::files::{basename, join, normalize};
use crate::adb::compression::{self, Compression, StreamEncoder};
use crate::adb::server::AdbServer;
use crate::adb::sync::{CompressionFeatures, DATA_MAX, RemoteStat, S_IFREG, SyncConn};
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

/// Whether files travel compressed.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum CompressionMode {
    /// Plain `RECV` / `SEND`.
    Off,
    /// The device's preferred codec, for files that are likely to shrink.
    #[default]
    Auto,
    /// This codec for every file the device accepts it for (benchmarks).
    Force(Compression),
}

/// Files smaller than this go uncompressed: there is nothing to win.
const COMPRESS_MIN: u64 = 16 * 1024;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TransferOptions {
    pub compression: CompressionMode,
}

impl TransferOptions {
    fn codec_for(
        &self,
        supported: CompressionFeatures,
        name: &str,
        size: u64,
    ) -> Option<Compression> {
        match self.compression {
            CompressionMode::Off => None,
            CompressionMode::Force(codec) => supported.supports(codec).then_some(codec),
            CompressionMode::Auto => {
                if size < COMPRESS_MIN || !compression::worth_compressing(name) {
                    None
                } else {
                    supported.best()
                }
            }
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
    let options = TransferOptions::default();
    pull_with_options(server, serial, remotes, local_dir, control, options, emit).await
}

/// [`pull`] with explicit options.
pub async fn pull_with_options(
    server: &AdbServer,
    serial: &str,
    remotes: &[String],
    local_dir: &Path,
    control: &TransferControl,
    options: TransferOptions,
    emit: impl FnMut(TransferEvent),
) -> AppResult<TransferSummary> {
    let mut conn = SyncConn::open(server, serial).await?;
    let result = pull_with(&mut conn, remotes, local_dir, control, options, emit).await;
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
    options: TransferOptions,
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
        let codec = options.codec_for(conn.compression(), &file.rel, file.size);
        let result = match codec {
            Some(codec) => recv_file_compressed(conn, file, codec, control, &mut progress).await,
            None => recv_file(conn, file, control, &mut progress).await,
        };
        if let Err(e) = result {
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

/// Feeds `DATA` payloads to a blocking decoder.
struct ChunkReader {
    rx: tokio::sync::mpsc::Receiver<Vec<u8>>,
    chunk: Vec<u8>,
    pos: usize,
}

impl Read for ChunkReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        while self.pos == self.chunk.len() {
            match self.rx.blocking_recv() {
                Some(chunk) => {
                    self.chunk = chunk;
                    self.pos = 0;
                }
                None => return Ok(0),
            }
        }
        let n = buf.len().min(self.chunk.len() - self.pos);
        buf[..n].copy_from_slice(&self.chunk[self.pos..self.pos + n]);
        self.pos += n;
        Ok(n)
    }
}

/// `RCV2`: the network side stays async, decoding and writing the file run
/// on a blocking thread fed through a channel.
async fn recv_file_compressed<S, F>(
    conn: &mut SyncConn<S>,
    file: &PullFile,
    codec: Compression,
    control: &TransferControl,
    progress: &mut Progress<'_, F>,
) -> AppResult<()>
where
    S: AsyncRead + AsyncWrite + Unpin,
    F: FnMut(TransferEvent),
{
    let (tx, rx) = tokio::sync::mpsc::channel::<Vec<u8>>(16);
    let written = Arc::new(AtomicU64::new(0));
    let counter = written.clone();
    let local = file.local.clone();
    let mtime = file.mtime;
    let worker = tokio::task::spawn_blocking(move || -> std::io::Result<()> {
        let mut out = std::io::BufWriter::with_capacity(256 * 1024, std::fs::File::create(&local)?);
        let reader = ChunkReader {
            rx,
            chunk: Vec::new(),
            pos: 0,
        };
        let mut decoder = compression::decoder(codec, reader)?;
        let mut buf = vec![0u8; 256 * 1024];
        loop {
            let n = decoder.read(&mut buf)?;
            if n == 0 {
                break;
            }
            out.write_all(&buf[..n])?;
            counter.fetch_add(n as u64, Ordering::Relaxed);
        }
        let out = out.into_inner().map_err(|e| e.into_error())?;
        if let Ok(secs) = u64::try_from(mtime) {
            out.set_modified(UNIX_EPOCH + Duration::from_secs(secs))
                .ok();
        }
        Ok(())
    });

    let base = progress.bytes;
    let streamed = async {
        conn.recv_start_v2(&file.remote, codec).await?;
        let mut decoding = true;
        loop {
            control.checkpoint().await?;
            let Some(chunk) = conn.recv_chunk().await? else {
                break;
            };
            // If the decoder stopped (end of stream or bad data), keep
            // reading up to DONE so the session stays in step; its error
            // is reported below.
            if decoding && tx.send(chunk.to_vec()).await.is_err() {
                decoding = false;
            }
            progress.bytes = base + written.load(Ordering::Relaxed);
            progress.report(false);
        }
        AppResult::Ok(())
    }
    .await;
    drop(tx);
    let decoded = worker
        .await
        .map_err(|e| AppError::Device(format!("decoder failed: {e}")))?;
    progress.bytes = base + written.load(Ordering::Relaxed);
    streamed?;
    decoded.map_err(|e| {
        AppError::Device(format!(
            "{}: could not unpack the {} stream: {e}",
            file.remote,
            codec.name()
        ))
    })
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
    let options = TransferOptions::default();
    push_with_options(server, serial, locals, remote_dir, control, options, emit).await
}

/// [`push`] with explicit options.
pub async fn push_with_options(
    server: &AdbServer,
    serial: &str,
    locals: &[PathBuf],
    remote_dir: &str,
    control: &TransferControl,
    options: TransferOptions,
    emit: impl FnMut(TransferEvent),
) -> AppResult<TransferSummary> {
    let mut conn = SyncConn::open(server, serial).await?;
    let mut emit = emit;
    emit(TransferEvent::Scanning);
    let plan = plan_push(&mut conn, locals, remote_dir, control).await?;
    if !plan.dirs.is_empty() {
        super::files::mkdirs(server, serial, &plan.dirs).await?;
    }
    let result = send_plan(&mut conn, plan, control, options, emit).await;
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
    options: TransferOptions,
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
        let codec = options.codec_for(conn.compression(), &file.rel, file.size);
        send_file(conn, file, codec, control, &mut progress).await?;
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

/// `SEND`, or `SND2` with `codec`: the encoder runs inline and its output
/// is cut into `DATA` messages as it comes.
async fn send_file<S, F>(
    conn: &mut SyncConn<S>,
    file: &PushFile,
    codec: Option<Compression>,
    control: &TransferControl,
    progress: &mut Progress<'_, F>,
) -> AppResult<()>
where
    S: AsyncRead + AsyncWrite + Unpin,
    F: FnMut(TransferEvent),
{
    let mut input = tokio::fs::File::open(&file.local).await?;
    let mut encoder = match codec {
        Some(codec) => {
            conn.send_start_v2(&file.remote, file.mode, codec).await?;
            Some(StreamEncoder::new(codec)?)
        }
        None => {
            conn.send_start(&file.remote, file.mode).await?;
            None
        }
    };
    let mut buf = vec![0u8; DATA_MAX];
    let mut packed = Vec::with_capacity(DATA_MAX * 2);
    loop {
        control.checkpoint().await?;
        let n = input.read(&mut buf).await?;
        let data: &[u8] = if encoder.is_none() {
            &buf[..n]
        } else {
            if n > 0 {
                if let Some(enc) = encoder.as_mut() {
                    enc.write(&buf[..n], &mut packed)?;
                }
            } else if let Some(enc) = encoder.take() {
                enc.finish(&mut packed)?;
            }
            &packed
        };
        if !data.is_empty()
            && let Err(e) = conn.send_data(data).await
        {
            // The device answers FAIL and hangs up when it cannot store
            // the data; prefer its message over "broken pipe".
            return Err(conn.read_send_status().await.err().unwrap_or(e));
        }
        packed.clear();
        if n == 0 {
            break;
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
            TransferOptions::default(),
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
            TransferOptions::default(),
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
        let options = TransferOptions::default();
        let summary = send_plan(&mut conn, plan, &control, options, |_| {})
            .await
            .unwrap();
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
        let options = TransferOptions::default();
        let err = pull_with(
            &mut conn,
            &["/x".into()],
            dir.path(),
            &control,
            options,
            |_| {},
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::Cancelled));
    }

    const ALL_CODECS: CompressionFeatures = CompressionFeatures {
        brotli: true,
        lz4: true,
        zstd: true,
    };

    fn log_text(lines: u32) -> Vec<u8> {
        (0..lines)
            .flat_map(|i| format!("10-26 12:00:00.{i:03} I/Tether: line {i}\n").into_bytes())
            .collect()
    }

    #[test]
    fn auto_mode_picks_codec_by_name_and_size() {
        let auto = TransferOptions::default();
        assert_eq!(
            auto.codec_for(ALL_CODECS, "dir/logcat.txt", 1 << 20),
            Some(Compression::Lz4)
        );
        assert_eq!(auto.codec_for(ALL_CODECS, "DCIM/a.jpg", 1 << 20), None);
        assert_eq!(auto.codec_for(ALL_CODECS, "small.txt", 100), None);
        assert_eq!(
            auto.codec_for(CompressionFeatures::default(), "a.txt", 1 << 20),
            None
        );
        let off = TransferOptions {
            compression: CompressionMode::Off,
        };
        assert_eq!(off.codec_for(ALL_CODECS, "a.txt", 1 << 20), None);
        let forced = TransferOptions {
            compression: CompressionMode::Force(Compression::Brotli),
        };
        assert_eq!(
            forced.codec_for(ALL_CODECS, "a.jpg", 1),
            Some(Compression::Brotli)
        );
    }

    #[tokio::test]
    async fn pulls_compressed_file() {
        let text = log_text(20_000);
        let mut enc = StreamEncoder::new(Compression::Zstd).unwrap();
        let mut packed = Vec::new();
        enc.write(&text, &mut packed).unwrap();
        enc.finish(&mut packed).unwrap();
        let size = text.len() as u32;

        let (client, mut dev) = duplex(1 << 16);
        tokio::spawn(async move {
            read_req(&mut dev).await;
            let mut m = b"STAT".to_vec();
            for v in [S_IFREG | 0o660, size, 1_761_419_404] {
                m.extend_from_slice(&v.to_le_bytes());
            }
            dev.write_all(&m).await.unwrap();
            let (id, path) = read_req(&mut dev).await;
            assert_eq!(
                (id.as_str(), path.as_slice()),
                ("RCV2", &b"/sdcard/app.log"[..])
            );
            let mut setup = [0u8; 8];
            dev.read_exact(&mut setup).await.unwrap();
            assert_eq!(&setup, b"RCV2\x04\0\0\0");
            // Odd chunk sizes: DATA boundaries do not follow zstd blocks.
            for chunk in packed.chunks(7_777) {
                dev.write_all(&data(chunk)).await.unwrap();
            }
            dev.write_all(b"DONE\0\0\0\0").await.unwrap();
            dev
        });

        let dir = tempfile::tempdir().unwrap();
        let mut conn = SyncConn::new(client, V1).with_compression(CompressionFeatures {
            brotli: false,
            lz4: false,
            zstd: true,
        });
        let summary = pull_with(
            &mut conn,
            &["/sdcard/app.log".into()],
            dir.path(),
            &TransferControl::default(),
            TransferOptions::default(),
            |_| {},
        )
        .await
        .unwrap();
        assert_eq!(summary.bytes, text.len() as u64);
        let pulled = dir.path().join("app.log");
        assert_eq!(std::fs::read(&pulled).unwrap(), text);
        let mtime = std::fs::metadata(&pulled).unwrap().modified().unwrap();
        assert_eq!(
            mtime.duration_since(UNIX_EPOCH).unwrap().as_secs(),
            1_761_419_404
        );
    }

    #[tokio::test]
    async fn corrupt_compressed_pull_fails_and_cleans_up() {
        let (client, mut dev) = duplex(1 << 16);
        tokio::spawn(async move {
            read_req(&mut dev).await;
            let mut m = b"STAT".to_vec();
            for v in [S_IFREG | 0o660, 1 << 20, 0] {
                m.extend_from_slice(&v.to_le_bytes());
            }
            dev.write_all(&m).await.unwrap();
            read_req(&mut dev).await;
            let mut setup = [0u8; 8];
            dev.read_exact(&mut setup).await.unwrap();
            dev.write_all(&data(&[0xAB; 5000])).await.unwrap();
            dev.write_all(b"DONE\0\0\0\0").await.unwrap();
            dev
        });

        let dir = tempfile::tempdir().unwrap();
        let mut conn = SyncConn::new(client, V1).with_compression(ALL_CODECS);
        let err = pull_with(
            &mut conn,
            &["/sdcard/x.log".into()],
            dir.path(),
            &TransferControl::default(),
            TransferOptions::default(),
            |_| {},
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::Device(m) if m.contains("lz4")));
        assert!(!dir.path().join("x.log").exists());
    }

    #[tokio::test]
    async fn pushes_compressed_file_in_small_messages() {
        let src = tempfile::tempdir().unwrap();
        let local = src.path().join("trace.txt");
        let text = log_text(50_000);
        std::fs::write(&local, &text).unwrap();

        let (client, mut dev) = duplex(1 << 16);
        let device = tokio::spawn(async move {
            let stat = |mode: u32| {
                let mut m = b"STAT".to_vec();
                for v in [mode, 0, 0] {
                    m.extend_from_slice(&v.to_le_bytes());
                }
                m
            };
            read_req(&mut dev).await;
            dev.write_all(&stat(S_IFDIR | 0o771)).await.unwrap();
            read_req(&mut dev).await;
            dev.write_all(&stat(0)).await.unwrap();
            let (id, path) = read_req(&mut dev).await;
            assert_eq!(
                (id.as_str(), path.as_slice()),
                ("SND2", &b"/sdcard/trace.txt"[..])
            );
            let mut setup = [0u8; 12];
            dev.read_exact(&mut setup).await.unwrap();
            assert_eq!(&setup[..4], b"SND2");
            assert_eq!(u32::from_le_bytes(setup[8..].try_into().unwrap()), 2);
            let mut packed = Vec::new();
            loop {
                let (id, payload) = read_req(&mut dev).await;
                if id == "DONE" {
                    break;
                }
                assert_eq!(id, "DATA");
                assert!(payload.len() <= DATA_MAX);
                packed.extend(payload);
            }
            dev.write_all(b"OKAY\0\0\0\0").await.unwrap();
            packed
        });

        let mut conn = SyncConn::new(client, V1).with_compression(ALL_CODECS);
        let control = TransferControl::default();
        let plan = plan_push(&mut conn, &[local], "/sdcard", &control)
            .await
            .unwrap();
        // The fake reads DONE as a request whose mtime is its length.
        let mut plan = plan;
        plan.files[0].mtime = 0;
        let summary = send_plan(
            &mut conn,
            plan,
            &control,
            TransferOptions::default(),
            |_| {},
        )
        .await
        .unwrap();
        assert_eq!(summary.bytes, text.len() as u64);
        let packed = device.await.unwrap();
        assert!(packed.len() * 4 < text.len());
        let mut unpacked = Vec::new();
        compression::decoder(Compression::Lz4, packed.as_slice())
            .unwrap()
            .read_to_end(&mut unpacked)
            .unwrap();
        assert_eq!(unpacked, text);
    }
}
