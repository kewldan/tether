import { Channel, invoke } from "@tauri-apps/api/core";

import type { DeviceInfo } from "@/lib/tauri";

export type BatteryStatus =
  | "unknown"
  | "charging"
  | "discharging"
  | "not_charging"
  | "full";

export type BatteryHealth =
  | "unknown"
  | "good"
  | "overheat"
  | "dead"
  | "over_voltage"
  | "failure"
  | "cold";

export type PowerSource = "ac" | "usb" | "wireless" | "dock";

export interface Battery {
  level: number | null;
  status: BatteryStatus;
  plugged: PowerSource | null;
  temperatureC: number | null;
  health: BatteryHealth;
  voltageV: number | null;
  technology: string | null;
}

export interface StorageCategories {
  apps: number;
  photosVideos: number;
  audio: number;
  downloads: number;
  system: number;
  other: number;
}

export interface Storage {
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  categories: StorageCategories | null;
}

export interface Memory {
  totalBytes: number;
  availableBytes: number;
  freeBytes: number;
  cachedBytes: number;
  swapTotalBytes: number;
  swapFreeBytes: number;
}

export interface Cpu {
  cores: number | null;
  maxFreqMhz: number | null;
  /** 0..1 */
  load: number | null;
  coreLoads: (number | null)[];
  abi: string | null;
}

export type ThermalStatus =
  | "none"
  | "light"
  | "moderate"
  | "severe"
  | "critical"
  | "emergency"
  | "shutdown";

export interface Thermal {
  status: ThermalStatus;
  cpuC: number | null;
  skinC: number | null;
}

export interface Size {
  width: number;
  height: number;
}

export interface Display {
  physicalSize: Size | null;
  overrideSize: Size | null;
  physicalDensity: number | null;
  overrideDensity: number | null;
  refreshRate: number | null;
  maxRefreshRate: number | null;
  fontScale: number | null;
}

export interface Network {
  wifiEnabled: boolean | null;
  ssid: string | null;
  ip: string | null;
  rssiDbm: number | null;
  frequencyMhz: number | null;
  linkSpeedMbps: number | null;
  mobileOperator: string | null;
  mobileType: string | null;
}

export interface BuildFacts {
  brand: string | null;
  device: string | null;
  buildId: string | null;
  buildType: string | null;
  incremental: string | null;
  soc: string | null;
  locale: string | null;
}

export type RootStatus = "adb_root" | "su" | "none";

export interface DeviceSnapshot {
  info: DeviceInfo;
  build: BuildFacts;
  battery: Battery | null;
  storage: Storage | null;
  memory: Memory | null;
  cpu: Cpu;
  thermal: Thermal | null;
  display: Display;
  network: Network;
  uptimeSecs: number | null;
  root: RootStatus;
  /** Host time, ms since epoch. */
  takenAt: number;
}

export type RebootTarget =
  | "system"
  | "recovery"
  | "bootloader"
  | "sideload"
  | "power_off";

export type CaptureKind = "screenshot" | "recording";

export interface Capture {
  path: string;
  name: string;
  device: string | null;
  kind: CaptureKind;
  sizeBytes: number;
  modified: number;
  width: number | null;
  height: number | null;
}

export type RecordingEvent = { type: "ended"; message: string | null };

export interface RecordingStatus {
  elapsedMs: number;
  running: boolean;
}

export const deviceSnapshot = (serial: string) =>
  invoke<DeviceSnapshot>("device_snapshot", { serial });

export const rebootDevice = (serial: string, target: RebootTarget) =>
  invoke<void>("reboot_device", { serial, target });

export const takeScreenshot = (
  serial: string,
  deviceName: string,
  stamp: string,
) => invoke<Capture>("take_screenshot", { serial, deviceName, stamp });

export function startRecording(
  serial: string,
  onEvent: (event: RecordingEvent) => void,
) {
  const channel = new Channel<RecordingEvent>();
  channel.onmessage = onEvent;
  return invoke<void>("start_recording", { serial, onEvent: channel });
}

export const stopRecording = (
  serial: string,
  deviceName: string,
  stamp: string,
) => invoke<Capture>("stop_recording", { serial, deviceName, stamp });

export const recordingStatus = (serial: string) =>
  invoke<RecordingStatus | null>("recording_status", { serial });
