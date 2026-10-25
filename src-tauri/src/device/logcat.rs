//! Logcat streaming and parsing.
//!
//! The stream runs `logcat -v long -v year -v uid`. Unlike `threadtime`,
//! `long` prints one bracketed header per log call followed by the message
//! and a blank line, so multi-line messages (stack traces, dumps) stay one
//! entry and separate calls in the same millisecond are not merged:
//!
//! ```text
//! [ 2026-10-25 23:44:02.346 10230: 6230: 6230 E/AndroidRuntime ]
//! FATAL EXCEPTION: main
//! Process: com.ytheekshana.apkextractor, PID: 6230
//!
//! ```
//!
//! Entries are annotated with crash markers (Java `FATAL EXCEPTION`, ANR,
//! native tombstones) and `ActivityManager` process start/death events so
//! the UI can follow an app across restarts.

use std::time::Duration;

use serde::Serialize;
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::adb::server::AdbServer;
use crate::error::{AppError, AppResult};

/// Ring buffers `logcat -b` accepts that we expose in the UI.
pub const BUFFERS: &[&str] = &[
    "main", "system", "crash", "events", "radio", "kernel", "all", "default",
];

/// How often parsed entries are flushed to the UI.
pub const FLUSH_INTERVAL: Duration = Duration::from_millis(50);
/// A batch is sent early once it grows this large.
pub const MAX_BATCH: usize = 2000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum Level {
    V,
    D,
    I,
    W,
    E,
    F,
}

