//! Client for the adb file sync service (AOSP
//! `packages/modules/adb/SYNC.TXT`, `file_sync_protocol.h`).
//!
//! After `sync:` is opened on a device, every request is a 4-byte ASCII id
//! followed by a little-endian `u32` length and that many bytes of payload
//! (a path for `LIST`/`STAT`/`RECV`/`SEND`). Responses use the same
//! id + little-endian fields framing:
//!
//! - `LIST` → `DENT` × n, then `DONE` (all 20-byte `dent_v1` records);
//! - `LIS2` → `DNT2` × n, then `DONE` (76-byte `dent_v2` records);
//! - `STAT` → one 16-byte `stat_v1` (`mode == 0` means "does not exist");
//! - `STA2` / `LST2` → one 72-byte `stat_v2` with an `errno`-style error;
//! - `RECV` → `DATA` chunks, then `DONE`, or `FAIL` with a message;
//! - `SEND` (`path,mode`) → the client streams `DATA` chunks of at most
//!   64 KiB and `DONE <mtime>`; the device answers `OKAY` or `FAIL`.
//!
//! v1 `STAT` and `LIST` use `lstat`, so symlinks are reported as links.

use serde::Serialize;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;

use super::server::{AdbServer, read_length_prefixed};
use crate::error::{AppError, AppResult};

/// Largest payload of one `DATA` message.
pub const DATA_MAX: usize = 64 * 1024;
/// Longest path the device accepts in a sync request.
pub const PATH_MAX: usize = 1024;

const ID_LIST: &[u8; 4] = b"LIST";
const ID_LIS2: &[u8; 4] = b"LIS2";
const ID_DENT: &[u8; 4] = b"DENT";
const ID_DNT2: &[u8; 4] = b"DNT2";
const ID_STAT: &[u8; 4] = b"STAT";
const ID_STA2: &[u8; 4] = b"STA2";
const ID_LST2: &[u8; 4] = b"LST2";
const ID_RECV: &[u8; 4] = b"RECV";
const ID_SEND: &[u8; 4] = b"SEND";
const ID_DATA: &[u8; 4] = b"DATA";
const ID_DONE: &[u8; 4] = b"DONE";
const ID_OKAY: &[u8; 4] = b"OKAY";
const ID_FAIL: &[u8; 4] = b"FAIL";
const ID_QUIT: &[u8; 4] = b"QUIT";

/// Linux `errno` values as sent on the wire (`errno_to_wire`).
pub const ENOENT: u32 = 2;
pub const EACCES: u32 = 13;
pub const ENOTDIR: u32 = 20;

pub const S_IFMT: u32 = 0o170000;
pub const S_IFDIR: u32 = 0o040000;
pub const S_IFREG: u32 = 0o100000;
pub const S_IFLNK: u32 = 0o120000;

/// File metadata as reported by the device. Fields only `stat_v2` carries
/// are `None` on devices without `stat_v2` / `ls_v2`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStat {
    pub mode: u32,
    pub size: u64,
    /// Seconds since the Unix epoch.
    pub mtime: i64,
    pub uid: Option<u32>,
    pub gid: Option<u32>,
}

impl RemoteStat {
    pub fn file_type(&self) -> u32 {
        self.mode & S_IFMT
    }
    pub fn is_dir(&self) -> bool {
        self.file_type() == S_IFDIR
    }
    pub fn is_file(&self) -> bool {
        self.file_type() == S_IFREG
    }
    pub fn is_symlink(&self) -> bool {
        self.file_type() == S_IFLNK
    }
}

/// One `LIST`/`LIS2` record. `error` is set (v2 only) when the device could
/// not `lstat` the entry; its `stat` is then all zeros.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteDirEntry {
    pub name: String,
    pub stat: RemoteStat,
    pub error: Option<u32>,
}

/// Device sync features, from `host-serial:<serial>:features`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SyncFeatures {
    pub stat_v2: bool,
    pub ls_v2: bool,
}

impl SyncFeatures {
    pub fn parse(features: &str) -> Self {
        let has = |name: &str| features.split(',').any(|f| f.trim() == name);
        Self {
            stat_v2: has("stat_v2"),
            ls_v2: has("ls_v2"),
        }
    }
}

