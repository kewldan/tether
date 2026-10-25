import { Channel, invoke } from "@tauri-apps/api/core";

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
  | { type: "stopped"; error: AppError | null };

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

export const stopMirror = (serial: string, sessionId?: number) =>
  invoke<void>("mirror_stop", { serial, sessionId: sessionId ?? null });

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