impl Level {
    fn parse(c: char) -> Option<Self> {
        Some(match c {
            'V' => Self::V,
            'D' => Self::D,
            'I' => Self::I,
            'W' => Self::W,
            'E' => Self::E,
            // `A` (assert) is logged as fatal.
            'F' | 'A' => Self::F,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CrashKind {
    /// Uncaught Java/Kotlin exception (`AndroidRuntime: FATAL EXCEPTION`).
    Java,
    /// Native crash tombstone printed by `crash_dump` (`DEBUG` tag).
    Native,
    /// Application not responding (`ActivityManager: ANR in …`).
    Anr,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Crash {
    pub kind: CrashKind,
    /// Exception line, signal line or ANR reason.
    pub title: String,
    /// Package / process name of the crashed app, when printed.
    pub process: Option<String>,
    pub pid: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProcessEventKind {
    Started,
    Died,
}

/// A process start or death reported by `ActivityManager`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessEvent {
    pub kind: ProcessEventKind,
    pub pid: u32,
    /// Process name, e.g. `com.example.shop` or `com.example.shop:remote`.
    pub process: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    /// Monotonic number within one stream session.
    pub seq: u64,
    /// Device-local date, `YYYY-MM-DD`.
    pub date: String,
    /// Device-local time, `HH:MM:SS.mmm`.
    pub time: String,
    /// Numeric uid, or a name for well-known system uids (`root`, `radio`).
    pub uid: String,
    pub pid: u32,
    pub tid: u32,
    pub level: Level,
    pub tag: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub crash: Option<Crash>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub process_event: Option<ProcessEvent>,
}

/// Header fields of one `-v long` entry.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Header {
    date: String,
    time: String,
    uid: String,
    pid: u32,
    tid: u32,
    level: Level,
    tag: String,
}

/// Parses `[ 2026-10-25 23:44:02.346 10230: 6230: 6230 E/AndroidRuntime ]`.
fn parse_header(line: &str) -> Option<Header> {
    let inner = line.strip_prefix("[ ")?.trim_end().strip_suffix(']')?;
    let mut rest = inner.trim_start();

    let mut next_token = || {
        let s = rest.trim_start();
        let end = s.find(char::is_whitespace).unwrap_or(s.len());
        let (token, tail) = s.split_at(end);
        rest = tail;
        token
    };
    let date = next_token();
    let time = next_token();
    if !is_date(date) || !is_time(time) {
        return None;
    }
    // `uid: pid: tid` with padding after each colon.
    let uid = next_token().strip_suffix(':')?.to_owned();
    let pid = next_token().strip_suffix(':')?.parse().ok()?;
    let tid = next_token().parse().ok()?;

    // `E/AndroidRuntime ` — the tag is padded and may contain spaces.
    let level_tag = rest.trim_start();
    let mut chars = level_tag.chars();
    let level = Level::parse(chars.next()?)?;
    let tag = chars.as_str().strip_prefix('/')?.trim_end().to_owned();

    Some(Header {
        date: date.to_owned(),
        time: time.to_owned(),
        uid,
        pid,
        tid,
        level,
        tag,
    })
}

fn is_date(s: &str) -> bool {
    s.len() == 10 && s.bytes().all(|b| b.is_ascii_digit() || b == b'-')
}

fn is_time(s: &str) -> bool {
    s.len() >= 8
        && s.bytes()
            .all(|b| b.is_ascii_digit() || b == b':' || b == b'.')
}

/// Incremental `-v long` parser: feed lines, get finished entries.
#[derive(Debug, Default)]
pub struct Parser {
    pending: Option<(Header, Vec<String>)>,
    grouper: Grouper,
    next_seq: u64,
}

impl Parser {
    /// Feeds one line (without the trailing newline). Returns entries that
    /// became complete.
    pub fn push_line(&mut self, line: &str, out: &mut Vec<LogEntry>) {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.starts_with("--------- ") {
            // `--------- beginning of main` buffer separators.
            return;
        }
        if line.starts_with("[ ")
            && let Some(header) = parse_header(line)
        {
            self.finish_pending(out);
            self.pending = Some((header, Vec::new()));
            return;
        }
        if let Some((_, lines)) = &mut self.pending {
            lines.push(line.to_owned());
        }
    }

    /// Completes the entry being read and any open group. Called when the
    /// stream goes idle, so the last line shows up without waiting for the
    /// next one.
    pub fn flush(&mut self, out: &mut Vec<LogEntry>) {
        self.finish_pending(out);
        if let Some(entry) = self.grouper.flush() {
            self.emit(entry, out);
        }
    }

    pub fn has_pending(&self) -> bool {
        self.pending.is_some() || self.grouper.open.is_some()
    }

    fn finish_pending(&mut self, out: &mut Vec<LogEntry>) {
        let Some((header, mut lines)) = self.pending.take() else {
            return;
        };
        // Every message is followed by one blank line; messages that end in
        // `\n` themselves get two.
        while lines.last().is_some_and(|l| l.is_empty()) {
            lines.pop();
        }
        let entry = LogEntry {
            seq: 0,
            date: header.date,
            time: header.time,
            uid: header.uid,
            pid: header.pid,
            tid: header.tid,
            level: header.level,
            tag: header.tag,
            message: lines.join("\n"),
            crash: None,
            process_event: None,
        };
        let mut emitted = Vec::new();
        self.grouper.push(entry, &mut emitted);
        for entry in emitted {
            self.emit(entry, out);
        }
    }

    fn emit(&mut self, mut entry: LogEntry, out: &mut Vec<LogEntry>) {
        entry.seq = self.next_seq;
        self.next_seq += 1;
        annotate(&mut entry);
        out.push(entry);
    }
}

/// Merges a native crash tombstone, which `crash_dump` logs as one
/// `F/DEBUG` entry per line, into a single entry.
#[derive(Debug, Default)]
struct Grouper {
    open: Option<LogEntry>,
}

const TOMBSTONE_START: &str = "*** *** *** *** *** *** *** *** *** *** *** *** *** *** *** ***";

impl Grouper {
    fn push(&mut self, entry: LogEntry, out: &mut Vec<LogEntry>) {
        if let Some(open) = &mut self.open {
            if is_tombstone_line(&entry)
                && entry.pid == open.pid
                && entry.message != TOMBSTONE_START
            {
                open.message.push('\n');
                open.message.push_str(&entry.message);
                return;
            }
            out.extend(self.open.take());
        }
        if is_tombstone_line(&entry) && entry.message == TOMBSTONE_START {
            self.open = Some(entry);
        } else {
            out.push(entry);
        }
    }

    fn flush(&mut self) -> Option<LogEntry> {
        self.open.take()
    }
}

fn is_tombstone_line(entry: &LogEntry) -> bool {
    entry.level == Level::F && entry.tag == "DEBUG"
}

fn annotate(entry: &mut LogEntry) {
    entry.crash = detect_crash(entry);
    if entry.tag == "ActivityManager" {
        entry.process_event = parse_process_event(&entry.message);
    }
}

fn detect_crash(entry: &LogEntry) -> Option<Crash> {
    let msg = &entry.message;
    match (entry.level, entry.tag.as_str()) {
        (Level::E, "AndroidRuntime") if msg.starts_with("FATAL EXCEPTION") => {
            let mut process = None;
            let mut pid = None;
            let mut title = None;
            for line in msg.lines().skip(1) {
                if let Some(rest) = line.strip_prefix("Process: ") {
                    // `Process: com.example.shop, PID: 4821`
                    let (name, tail) = rest.split_once(", PID: ").unwrap_or((rest, ""));
                    process = Some(name.trim().to_owned());
                    pid = tail.trim().parse().ok();
                } else if !line.trim().is_empty() {
                    title = Some(line.trim().to_owned());
                    break;
                }
            }
            Some(Crash {
                kind: CrashKind::Java,
                title: title.unwrap_or_else(|| first_line(msg).to_owned()),
                process,
                pid: pid.or(Some(entry.pid)),
            })
        }
        (Level::E, "ActivityManager") if msg.starts_with("ANR in ") => {
            // `ANR in com.example.shop (com.example.shop/.MainActivity)`
            let first = first_line(msg);
            let process = first["ANR in ".len()..]
                .split_whitespace()
                .next()
                .map(str::to_owned);
            let mut pid = None;
            let mut reason = None;
            for line in msg.lines().skip(1) {
                if let Some(p) = line.strip_prefix("PID: ") {
                    pid = p.trim().parse().ok();
                } else if let Some(r) = line.strip_prefix("Reason: ") {
                    reason = Some(r.trim().to_owned());
                }
            }
            Some(Crash {
                kind: CrashKind::Anr,
                title: reason.unwrap_or_else(|| first.to_owned()),
                process,
                pid,
            })
        }
        (Level::F, "DEBUG") if msg.starts_with(TOMBSTONE_START) => {
            let mut process = None;
            let mut pid = None;
            let mut signal = None;
            let mut abort = None;
            for line in msg.lines() {
                // `pid: 2517, tid: 2926, name: greco  >>> com.google.android.tts <<<`
                if let Some(rest) = line.strip_prefix("pid: ") {
                    pid = rest.split(',').next().and_then(|p| p.trim().parse().ok());
                    process = rest
                        .split_once(">>> ")
                        .and_then(|(_, r)| r.split_once(" <<<"))
                        .map(|(name, _)| name.to_owned());
                } else if signal.is_none() && line.starts_with("signal ") {
                    signal = Some(line.trim().to_owned());
                } else if abort.is_none() && line.starts_with("Abort message: ") {
                    // More telling than `signal 6 (SIGABRT)`.
                    abort = Some(line.trim().to_owned());
                }
            }
            Some(Crash {
                kind: CrashKind::Native,
                title: abort
                    .or(signal)
                    .unwrap_or_else(|| "Native crash".to_owned()),
                process,
                pid,
            })
        }
        _ => None,
    }
}

fn first_line(s: &str) -> &str {
    s.lines().next().unwrap_or("")
}

/// Recognises `ActivityManager` process lifecycle lines:
///
/// ```text
/// Start proc 7763:com.example.shop/u0a230 for service {com.example.shop/…}
/// Process com.example.shop (pid 6230) has died: fg  TOP
/// Killing 6230:com.example.shop/u0a230 (adj 900): remove task
/// ```
pub fn parse_process_event(message: &str) -> Option<ProcessEvent> {
    let line = first_line(message);
    if let Some(rest) = line.strip_prefix("Start proc ") {
        let (spec, _) = rest.split_once(" for ").unwrap_or((rest, ""));
        let (pid, name_uid) = spec.split_once(':')?;
        let (name, _uid) = name_uid.rsplit_once('/')?;
        return Some(ProcessEvent {
            kind: ProcessEventKind::Started,
            pid: pid.trim().parse().ok()?,
            process: name.to_owned(),
        });
    }
    if let Some(rest) = line.strip_prefix("Process ") {
        let (name, tail) = rest.split_once(" (pid ")?;
        let (pid, tail) = tail.split_once(')')?;
        if !tail.trim_start().starts_with("has died") {
            return None;
        }
        return Some(ProcessEvent {
            kind: ProcessEventKind::Died,
            pid: pid.trim().parse().ok()?,
            process: name.to_owned(),
        });
    }
    if let Some(rest) = line.strip_prefix("Killing ") {
        let (spec, _) = rest.split_once(' ')?;
        let (pid, name_uid) = spec.split_once(':')?;
        let (name, _uid) = name_uid.rsplit_once('/')?;
        return Some(ProcessEvent {
            kind: ProcessEventKind::Died,
            pid: pid.trim().parse().ok()?,
            process: name.to_owned(),
        });
    }
    None
}

/// What to stream.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamOptions {
    /// Buffers for `-b`; empty means logcat's default set.
    #[serde(default)]
    pub buffers: Vec<String>,
    /// Backlog: print the most recent N lines first (`-T N`).
    pub tail: Option<u32>,
    /// Backlog: print lines since this device time, `YYYY-MM-DD hh:mm:ss.mmm`
    /// (`-T '<time>'`). Takes precedence over `tail`; used to resume after a
    /// reconnect without losing or repeating much.
    pub since: Option<String>,
}

/// Builds the `logcat` command line, validating every user-supplied part
/// because it goes through the device shell.
pub fn stream_command(opts: &StreamOptions) -> AppResult<String> {
    let mut cmd = String::from("logcat -v long -v year -v uid");
    let buffers = validate_buffers(&opts.buffers)?;
    if !buffers.is_empty() {
        cmd.push_str(" -b ");
        cmd.push_str(&buffers.join(","));
    }
    if let Some(since) = &opts.since {
        let valid = since.len() <= 32
            && since
                .bytes()
                .all(|b| b.is_ascii_digit() || matches!(b, b'-' | b':' | b'.' | b' '));
        if !valid {
            return Err(AppError::InvalidInput(format!("bad logcat time {since:?}")));
        }
        cmd.push_str(&format!(" -T '{since}'"));
    } else if let Some(tail) = opts.tail {
        // `-T 0` is rejected by logcat; 1 is the smallest backlog.
        cmd.push_str(&format!(" -T {}", tail.max(1)));
    }
    Ok(cmd)
}

fn validate_buffers(buffers: &[String]) -> AppResult<Vec<&str>> {
    buffers
        .iter()
        .map(|b| {
            BUFFERS
                .iter()
                .find(|known| **known == b)
                .copied()
                .ok_or_else(|| AppError::InvalidInput(format!("unknown log buffer {b:?}")))
        })
        .collect()
}

/// Streams parsed entries in batches until the device goes away or logcat
/// exits. Batches are flushed every [`FLUSH_INTERVAL`] or at [`MAX_BATCH`]
/// entries, so thousands of lines per second cost a few IPC messages.
pub async fn stream(
    server: &AdbServer,
    serial: &str,
    opts: &StreamOptions,
    mut on_batch: impl FnMut(Vec<LogEntry>),
) -> AppResult<()> {
    let command = stream_command(opts)?;
    let socket = server
        .open_device(serial, &format!("exec:{command}"))
        .await?;
    let mut reader = BufReader::with_capacity(64 * 1024, socket);

    let mut parser = Parser::default();
    let mut batch = Vec::new();
    let mut buf = Vec::with_capacity(512);
    let mut ticker = tokio::time::interval(FLUSH_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // Lines read since the last tick; an entry is only force-completed after
    // a quiet tick so a multi-line message is never split across batches.
    let mut active = false;

    loop {
        tokio::select! {
            read = reader.read_until(b'\n', &mut buf) => {
                if read? == 0 {
                    parser.flush(&mut batch);
                    if !batch.is_empty() {
                        on_batch(std::mem::take(&mut batch));
                    }
                    return Ok(());
                }
                {
                    let line = String::from_utf8_lossy(&buf);
                    parser.push_line(line.strip_suffix('\n').unwrap_or(&line), &mut batch);
                }
                buf.clear();
                active = true;
                if batch.len() >= MAX_BATCH {
                    on_batch(std::mem::take(&mut batch));
                }
            }
            _ = ticker.tick() => {
                if !active && parser.has_pending() {
                    parser.flush(&mut batch);
                }
                active = false;
                if !batch.is_empty() {
                    on_batch(std::mem::take(&mut batch));
                }
            }
        }
    }
}

/// `logcat -c` for the given buffers.
pub async fn clear(server: &AdbServer, serial: &str, buffers: &[String]) -> AppResult<()> {
    let buffers = validate_buffers(buffers)?;
    let mut cmd = String::from("logcat -c");
    if !buffers.is_empty() {
        cmd.push_str(" -b ");
        cmd.push_str(&buffers.join(","));
    }
    let out = server.exec_text(serial, &format!("{cmd} 2>&1")).await?;
    let out = out.trim();
    if out.is_empty() {
        Ok(())
    } else {
        Err(AppError::Device(out.to_owned()))
    }
}

/// An installed package, for the package filter combobox.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Package {
    pub name: String,
    pub uid: Option<u32>,
    /// Installed by the user (`pm list packages -3`), not part of the system.
    pub third_party: bool,
}

/// Parses `pm list packages [-U]` lines: `package:com.example uid:10224`.
pub fn parse_pm_packages(output: &str) -> Vec<(String, Option<u32>)> {
    output
        .lines()
        .filter_map(|line| {
            let rest = line.trim().strip_prefix("package:")?;
            let mut parts = rest.split_whitespace();
            let name = parts.next()?.to_owned();
            let uid = parts
                .find_map(|p| p.strip_prefix("uid:"))
                .and_then(|u| u.split(',').next())
                .and_then(|u| u.parse().ok());
            Some((name, uid))
        })
        .collect()
}

pub async fn packages(server: &AdbServer, serial: &str) -> AppResult<Vec<Package>> {
    let (all, third) = tokio::join!(
        server.exec_text(serial, "pm list packages -U"),
        server.exec_text(serial, "pm list packages -3"),
    );
    let third: std::collections::HashSet<String> = parse_pm_packages(&third?)
        .into_iter()
        .map(|(name, _)| name)
        .collect();
    let mut list: Vec<Package> = parse_pm_packages(&all?)
        .into_iter()
        .map(|(name, uid)| Package {
            third_party: third.contains(&name),
            name,
            uid,
        })
        .collect();
    list.sort_by(|a, b| b.third_party.cmp(&a.third_party).then(a.name.cmp(&b.name)));
    Ok(list)
}

/// Where a package currently runs.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageProcesses {
    pub uid: Option<u32>,
    pub processes: Vec<RunningProcess>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningProcess {
    pub pid: u32,
    pub name: String,
}

/// Parses `ps -A -o PID,NAME` and keeps the processes of `package`
/// (`com.example.shop` and `com.example.shop:remote`).
pub fn parse_ps_for_package(output: &str, package: &str) -> Vec<RunningProcess> {
    output
        .lines()
        .skip(1)
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let pid = parts.next()?.parse().ok()?;
            let name = parts.next()?;
            let ours = name == package
                || name
                    .strip_prefix(package)
                    .is_some_and(|rest| rest.starts_with(':'));
            ours.then(|| RunningProcess {
                pid,
                name: name.to_owned(),
            })
        })
        .collect()
}

pub fn validate_package(package: &str) -> AppResult<()> {
    let valid = !package.is_empty()
        && package.len() <= 255
        && package
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_');
    if valid {
        Ok(())
    } else {
        Err(AppError::InvalidInput(format!(
            "bad package name {package:?}"
        )))
    }
}

pub async fn package_processes(
    server: &AdbServer,
    serial: &str,
    package: &str,
) -> AppResult<PackageProcesses> {
    validate_package(package)?;
    let pm_cmd = format!("pm list packages -U {package}");
    let (pm, ps) = tokio::join!(
        server.exec_text(serial, &pm_cmd),
        server.exec_text(serial, "ps -A -o PID,NAME"),
    );
    let uid = parse_pm_packages(&pm?)
        .into_iter()
        .find(|(name, _)| name == package)
        .and_then(|(_, uid)| uid);
    Ok(PackageProcesses {
        uid,
        processes: parse_ps_for_package(&ps?, package),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const APP_CRASH: &str = include_str!("../../tests/fixtures/logcat/long_app_crash.txt");
    const NATIVE_CRASH: &str = include_str!("../../tests/fixtures/logcat/long_native_crash.txt");

    fn parse_all(text: &str) -> Vec<LogEntry> {
        let mut parser = Parser::default();
        let mut out = Vec::new();
        for line in text.lines() {
            parser.push_line(line, &mut out);
        }
        parser.flush(&mut out);
        out
    }

    #[test]
    fn parses_header_fields() {
        let h =
            parse_header("[ 2026-10-25 23:44:02.346 10230: 6230: 6230 E/AndroidRuntime ]").unwrap();
        assert_eq!(
            h,
            Header {
                date: "2026-10-25".into(),
                time: "23:44:02.346".into(),
                uid: "10230".into(),
                pid: 6230,
                tid: 6230,
                level: Level::E,
                tag: "AndroidRuntime".into(),
            }
        );
        let h = parse_header("[ 2026-10-25 23:43:07.016  logd:  242:  242 I/logd     ]").unwrap();
        assert_eq!(
            (h.uid.as_str(), h.pid, h.tag.as_str()),
            ("logd", 242, "logd")
        );
    }

    #[test]
    fn keeps_tags_with_spaces_and_slashes() {
        let h =
            parse_header("[ 2026-10-25 23:44:02.414 10193: 1145: 1145 D/b/417220811 ]").unwrap();
        assert_eq!(h.tag, "b/417220811");
        let h = parse_header("[ 2026-10-25 23:44:02.414  1000:  744:  904 D/Wifi Score ]").unwrap();
        assert_eq!(h.tag, "Wifi Score");
    }

    #[test]
    fn rejects_non_headers() {
        assert!(parse_header("[ not a header ]").is_none());
        assert!(parse_header("[ 2026-10-25 23:44:02.346 10230: x: 6230 E/Tag ]").is_none());
        assert!(parse_header("  at android.os.Looper.loop(Looper.java:367)").is_none());
    }

    #[test]
    fn parses_captured_stream() {
        let entries = parse_all(APP_CRASH);
        let headers = APP_CRASH.lines().filter(|l| l.starts_with("[ ")).count();
        assert_eq!(entries.len(), headers);
        assert!(entries.windows(2).all(|w| w[1].seq == w[0].seq + 1));
        // No message keeps the separating blank lines.
        assert!(entries.iter().all(|e| !e.message.ends_with('\n')));

        let first = &entries[0];
        assert_eq!(first.tag, "AndroidRuntime");
        assert_eq!(first.level, Level::D);
        assert_eq!(first.message, "Shutting down VM");

        // Leading indentation is part of the message.
        let finishing = entries
            .iter()
            .find(|e| e.tag == "ActivityTaskManager")
            .unwrap();
        assert!(finishing.message.starts_with("  Force finishing activity"));
    }

    #[test]
    fn java_crash_is_one_entry_with_stack() {
        let entries = parse_all(APP_CRASH);
        let crash = entries.iter().find(|e| e.crash.is_some()).unwrap();
        assert_eq!(crash.tag, "AndroidRuntime");
        assert_eq!(crash.message.lines().count(), 14);
        assert!(
            crash
                .message
                .ends_with("at com.android.internal.os.ZygoteInit.main(ZygoteInit.java:929)")
        );
        assert_eq!(
            crash.crash,
            Some(Crash {
                kind: CrashKind::Java,
                title:
                    "android.app.RemoteServiceException$CrashedByAdbException: shell-induced crash"
                        .into(),
                process: Some("com.ytheekshana.apkextractor".into()),
                pid: Some(6230),
            })
        );
        assert_eq!(entries.iter().filter(|e| e.crash.is_some()).count(), 1);
    }

    #[test]
    fn tracks_process_lifecycle() {
        let events: Vec<_> = parse_all(APP_CRASH)
            .into_iter()
            .filter_map(|e| e.process_event)
            .collect();
        assert_eq!(
            events,
            [
                ProcessEvent {
                    kind: ProcessEventKind::Died,
                    pid: 6230,
                    process: "com.ytheekshana.apkextractor".into(),
                },
                ProcessEvent {
                    kind: ProcessEventKind::Started,
                    pid: 7763,
                    process: "com.ytheekshana.apkextractor".into(),
                },
            ]
        );
    }

    #[test]
    fn parses_process_event_variants() {
        let start = parse_process_event(
            "Start proc 8680:com.android.chrome:privileged_process0/u0a169 for service \
             {com.android.chrome/org.chromium.content.app.PrivilegedProcessService0}",
        )
        .unwrap();
        assert_eq!(start.pid, 8680);
        assert_eq!(start.process, "com.android.chrome:privileged_process0");

        let killed =
            parse_process_event("Killing 4821:com.example.shop/u0a312 (adj 900): remove task")
                .unwrap();
        assert_eq!((killed.kind, killed.pid), (ProcessEventKind::Died, 4821));
        assert!(parse_process_event("Process 6230 exited due to signal 9").is_none());
    }

    #[test]
    fn merges_native_tombstone() {
        let entries = parse_all(NATIVE_CRASH);
        // `F/libc Fatal signal` stays a normal row, the DEBUG lines collapse.
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].tag, "libc");
        assert!(entries[0].crash.is_none());

        let tombstone = &entries[1];
        assert_eq!(tombstone.tag, "DEBUG");
        assert!(tombstone.message.starts_with(TOMBSTONE_START));
        assert!(tombstone.message.contains("\nbacktrace:\n"));
        assert_eq!(
            tombstone.crash,
            Some(Crash {
                kind: CrashKind::Native,
                title:
                    "signal 4 (SIGILL), code 1 (ILL_ILLOPC), fault addr 0x0000007a3cf826d0 (read)"
                        .into(),
                process: Some("com.google.android.tts".into()),
                pid: Some(2517),
            })
        );
    }

    #[test]
    fn detects_anr() {
        // ActivityManager's ANR report format (AnrHelper / ProcessErrorStateRecord).
        let text = "\
[ 2026-10-25 22:41:12.004  1000: 1534: 1588 E/ActivityManager ]
ANR in com.example.shop (com.example.shop/.MainActivity)
PID: 5106
Reason: Input dispatching timed out (5001ms)
ErrorId: 1f0c3e2a-7c4b-4a51-9f0e-2b1d6c9e8a77
Frozen: false
Load: 2.14 / 1.87 / 1.42

";
        let entries = parse_all(text);
        assert_eq!(
            entries[0].crash,
            Some(Crash {
                kind: CrashKind::Anr,
                title: "Input dispatching timed out (5001ms)".into(),
                process: Some("com.example.shop".into()),
                pid: Some(5106),
            })
        );
    }

    #[test]
    fn idle_flush_completes_last_entry() {
        let mut parser = Parser::default();
        let mut out = Vec::new();
        parser.push_line(
            "[ 2026-10-25 23:44:02.348 10230: 6230: 6230 D/FirebaseSessions ]",
            &mut out,
        );
        parser.push_line("App backgrounded on com.ytheekshana.apkextractor", &mut out);
        assert!(out.is_empty());
        assert!(parser.has_pending());
        parser.flush(&mut out);
        assert_eq!(out.len(), 1);
        assert!(!parser.has_pending());
    }

    #[test]
    fn builds_stream_command() {
        let cmd = stream_command(&StreamOptions {
            buffers: vec!["main".into(), "crash".into()],
            tail: Some(500),
            since: None,
        })
        .unwrap();
        assert_eq!(cmd, "logcat -v long -v year -v uid -b main,crash -T 500");

        let cmd = stream_command(&StreamOptions {
            since: Some("2026-10-25 23:44:02.346".into()),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(
            cmd,
            "logcat -v long -v year -v uid -T '2026-10-25 23:44:02.346'"
        );

        assert!(
            stream_command(&StreamOptions {
                buffers: vec!["main;reboot".into()],
                ..Default::default()
            })
            .is_err()
        );
        assert!(
            stream_command(&StreamOptions {
                since: Some("'; reboot".into()),
                ..Default::default()
            })
            .is_err()
        );
    }

    #[test]
    fn parses_package_lists() {
        let pm = "package:ru.vk.store uid:10224\npackage:com.android.shell uid:2000\n\
                  package:com.shared uid:10050,10051\npackage:com.nouid\n";
        assert_eq!(
            parse_pm_packages(pm),
            [
                ("ru.vk.store".into(), Some(10224)),
                ("com.android.shell".into(), Some(2000)),
                ("com.shared".into(), Some(10050)),
                ("com.nouid".into(), None),
            ]
        );
    }

    #[test]
    fn finds_package_processes() {
        let ps = "  PID NAME\n    1 init\n 7763 com.ytheekshana.apkextractor\n \
                  7790 com.ytheekshana.apkextractor:remote\n 7800 com.ytheekshana.apkextractor2\n";
        let procs = parse_ps_for_package(ps, "com.ytheekshana.apkextractor");
        assert_eq!(
            procs.iter().map(|p| p.pid).collect::<Vec<_>>(),
            [7763, 7790]
        );
    }

    #[test]
    fn validates_package_names() {
        assert!(validate_package("com.example.shop").is_ok());
        assert!(validate_package("com.example; reboot").is_err());
        assert!(validate_package("").is_err());
    }
}
