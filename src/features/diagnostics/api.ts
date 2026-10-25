import { invoke } from "@tauri-apps/api/core";

import type { Device } from "@/lib/tauri";

export type CheckStatus = "pass" | "skip" | "warn" | "fail";

export interface Check {
  id: string;
  variant: string;
  status: CheckStatus;
  params: Record<string, string>;
  details: string | null;
}

export interface UsbDevice {
  vendorId: number;
  productId: number;
  manufacturer: string | null;
  product: string | null;
  serial: string | null;
  location: string | null;
  speed: string | null;
  androidVendor: string | null;
}

export interface Facts {
  os: string;
  adbPath: string | null;
  adbVersion: string | null;
  clientVersion: number | null;
  serverVersion: number | null;
  serverError: string | null;
  serverPort: number;
  process: {
    pid: number | null;
    binary: string | null;
    uptimeSecs: number | null;
  };
  startedByUs: boolean;
  serverDrops: number;
  serverLog: string[];
  devices: Device[];
  usb: { supported: boolean; devices: UsbDevice[] } | null;
  mdns: string | null;
  udevRules: boolean | null;
}

export interface DiagnosticsReport {
  checkedAt: number;
  checks: Check[];
  facts: Facts;
}

export const runDiagnostics = () =>
  invoke<DiagnosticsReport>("diagnostics_run");
