import { Channel, invoke } from "@tauri-apps/api/core";

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