/// Comma-separated feature list the device advertised to the server.
pub async fn device_features(server: &AdbServer, serial: &str) -> AppResult<String> {
    let mut stream = server
        .open(&format!("host-serial:{serial}:features"))
        .await?;
    read_length_prefixed(&mut stream).await
}

/// An open `sync:` session. Requests are strictly sequential; if a
/// streaming request (`RECV`, `SEND`) is abandoned half-way the session is
/// out of step and must be dropped.
pub struct SyncConn<S> {
    stream: S,
    features: SyncFeatures,
    buf: Vec<u8>,
}

impl SyncConn<TcpStream> {
    /// Detects the device's sync features and opens `sync:` on it.
    pub async fn open(server: &AdbServer, serial: &str) -> AppResult<Self> {
        let features = SyncFeatures::parse(&device_features(server, serial).await?);
        let stream = server.open_device(serial, "sync:").await?;
        Ok(Self::new(stream, features))
    }
}

impl<S: AsyncRead + AsyncWrite + Unpin> SyncConn<S> {
    pub fn new(stream: S, features: SyncFeatures) -> Self {
        Self {
            stream,
            features,
            buf: Vec::with_capacity(DATA_MAX),
        }
    }

    pub fn features(&self) -> SyncFeatures {
        self.features
    }

    async fn send_request(&mut self, id: &[u8; 4], payload: &[u8]) -> AppResult<()> {
        let len = u32::try_from(payload.len())
            .map_err(|_| AppError::InvalidInput("sync payload too large".into()))?;
        let mut msg = Vec::with_capacity(8 + payload.len());
        msg.extend_from_slice(id);
        msg.extend_from_slice(&len.to_le_bytes());
        msg.extend_from_slice(payload);
        self.stream.write_all(&msg).await?;
        Ok(())
    }

    async fn send_path_request(&mut self, id: &[u8; 4], path: &str) -> AppResult<()> {
        check_path(path)?;
        self.send_request(id, path.as_bytes()).await
    }

    async fn read_id(&mut self) -> AppResult<[u8; 4]> {
        let mut id = [0u8; 4];
        self.stream.read_exact(&mut id).await?;
        Ok(id)
    }

    async fn read_u32(&mut self) -> AppResult<u32> {
        let mut b = [0u8; 4];
        self.stream.read_exact(&mut b).await?;
        Ok(u32::from_le_bytes(b))
    }

    async fn read_u64(&mut self) -> AppResult<u64> {
        let mut b = [0u8; 8];
        self.stream.read_exact(&mut b).await?;
        Ok(u64::from_le_bytes(b))
    }

    async fn read_name(&mut self, len: u32) -> AppResult<String> {
        if len as usize > PATH_MAX * 4 {
            return Err(AppError::Protocol(format!("sync name too long: {len}")));
        }
        let mut name = vec![0u8; len as usize];
        self.stream.read_exact(&mut name).await?;
        Ok(String::from_utf8_lossy(&name).into_owned())
    }

    /// Reads the message of a `FAIL` whose id was already consumed.
    async fn read_fail(&mut self) -> AppError {
        let message = async {
            let len = self.read_u32().await?;
            self.read_name(len).await
        }
        .await;
        match message {
            Ok(message) => AppError::Device(message),
            Err(e) => e,
        }
    }

    fn unexpected(id: &[u8; 4]) -> AppError {
        AppError::Protocol(format!(
            "unexpected sync id {:?}",
            String::from_utf8_lossy(id)
        ))
    }

    /// Lists a directory, `.` and `..` included. A directory the device
    /// cannot open yields an empty list (the protocol reports no error), so
    /// the absence of `.` means "not readable".
    pub async fn list(&mut self, path: &str) -> AppResult<Vec<RemoteDirEntry>> {
        if self.features.ls_v2 {
            self.list_v2(path).await
        } else {
            self.list_v1(path).await
        }
    }

