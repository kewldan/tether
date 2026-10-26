import { Channel, invoke } from "@tauri-apps/api/core";

import type { Capture } from "@/features/overview/api";
import type { AppError } from "@/lib/tauri";

export type VideoCodec = "h264" | "h265" | "av1";

export interface MirrorOptions {
  videoCodec: VideoCodec;
  /** Long side limit in px; 0 keeps the native resolution. */
  maxSize: number;
  /** Bits per second. */
  videoBitRate: number;
  maxFps: number;
  audio: boolean;
  showTouches: boolean;
  stayAwake: boolean;
}

export interface MirrorInfo {
  sessionId: number;
  deviceName: string;
  videoCodec: VideoCodec;
  audio: boolean;
  scrcpyVersion: string;
}

export type MirrorEvent =
  | { type: "clipboard"; text: string }
  | { type: "audioDisabled" }
  | { type: "stopped"; error: AppError | null }
  /** Another window took the session over (pop-out or back). */
  | { type: "detached" };

export interface Position {
  x: number;
  y: number;
  /** Size of the video frame the point refers to (last session packet). */
  width: number;
  height: number;
}

/** Control messages of the scrcpy protocol (see `mirror/control.rs`). */
export type ControlMessage =
  | {
      type: "key";
      action: "down" | "up";
      keycode: number;
      repeat?: number;
      metastate?: number;
    }
  | { type: "text"; text: string }
  | ({
      type: "touch";
      action: "down" | "up" | "move" | "cancel";
      pointerId?: number;
      pressure?: number;
    } & Position)
  | ({ type: "scroll"; hscroll: number; vscroll: number } & Position)
  | { type: "backOrScreenOn"; action: "down" | "up" }
  | { type: "expandNotificationPanel" }
  | { type: "expandSettingsPanel" }
  | { type: "collapsePanels" }
  | { type: "getClipboard"; copyKey?: "none" | "copy" | "cut" }
  | { type: "setClipboard"; text: string; paste?: boolean; sequence?: number }
  | { type: "setDisplayPower"; on: boolean }
  | { type: "rotateDevice" }
  | { type: "resetVideo" };

/**
 * Starts mirroring. `onVideo` receives binary batches of records
 * (`records.ts`); resolves once the server announced the video stream.
 */
export function startMirror(
  serial: string,
  options: MirrorOptions,
  onVideo: (batch: ArrayBuffer) => void,
  onEvent: (event: MirrorEvent) => void,
) {
  const video = new Channel<ArrayBuffer>();
  video.onmessage = onVideo;
  const events = new Channel<MirrorEvent>();
  events.onmessage = onEvent;
  return invoke<MirrorInfo>("mirror_start", {
    serial,
    options,
    onVideo: video,
    onEvent: events,
  });
}

/**
 * This window stops showing `serial`. The session ends a few seconds
 * later unless another view takes it over or it is being recorded.
 */
export const stopMirror = (serial: string, sessionId?: number) =>
  invoke<void>("mirror_stop", { serial, sessionId: sessionId ?? null });

/** Shows the running session in this window (the pop-out) without restarting it. */
export function attachMirror(
  serial: string,
  onVideo: (batch: ArrayBuffer) => void,
  onEvent: (event: MirrorEvent) => void,
) {
  const video = new Channel<ArrayBuffer>();
  video.onmessage = onVideo;
  const events = new Channel<MirrorEvent>();
  events.onmessage = onEvent;
  return invoke<MirrorInfo>("mirror_attach", {
    serial,
    onVideo: video,
    onEvent: events,
  });
}

/**
 * Opens the always-on-top pop-out for the running session of `serial`
 * (inner size in logical px). `onClosed` fires when it goes away.
 */
export function openPopout(
  serial: string,
  name: string,
  size: { width: number; height: number },
  onClosed: () => void,
) {
  const closed = new Channel<null>();
  closed.onmessage = onClosed;
  return invoke<void>("mirror_popout", {
    serial,
    name,
    width: size.width,
    height: size.height,
    onClosed: closed,
  });
}

/** Closes the pop-out of `serial`; `focusMain` brings the main window up. */
export const closePopout = (serial: string, focusMain: boolean) =>
  invoke<void>("mirror_popout_close", { serial, focusMain });

export interface RecordingStarted {
  path: string;
  name: string;
  /** Folder for display, e.g. `~/Pictures/Tether/Pixel 8/`. */
  dir: string;
}

export type RecordEvent =
  | { type: "progress"; bytes: number; durationMs: number }
  /** Ended without a stop (mirroring ended); the file is kept if any. */
  | { type: "ended"; capture: Capture | null; error: AppError | null };

/** Records the mirrored stream to the captures folder (MP4, no re-encode). */
export function startMirrorRecording(
  serial: string,
  deviceName: string,
  stamp: string,
  onEvent: (event: RecordEvent) => void,
) {
  const channel = new Channel<RecordEvent>();
  channel.onmessage = onEvent;
  return invoke<RecordingStarted>("mirror_record_start", {
    serial,
    deviceName,
    stamp,
    onEvent: channel,
  });
}

export const stopMirrorRecording = (serial: string) =>
  invoke<Capture>("mirror_record_stop", { serial });

export const sendControl = (serial: string, message: ControlMessage) =>
  invoke<void>("mirror_control", { serial, message });

/** Android keycodes used by the toolbar. */
export const KEYCODE = {
  home: 3,
  back: 4,
  volumeUp: 24,
  volumeDown: 25,
  power: 26,
  appSwitch: 187,
} as const;
