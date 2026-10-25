import { Channel, invoke } from "@tauri-apps/api/core";

export type AdbSource =
  | "settings"
  | "path"
  | "android_home"
  | "known_location"
  | "bundled";

export interface AdbInstall {
  path: string;
  source: AdbSource;
  version: string | null;
}

export type DeviceState =
  | { kind: "device" }
  | { kind: "unauthorized" }
  | { kind: "authorizing" }
  | { kind: "offline" }
  | { kind: "connecting" }
  | { kind: "no_permissions" }
  | { kind: "recovery" }
  | { kind: "rescue" }
  | { kind: "sideload" }
  | { kind: "bootloader" }
  | { kind: "host" }
  | { kind: "unknown"; raw: string };

export type Transport = "usb" | "wifi" | "emulator";

export interface Device {
  serial: string;
  state: DeviceState;
  transport: Transport;
  model: string | null;
  product: string | null;
  device: string | null;
  transportId: number | null;
}

export interface DeviceInfo {
  manufacturer: string | null;
  model: string | null;
  androidVersion: string | null;
  sdk: number | null;
  securityPatch: string | null;
  fingerprint: string | null;
  abi: string | null;
  /** Emulator AVD name with spaces ("Pixel 10 Pro"). */
  avdName?: string | null;
}

export interface AppError {
  kind: string;
  message: string;
  hint: string | null;
}

export type DevicesEvent =
  | { type: "devices"; devices: Device[] }
  | { type: "serverDown"; error: AppError };

export type InstallEvent =
  | { type: "downloading"; downloaded: number; total: number | null }
  | { type: "extracting" };

export const locateAdb = () => invoke<AdbInstall | null>("locate_adb");

/** Downloads platform-tools; only call after the user accepted the license. */
export function installPlatformTools(onEvent: (event: InstallEvent) => void) {
  const channel = new Channel<InstallEvent>();
  channel.onmessage = onEvent;
  return invoke<AdbInstall>("install_platform_tools", { onEvent: channel });
}

export const cancelPlatformToolsInstall = () =>
  invoke<void>("cancel_platform_tools_install");

export const deviceInfo = (serial: string) =>
  invoke<DeviceInfo>("device_info", { serial });

export function watchDevices(onEvent: (event: DevicesEvent) => void) {
  const channel = new Channel<DevicesEvent>();
  channel.onmessage = onEvent;
  return invoke<void>("watch_devices", { onEvent: channel });
}