    async fn list_v1(&mut self, path: &str) -> AppResult<Vec<RemoteDirEntry>> {
        self.send_path_request(ID_LIST, path).await?;
        let mut entries = Vec::new();
        loop {
            let id = self.read_id().await?;
            if &id == ID_FAIL {
                return Err(self.read_fail().await);
            }
            if &id != ID_DENT && &id != ID_DONE {
                return Err(Self::unexpected(&id));
            }
            let mode = self.read_u32().await?;
            let size = self.read_u32().await?;
            let mtime = self.read_u32().await?;
            let namelen = self.read_u32().await?;
            let name = self.read_name(namelen).await?;
            if &id == ID_DONE {
                return Ok(entries);
            }
            entries.push(RemoteDirEntry {
                name,
                stat: RemoteStat {
                    mode,
                    size: size.into(),
                    mtime: mtime.into(),
                    uid: None,
                    gid: None,
                },
                error: None,
            });
        }
    }

    async fn list_v2(&mut self, path: &str) -> AppResult<Vec<RemoteDirEntry>> {
        self.send_path_request(ID_LIS2, path).await?;
        let mut entries = Vec::new();
        loop {
            let id = self.read_id().await?;
            if &id == ID_FAIL {
                return Err(self.read_fail().await);
            }
            if &id != ID_DNT2 && &id != ID_DONE {
                return Err(Self::unexpected(&id));
            }
            let (error, stat) = self.read_stat_v2_body().await?;
            let namelen = self.read_u32().await?;
            let name = self.read_name(namelen).await?;
            if &id == ID_DONE {
                return Ok(entries);
            }
            entries.push(RemoteDirEntry {
                name,
                stat,
                error: (error != 0).then_some(error),
            });
        }
    }

    /// The 68 bytes of `stat_v2` / `dent_v2` after the id.
    async fn read_stat_v2_body(&mut self) -> AppResult<(u32, RemoteStat)> {
        let error = self.read_u32().await?;
        let _dev = self.read_u64().await?;
        let _ino = self.read_u64().await?;
        let mode = self.read_u32().await?;
        let _nlink = self.read_u32().await?;
        let uid = self.read_u32().await?;
        let gid = self.read_u32().await?;
        let size = self.read_u64().await?;
        let _atime = self.read_u64().await?;
        let mtime = self.read_u64().await? as i64;
        let _ctime = self.read_u64().await?;
        Ok((
            error,
            RemoteStat {
                mode,
                size,
                mtime,
                uid: Some(uid),
                gid: Some(gid),
            },
        ))
    }

    /// `stat` that follows symlinks. Returns `Ok(None)` when the path does
    /// not exist. Without `stat_v2` this falls back to `lstat`, except that
    /// a trailing `/` still resolves links that point to directories.
    pub async fn stat(&mut self, path: &str) -> AppResult<Option<RemoteStat>> {
        if self.features.stat_v2 {
            self.stat_v2(ID_STA2, path).await
        } else {
            self.stat_v1(path).await
        }
    }

    /// `stat` that does not follow symlinks.
    pub async fn lstat(&mut self, path: &str) -> AppResult<Option<RemoteStat>> {
        if self.features.stat_v2 {
            self.stat_v2(ID_LST2, path).await
        } else {
            self.stat_v1(path).await
        }
    }

    async fn stat_v1(&mut self, path: &str) -> AppResult<Option<RemoteStat>> {
        self.send_path_request(ID_STAT, path).await?;
        let id = self.read_id().await?;
        if &id == ID_FAIL {
            return Err(self.read_fail().await);
        }
        if &id != ID_STAT {
            return Err(Self::unexpected(&id));
        }
        let mode = self.read_u32().await?;
        let size = self.read_u32().await?;
        let mtime = self.read_u32().await?;
        Ok((mode != 0).then_some(RemoteStat {
            mode,
            size: size.into(),
            mtime: mtime.into(),
            uid: None,
            gid: None,
        }))
    }

    async fn stat_v2(&mut self, request: &[u8; 4], path: &str) -> AppResult<Option<RemoteStat>> {
        self.send_path_request(request, path).await?;
        let id = self.read_id().await?;
        if &id == ID_FAIL {
            return Err(self.read_fail().await);
        }
        if &id != request {
            return Err(Self::unexpected(&id));
        }
        let (error, stat) = self.read_stat_v2_body().await?;
        match error {
            0 => Ok(Some(stat)),
            ENOENT | ENOTDIR => Ok(None),
            EACCES => Err(AppError::Device(format!("{path}: permission denied"))),
            other => Err(AppError::Device(format!(
                "{path}: stat failed (errno {other})"
            ))),
        }
    }

