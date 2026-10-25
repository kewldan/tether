import { Channel, invoke } from "@tauri-apps/api/core";

export interface MdnsService {
  name: string;
  kind: "pairing" | "connect" | "other";
  address: string;
}

export interface MdnsSnapshot {
  available: boolean;
  services: MdnsService[];
}

export interface QrSession {
  name: string;
  password: string;
  payload: string;
  width: number;
  /** Row-major, "1" = dark module. */
  modules: string;
}

export type PairTarget =
  | { type: "qr"; name: string; password: string }
  | { type: "code"; address: string; code: string };

export type PairEvent =
  | { type: "waiting" }
  | { type: "pairing"; address: string }
  | { type: "paired"; guid: string }
  | { type: "connecting"; address: string };

export type RebootMode = "system" | "recovery" | "bootloader" | "sideload";

export interface DeviceSummary {
  battery: number | null;
  charging: boolean;
  root: boolean;
  wifiIp: string | null;
}

export interface AvdEntry {
  name: string;
  displayName: string;
  api: string | null;
  abi: string | null;
  running: string | null;
}

export interface AvdList {
  canLaunch: boolean;
  avds: AvdEntry[];
}

export const mdnsServices = () => invoke<MdnsSnapshot>("wifi_mdns_services");

export const qrSession = () => invoke<QrSession>("wifi_qr_session");

/** Pairs and connects; resolves with the new device's serial. */
export function pairDevice(
  target: PairTarget,
  onEvent: (event: PairEvent) => void,
) {
  const channel = new Channel<PairEvent>();
  channel.onmessage = onEvent;
  return invoke<string>("wifi_pair", { target, onEvent: channel });
}

export const cancelPairing = () => invoke<void>("wifi_cancel_pair");

/** `adb connect`; resolves with the address used as serial. */
export const connectWifi = (address: string) =>
  invoke<string>("wifi_connect", { address });

export const disconnectWifi = (serial: string) =>
  invoke<void>("wifi_disconnect", { serial });

/** Legacy `adb tcpip` + connect; resolves with the new serial. */
export const switchToWifi = (serial: string, port: number) =>
  invoke<string>("wifi_tcpip", { serial, port });

export const deviceWifiIp = (serial: string) =>
  invoke<string | null>("device_wifi_ip", { serial });

/** Reboots via the shared `reboot_device` command (see device/actions.rs). */
export const rebootDevice = (serial: string, mode: RebootMode) =>
  invoke<void>("reboot_device", { serial, target: mode });

export const reconnectDevice = (serial: string) =>
  invoke<void>("devices_reconnect", { serial });

export const reconnectOffline = () => invoke<void>("devices_reconnect_offline");

export const deviceSummary = (serial: string) =>
  invoke<DeviceSummary>("devices_summary", { serial });

export const listAvds = () => invoke<AvdList>("avd_list");

export const launchAvd = (name: string) => invoke<void>("avd_launch", { name });

/** Shell command without a PTY, for multi-device "Run command…". */
export const deviceExec = (serial: string, command: string) =>
  invoke<string>("devices_exec", { serial, command });

/** Saves a PNG screenshot into `dir` (default Pictures/Tether). */
export const saveScreenshot = (serial: string, dir: string | null) =>
  invoke<string>("devices_screenshot", { serial, dir });
