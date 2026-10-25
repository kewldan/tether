import { Channel, invoke } from "@tauri-apps/api/core";

import type { AppError } from "@/lib/tauri";

export type Level = "V" | "D" | "I" | "W" | "E" | "F";
export const LEVELS: readonly Level[] = ["V", "D", "I", "W", "E", "F"];

export type CrashKind = "java" | "native" | "anr";

export interface Crash {
  kind: CrashKind;
  /** Exception line, signal line or ANR reason. */
  title: string;
  process: string | null;
  pid: number | null;
}

export interface ProcessEvent {
  kind: "started" | "died";
  pid: number;
  process: string;
}

/** One logcat entry as parsed by the backend (`device/logcat.rs`). */
export interface LogEntry {
  /** Monotonic within one stream session. */
  seq: number;
  date: string;
  time: string;
  /** Numeric uid or a name for system uids (`root`, `radio`). */
  uid: string;
  pid: number;
  tid: number;
  level: Level;
  tag: string;
  message: string;
  crash?: Crash;
  processEvent?: ProcessEvent;
}

export const BUFFERS = [
  "main",
  "system",
  "crash",
  "events",
  "radio",
  "kernel",
] as const;
export type BufferName = (typeof BUFFERS)[number];

export interface StreamOptions {
  buffers: string[];
  /** Backlog size, `-T N`. */
  tail: number | null;
  /** Backlog since a device time, `YYYY-MM-DD hh:mm:ss.mmm`. */
  since: string | null;
}

export type LogcatEvent =
  | { type: "batch"; entries: LogEntry[] }
  | { type: "ended"; error: AppError | null };

export interface Package {
  name: string;
  uid: number | null;
  thirdParty: boolean;
}

export interface PackageProcesses {
  uid: number | null;
  processes: { pid: number; name: string }[];
}

export function startLogcat(
  serial: string,
  options: StreamOptions,
  onEvent: (event: LogcatEvent) => void,
) {
  const channel = new Channel<LogcatEvent>();
  channel.onmessage = onEvent;
  return invoke<number>("logcat_start", { serial, options, onEvent: channel });
}

export const stopLogcat = (session: number) =>
  invoke<void>("logcat_stop", { session });

export const clearLogcat = (serial: string, buffers: string[]) =>
  invoke<void>("logcat_clear", { serial, buffers });

export const logcatPackages = (serial: string) =>
  invoke<Package[]>("logcat_packages", { serial });

export const packageProcesses = (serial: string, packageName: string) =>
  invoke<PackageProcesses>("logcat_package_processes", {
    serial,
    package: packageName,
  });

/** Saves text to the Downloads folder; resolves to the full path. */
export const exportLogcat = (fileName: string, contents: string) =>
  invoke<string>("logcat_export", { fileName, contents });
