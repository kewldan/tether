import { Channel, invoke } from "@tauri-apps/api/core";

import { adbLookupArgs } from "@/lib/settings";
import type { AdbInstall, AdbSource } from "@/lib/tauri";

export type CheckKind =
  | "settings"
  | "path"
  | "android_home"
  | "studio_sdk"
  | "homebrew"
  | "winget"
  | "scoop"
  | "system"
  | "bundled";

export interface LocationCheck {
  kind: CheckKind;
  source: AdbSource;
  paths: string[];
  found: string | null;
  status: "found" | "missing" | "not_set";
}

export interface AdbScan {
  checks: LocationCheck[];
  install: AdbInstall | null;
}

export interface ServerStatus {
  running: boolean;
  version: number | null;
  port: number;
  startedByUs: boolean;
  uptimeSecs: number | null;
  binary: string | null;
}

/** Looks for adb everywhere, honoring the adb settings. */
export const scanAdb = () => invoke<AdbScan>("adb_scan", adbLookupArgs());

/** Validates a user-picked adb and makes it the active one. */
export const setAdbPath = (path: string) =>
  invoke<AdbInstall>("adb_use_path", { path });

export const adbKeyFingerprint = () =>
  invoke<string | null>("adb_key_fingerprint");

export const serverStatus = () => invoke<ServerStatus>("adb_server_status");

/** Starts the server if needed; resolves with its protocol version. */
export const ensureServer = () => invoke<number>("adb_ensure_server");

/** Kills and restarts the server with the active adb. */
export const restartServer = () => invoke<number>("adb_restart_server");

export type InstallProgress =
  | { type: "downloading"; downloaded: number; total: number | null }
  | { type: "extracting" };

/** Downloads platform-tools; only call after the user accepted the license. */
export function downloadPlatformTools(
  onEvent: (event: InstallProgress) => void,
) {
  const channel = new Channel<InstallProgress>();
  channel.onmessage = onEvent;
  return invoke<AdbInstall>("install_platform_tools", { onEvent: channel });
}

export const cancelDownload = () =>
  invoke<void>("cancel_platform_tools_install");