    /// Starts downloading `path`; read it with [`Self::recv_chunk`].
    pub async fn recv_start(&mut self, path: &str) -> AppResult<()> {
        self.send_path_request(ID_RECV, path).await
    }

    /// Next chunk of a `RECV`, or `None` once the file is complete. The
    /// slice is valid until the next call.
    pub async fn recv_chunk(&mut self) -> AppResult<Option<&[u8]>> {
        let id = self.read_id().await?;
        match &id {
            ID_DATA => {
                let len = self.read_u32().await? as usize;
                if len > DATA_MAX {
                    return Err(AppError::Protocol(format!("sync chunk too large: {len}")));
                }
                self.buf.resize(len, 0);
                self.stream.read_exact(&mut self.buf).await?;
                Ok(Some(&self.buf))
            }
            ID_DONE => {
                self.read_u32().await?;
                Ok(None)
            }
            ID_FAIL => Err(self.read_fail().await),
            other => Err(Self::unexpected(other)),
        }
    }

    /// Downloads a whole file into memory.
    pub async fn recv_to_vec(&mut self, path: &str) -> AppResult<Vec<u8>> {
        self.recv_start(path).await?;
        let mut out = Vec::new();
        while let Some(chunk) = self.recv_chunk().await? {
            out.extend_from_slice(chunk);
        }
        Ok(out)
    }

    /// Starts uploading to `path`. `mode` is a full `st_mode`
    /// (`S_IFREG | 0o644`); the device creates missing parent directories.
    pub async fn send_start(&mut self, path: &str, mode: u32) -> AppResult<()> {
        check_path(path)?;
        let spec = format!("{path},{mode}");
        if spec.len() > PATH_MAX {
            return Err(AppError::InvalidInput(format!("path is too long: {path}")));
        }
        self.send_request(ID_SEND, spec.as_bytes()).await
    }

    /// Streams file content, split into `DATA` messages of at most 64 KiB.
    pub async fn send_data(&mut self, data: &[u8]) -> AppResult<()> {
        for chunk in data.chunks(DATA_MAX) {
            self.send_request(ID_DATA, chunk).await?;
        }
        Ok(())
    }

    /// Finishes a `SEND`, setting the file's mtime (Unix seconds), and waits
    /// for the device to confirm the write.
    pub async fn send_finish(&mut self, mtime: u32) -> AppResult<()> {
        let mut msg = [0u8; 8];
        msg[..4].copy_from_slice(ID_DONE);
        msg[4..].copy_from_slice(&mtime.to_le_bytes());
        self.stream.write_all(&msg).await?;
        self.read_send_status().await
    }

    /// Reads the `OKAY`/`FAIL` that ends a `SEND`. Also useful after a
    /// failed write: the device sends `FAIL` and closes when it cannot store
    /// the data (no space, permission denied).
    pub async fn read_send_status(&mut self) -> AppResult<()> {
        let id = self.read_id().await?;
        match &id {
            ID_OKAY => {
                self.read_u32().await?;
                Ok(())
            }
            ID_FAIL => Err(self.read_fail().await),
            other => Err(Self::unexpected(other)),
        }
    }

    /// Ends the session politely.
    pub async fn quit(mut self) -> AppResult<()> {
        self.send_request(ID_QUIT, &[]).await?;
        self.stream.shutdown().await.ok();
        Ok(())
    }
}

