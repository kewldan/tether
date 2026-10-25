use tauri::State;

use crate::device::intents::{self, IntentCommand, IntentKind, IntentResult, IntentSpec};
use crate::error::AppResult;
use crate::state::AppState;

#[tauri::command]
pub async fn intent_send(
    state: State<'_, AppState>,
    serial: String,
    kind: IntentKind,
    spec: IntentSpec,
) -> AppResult<IntentResult> {
    intents::send(&state.server, &serial, kind, &spec).await
}

/// The `am` command line for preview and "Copy as adb command".
#[tauri::command]
pub fn intent_command(
    kind: IntentKind,
    spec: IntentSpec,
    serial: Option<String>,
) -> AppResult<IntentCommand> {
    intents::command(kind, &spec, serial.as_deref())
}

#[tauri::command]
pub async fn input_text(state: State<'_, AppState>, serial: String, text: String) -> AppResult<()> {
    intents::input_text(&state.server, &serial, &text).await
}

#[tauri::command]
pub async fn input_key(state: State<'_, AppState>, serial: String, key: String) -> AppResult<()> {
    intents::input_key(&state.server, &serial, &key).await
}
