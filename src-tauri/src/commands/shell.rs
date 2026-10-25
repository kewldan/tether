//! Interactive shell sessions (PTY over shell v2) and one-shot commands.
//!
//! Output goes to the frontend as raw binary channel messages (an
//! `ArrayBuffer` in JS, no JSON): byte 0 is a tag, the rest the payload.
//! - `1` + bytes: terminal output (stdout and stderr, as the PTY merges them)
//! - `3` [+ exit code]: the session ended; no code on legacy devices
//!
//! Each socket read is decoded and sent as one message, so bursts of
//! output arrive batched rather than packet by packet.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::State;
use tauri::async_runtime::JoinHandle;
use tauri::ipc::{Channel, InvokeResponseBody};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;

use crate::adb::shell_v2::{self, CommandOutput, PacketDecoder, PtyOptions};
use crate::error::{AppError, AppResult};
use crate::state::{AppState, lock};

pub const TAG_OUTPUT: u8 = 1;
pub const TAG_EXIT: u8 = 3;

enum Input {
    Data(Vec<u8>),
    Resize { rows: u16, cols: u16 },
}

struct Session {
    input: mpsc::UnboundedSender<Input>,
    tasks: [JoinHandle<()>; 2],
}

#[derive(Default)]
pub struct ShellSessions {
    next_id: AtomicU32,
    sessions: Arc<Mutex<HashMap<u32, Session>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellSessionInfo {
    pub id: u32,
    /// False on devices without shell v2: no resize, no exit code.
    pub v2: bool,
}

fn message(tag: u8, payload: &[u8]) -> InvokeResponseBody {
    let mut bytes = Vec::with_capacity(payload.len() + 1);
    bytes.push(tag);
    bytes.extend_from_slice(payload);
    InvokeResponseBody::Raw(bytes)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn shell_open(
    state: State<'_, AppState>,
    sessions: State<'_, ShellSessions>,
    serial: String,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    on_output: Channel<InvokeResponseBody>,
) -> AppResult<ShellSessionInfo> {
    let opts = PtyOptions {
        term: "xterm-256color".into(),
        rows: rows.max(1),
        cols: cols.max(1),
        command: None,
    };
    let shell = shell_v2::open_pty(&state.server, &serial, &opts).await?;
    let v2 = shell.v2;
    let (mut reader, mut writer) = shell.stream.into_split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Input>();

    if let Some(dir) = cwd.filter(|d| !d.trim().is_empty()) {
        let _ = tx.send(Input::Data(
            format!("cd {}\r", shell_v2::quote(&dir)).into_bytes(),
        ));
    }

    let id = sessions.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let map = sessions.sessions.clone();

    let write_task = tauri::async_runtime::spawn(async move {
        while let Some(input) = rx.recv().await {
            let bytes = match input {
                Input::Data(data) if v2 => shell_v2::encode_stdin(&data),
                Input::Data(data) => data,
                Input::Resize { rows, cols } if v2 => {
                    shell_v2::encode_window_size(rows, cols, 0, 0)
                }
                Input::Resize { .. } => continue,
            };
            if writer.write_all(&bytes).await.is_err() {
                break;
            }
        }
        let _ = writer.shutdown().await;
    });

    let read_task = tauri::async_runtime::spawn(async move {
        let mut decoder = PacketDecoder::default();
        let mut buf = vec![0u8; 64 * 1024];
        let mut exit: Option<u8> = None;
        'read: loop {
            let n = match reader.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            if !v2 {
                let _ = on_output.send(message(TAG_OUTPUT, &buf[..n]));
                continue;
            }
            decoder.push(&buf[..n]);
            let mut out = Vec::new();
            let mut done = false;
            while let Some(packet) = decoder.next_packet() {
                match packet.id {
                    shell_v2::ID_STDOUT | shell_v2::ID_STDERR => {
                        out.extend_from_slice(&packet.data)
                    }
                    shell_v2::ID_EXIT => {
                        exit = packet.data.first().copied();
                        done = true;
                    }
                    _ => {}
                }
            }
            if !out.is_empty() {
                let _ = on_output.send(message(TAG_OUTPUT, &out));
            }
            if done {
                break 'read;
            }
        }
        let _ = on_output.send(message(TAG_EXIT, exit.as_slice()));
        if let Some(session) = lock(&map).remove(&id) {
            session.tasks[0].abort();
        }
    });

    lock(&sessions.sessions).insert(
        id,
        Session {
            input: tx,
            tasks: [write_task, read_task],
        },
    );
    Ok(ShellSessionInfo { id, v2 })
}

fn send_input(sessions: &ShellSessions, id: u32, input: Input) -> AppResult<()> {
    let map = lock(&sessions.sessions);
    let session = map
        .get(&id)
        .ok_or_else(|| AppError::InvalidInput(format!("shell session {id} is closed")))?;
    session
        .input
        .send(input)
        .map_err(|_| AppError::InvalidInput(format!("shell session {id} is closed")))
}

#[tauri::command]
pub fn shell_write(sessions: State<'_, ShellSessions>, id: u32, data: String) -> AppResult<()> {
    send_input(&sessions, id, Input::Data(data.into_bytes()))
}

#[tauri::command]
pub fn shell_resize(
    sessions: State<'_, ShellSessions>,
    id: u32,
    cols: u16,
    rows: u16,
) -> AppResult<()> {
    send_input(
        &sessions,
        id,
        Input::Resize {
            rows: rows.max(1),
            cols: cols.max(1),
        },
    )
}

#[tauri::command]
pub fn shell_close(sessions: State<'_, ShellSessions>, id: u32) {
    if let Some(session) = lock(&sessions.sessions).remove(&id) {
        for task in session.tasks {
            task.abort();
        }
    }
}

/// Runs one command without a PTY (for "run on all devices").
#[tauri::command]
pub async fn shell_exec(
    state: State<'_, AppState>,
    serial: String,
    command: String,
) -> AppResult<CommandOutput> {
    if command.trim().is_empty() {
        return Err(AppError::InvalidInput("command is empty".into()));
    }
    shell_v2::run(&state.server, &serial, &command).await
}