fn check_path(path: &str) -> AppResult<()> {
    if path.is_empty() {
        return Err(AppError::InvalidInput("empty path".into()));
    }
    if path.len() > PATH_MAX {
        return Err(AppError::InvalidInput(format!("path is too long: {path}")));
    }
    if path.contains('\0') {
        return Err(AppError::InvalidInput("path contains a NUL byte".into()));
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use tokio::io::{DuplexStream, duplex};

    const V1: SyncFeatures = SyncFeatures {
        stat_v2: false,
        ls_v2: false,
    };
    const V2: SyncFeatures = SyncFeatures {
        stat_v2: true,
        ls_v2: true,
    };

    fn le(v: u32) -> [u8; 4] {
        v.to_le_bytes()
    }

    pub(crate) fn dent_v1(id: &[u8; 4], mode: u32, size: u32, mtime: u32, name: &str) -> Vec<u8> {
        let mut m = id.to_vec();
        for v in [mode, size, mtime, name.len() as u32] {
            m.extend_from_slice(&le(v));
        }
        m.extend_from_slice(name.as_bytes());
        m
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn stat_v2_body(
        error: u32,
        mode: u32,
        uid: u32,
        gid: u32,
        size: u64,
        mtime: i64,
    ) -> Vec<u8> {
        let mut m = Vec::new();
        m.extend_from_slice(&le(error));
        m.extend_from_slice(&0xfd00u64.to_le_bytes()); // dev
        m.extend_from_slice(&4242u64.to_le_bytes()); // ino
        m.extend_from_slice(&le(mode));
        m.extend_from_slice(&le(1)); // nlink
        m.extend_from_slice(&le(uid));
        m.extend_from_slice(&le(gid));
        m.extend_from_slice(&size.to_le_bytes());
        m.extend_from_slice(&mtime.to_le_bytes()); // atime
        m.extend_from_slice(&mtime.to_le_bytes());
        m.extend_from_slice(&mtime.to_le_bytes()); // ctime
        m
    }

    pub(crate) fn dent_v2(id: &[u8; 4], mode: u32, size: u64, mtime: i64, name: &str) -> Vec<u8> {
        let mut m = id.to_vec();
        m.extend(stat_v2_body(0, mode, 1023, 1023, size, mtime));
        m.extend_from_slice(&le(name.len() as u32));
        m.extend_from_slice(name.as_bytes());
        m
    }

    /// Reads one request (id + payload) from the fake device side.
    pub(crate) async fn read_req(dev: &mut DuplexStream) -> (String, Vec<u8>) {
        let mut id = [0u8; 4];
        dev.read_exact(&mut id).await.unwrap();
        let mut len = [0u8; 4];
        dev.read_exact(&mut len).await.unwrap();
        let mut payload = vec![0u8; u32::from_le_bytes(len) as usize];
        dev.read_exact(&mut payload).await.unwrap();
        (String::from_utf8_lossy(&id).into_owned(), payload)
    }

    #[test]
    fn parses_features() {
        let f = SyncFeatures::parse("shell_v2,cmd,stat_v2,ls_v2,fixed_push_mkdir,apex");
        assert_eq!(f, V2);
        assert_eq!(SyncFeatures::parse("shell_v2,cmd"), V1);
        assert_eq!(SyncFeatures::parse(""), V1);
    }

    #[tokio::test]
    async fn list_v1_reads_dents_until_done() {
        let (client, mut dev) = duplex(4096);
        let device = tokio::spawn(async move {
            let (id, path) = read_req(&mut dev).await;
            assert_eq!(id, "LIST");
            assert_eq!(path, b"/sdcard/DCIM");
            let mut out = Vec::new();
            out.extend(dent_v1(ID_DENT, S_IFDIR | 0o771, 4096, 1_761_300_000, "."));
            out.extend(dent_v1(ID_DENT, S_IFDIR | 0o771, 4096, 1_761_300_000, ".."));
            out.extend(dent_v1(
                ID_DENT,
                S_IFREG | 0o660,
                4_123_456,
                1_761_419_404,
                "PXL_20261025_193004121.jpg",
            ));
            out.extend(dent_v1(ID_DONE, 0, 0, 0, ""));
            dev.write_all(&out).await.unwrap();
            dev
        });

        let mut conn = SyncConn::new(client, V1);
        let entries = conn.list("/sdcard/DCIM").await.unwrap();
        device.await.unwrap();
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[2].name, "PXL_20261025_193004121.jpg");
        assert!(entries[2].stat.is_file());
        assert_eq!(entries[2].stat.size, 4_123_456);
        assert_eq!(entries[2].stat.uid, None);
        assert!(entries[0].stat.is_dir());
    }

    #[tokio::test]
    async fn list_v2_reads_large_sizes_and_errors() {
        let (client, mut dev) = duplex(4096);
        tokio::spawn(async move {
            let (id, _) = read_req(&mut dev).await;
            assert_eq!(id, "LIS2");
            let mut out = Vec::new();
            out.extend(dent_v2(
                ID_DNT2,
                S_IFREG | 0o660,
                5_000_000_000,
                1_761_419_404,
                "big.mp4",
            ));
            let mut broken = ID_DNT2.to_vec();
            broken.extend(stat_v2_body(EACCES, 0, 0, 0, 0, 0));
            broken.extend_from_slice(&le(6));
            broken.extend_from_slice(b"secret");
            out.extend(broken);
            out.extend(dent_v2(ID_DONE, 0, 0, 0, ""));
            dev.write_all(&out).await.unwrap();
            dev
        });

        let mut conn = SyncConn::new(client, V2);
        let entries = conn.list("/sdcard").await.unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].stat.size, 5_000_000_000);
        assert_eq!(entries[0].stat.uid, Some(1023));
        assert_eq!(entries[0].error, None);
        assert_eq!(entries[1].name, "secret");
        assert_eq!(entries[1].error, Some(EACCES));
    }

    #[tokio::test]
    async fn stat_v1_missing_file_is_none() {
        let (client, mut dev) = duplex(4096);
        tokio::spawn(async move {
            let (id, _) = read_req(&mut dev).await;
            assert_eq!(id, "STAT");
            let mut out = ID_STAT.to_vec();
            out.extend([0u8; 12]);
            dev.write_all(&out).await.unwrap();
            let (_, path) = read_req(&mut dev).await;
            assert_eq!(path, b"/sdcard/a.txt");
            let mut out = ID_STAT.to_vec();
            for v in [S_IFREG | 0o644, 12, 1_700_000_000] {
                out.extend_from_slice(&le(v));
            }
            dev.write_all(&out).await.unwrap();
            dev
        });

        let mut conn = SyncConn::new(client, V1);
        assert_eq!(conn.stat("/nope").await.unwrap(), None);
        let st = conn.stat("/sdcard/a.txt").await.unwrap().unwrap();
        assert!(st.is_file());
        assert_eq!(st.size, 12);
        assert_eq!(st.mtime, 1_700_000_000);
    }

    #[tokio::test]
    async fn stat_v2_maps_errno() {
        let (client, mut dev) = duplex(4096);
        tokio::spawn(async move {
            for (expected, error) in [("STA2", ENOENT), ("LST2", EACCES), ("STA2", 0)] {
                let (id, _) = read_req(&mut dev).await;
                assert_eq!(id, expected);
                let mut out = id.as_bytes().to_vec();
                out.extend(stat_v2_body(error, S_IFDIR | 0o771, 0, 1015, 3452, 7));
                dev.write_all(&out).await.unwrap();
            }
            dev
        });

        let mut conn = SyncConn::new(client, V2);
        assert_eq!(conn.stat("/x").await.unwrap(), None);
        assert!(
            matches!(conn.lstat("/data").await, Err(AppError::Device(m)) if m.contains("permission denied"))
        );
        let st = conn.stat("/sdcard").await.unwrap().unwrap();
        assert!(st.is_dir());
        assert_eq!(st.gid, Some(1015));
    }

    #[tokio::test]
    async fn recv_collects_chunks() {
        let (client, mut dev) = duplex(1 << 20);
        tokio::spawn(async move {
            let (id, path) = read_req(&mut dev).await;
            assert_eq!(id, "RECV");
            assert_eq!(path, b"/data/local/tmp/x.bin");
            let mut out = Vec::new();
            for part in [&b"hello "[..], &b"world"[..]] {
                out.extend_from_slice(ID_DATA);
                out.extend_from_slice(&le(part.len() as u32));
                out.extend_from_slice(part);
            }
            out.extend_from_slice(ID_DONE);
            out.extend_from_slice(&le(0));
            dev.write_all(&out).await.unwrap();
            dev
        });

        let mut conn = SyncConn::new(client, V1);
        let data = conn.recv_to_vec("/data/local/tmp/x.bin").await.unwrap();
        assert_eq!(data, b"hello world");
    }

    #[tokio::test]
    async fn recv_fail_carries_message() {
        let (client, mut dev) = duplex(4096);
        tokio::spawn(async move {
            read_req(&mut dev).await;
            let msg = b"open failed: Permission denied";
            let mut out = ID_FAIL.to_vec();
            out.extend_from_slice(&le(msg.len() as u32));
            out.extend_from_slice(msg);
            dev.write_all(&out).await.unwrap();
            dev
        });

        let mut conn = SyncConn::new(client, V1);
        let err = conn.recv_to_vec("/data/system/x").await.unwrap_err();
        assert!(matches!(err, AppError::Device(m) if m == "open failed: Permission denied"));
    }

    #[tokio::test]
    async fn send_splits_data_and_sends_mtime() {
        let (client, mut dev) = duplex(1 << 20);
        let device = tokio::spawn(async move {
            let (id, spec) = read_req(&mut dev).await;
            assert_eq!(id, "SEND");
            assert_eq!(
                spec,
                format!("/sdcard/a b.bin,{}", S_IFREG | 0o644).as_bytes()
            );
            let mut sizes = Vec::new();
            loop {
                let (id, payload) = read_req(&mut dev).await;
                if id == "DONE" {
                    // DONE carries the mtime in the length field, no payload.
                    break;
                }
                assert_eq!(id, "DATA");
                sizes.push(payload.len());
            }
            dev.write_all(b"OKAY\0\0\0\0").await.unwrap();
            sizes
        });

        let mut conn = SyncConn::new(client, V1);
        conn.send_start("/sdcard/a b.bin", S_IFREG | 0o644)
            .await
            .unwrap();
        conn.send_data(&vec![7u8; DATA_MAX * 2 + 10]).await.unwrap();
        // DONE with mtime 0 has no payload, so the fake reads it as empty.
        conn.send_finish(0).await.unwrap();
        assert_eq!(device.await.unwrap(), vec![DATA_MAX, DATA_MAX, 10]);
    }

    #[tokio::test]
    async fn send_finish_writes_mtime_and_reports_fail() {
        let (client, mut dev) = duplex(4096);
        let device = tokio::spawn(async move {
            read_req(&mut dev).await;
            let mut done = [0u8; 8];
            dev.read_exact(&mut done).await.unwrap();
            let msg = b"No space left on device";
            let mut out = ID_FAIL.to_vec();
            out.extend_from_slice(&le(msg.len() as u32));
            out.extend_from_slice(msg);
            dev.write_all(&out).await.unwrap();
            done
        });

        let mut conn = SyncConn::new(client, V1);
        conn.send_start("/sdcard/f", S_IFREG | 0o600).await.unwrap();
        let err = conn.send_finish(1_761_419_404).await.unwrap_err();
        let done = device.await.unwrap();
        assert_eq!(&done[..4], b"DONE");
        assert_eq!(
            u32::from_le_bytes(done[4..].try_into().unwrap()),
            1_761_419_404
        );
        assert!(matches!(err, AppError::Device(m) if m.contains("No space")));
    }

    #[tokio::test]
    async fn rejects_bad_paths() {
        let (client, _dev) = duplex(64);
        let mut conn = SyncConn::new(client, V1);
        assert!(matches!(
            conn.stat("").await,
            Err(AppError::InvalidInput(_))
        ));
        let long = "/".repeat(PATH_MAX + 1);
        assert!(matches!(
            conn.list(&long).await,
            Err(AppError::InvalidInput(_))
        ));
        assert!(matches!(
            conn.recv_start("a\0b").await,
            Err(AppError::InvalidInput(_))
        ));
    }

    #[tokio::test]
    async fn quit_sends_quit() {
        let (client, mut dev) = duplex(64);
        let conn = SyncConn::new(client, V1);
        conn.quit().await.unwrap();
        let (id, payload) = read_req(&mut dev).await;
        assert_eq!(id, "QUIT");
        assert!(payload.is_empty());
    }
}
