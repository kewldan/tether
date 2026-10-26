import { Channel, invoke } from "@tauri-apps/api/core";

import type { LogEntry } from "@/features/logcat/api";

/** A crash or ANR caught by a background crash watcher. */
export interface CrashAlert {
  serial: string;
  /** The crash entry; `crash` is always set. */
  entry: LogEntry;
}

/**
 * Runs the background crash watchers (`commands/logcat.rs`) on exactly
 * `serials`, replacing the previous set and subscription; `[]` stops all.
 */
export function crashWatch(
  serials: string[],
  onAlert: (alert: CrashAlert) => void,
) {
  const channel = new Channel<CrashAlert>();
  channel.onmessage = onAlert;
  return invoke<void>("crash_watch", { serials, onEvent: channel });
}

/** Localized tray menu texts (`src-tauri/src/tray/view.rs`). */
export interface TrayLabels {
  open: string;
  quit: string;
  screenshot: string;
  /** "Screenshot of {name}"; `{name}` is filled in by the backend. */
  screenshotOf: string;
  noDevices: string;
  /** Device state labels keyed by `DeviceState.kind`. */
  states: Record<string, string>;
}

export interface TrayConfig {
  visible: boolean;
  closeToTray: boolean;
  selected: string | null;
  /** Display names keyed by serial. */
  names: Record<string, string>;
  labels: TrayLabels;
}

export type TrayEvent =
  | { type: "selectDevice"; serial: string }
  | { type: "screenshot"; serial: string };

/** Pushes what the tray can't know on its own; the device list it tracks. */
export const traySync = (config: TrayConfig) =>
  invoke<void>("tray_sync", { config });

/** Tray menu clicks that need the webview; replaces earlier subscriptions. */
export function trayWatch(onEvent: (event: TrayEvent) => void) {
  const channel = new Channel<TrayEvent>();
  channel.onmessage = onEvent;
  return invoke<void>("tray_watch", { onEvent: channel });
}
