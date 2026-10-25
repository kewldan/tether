import { Channel, invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { AppError } from "@/lib/tauri";

export interface Memory {
  totalKb: number;
  availableKb: number;
  usedKb: number;
  swapTotalKb: number;
  swapUsedKb: number;
}

export interface Network {
  iface: string | null;
  rxBytesPerSec: number;
  txBytesPerSec: number;
}

export interface Battery {
  level: number | null;
  temperatureC: number | null;
  voltageMv: number | null;
  currentMa: number | null;
  charging: boolean;
  plugged: boolean;
}

export interface Frames {
  fps: number;
  jankyPercent: number | null;
  p95Ms: number | null;
}

export interface PerfSample {
  time: number;
  cpu: number | null;
  cores: number[];
  memory: Memory;
  network: Network | null;
  battery: Battery;
  frames: Frames | null;
  packagePssKb: number | null;
}

export interface CpuInfo {
  cores: number;
  /** Cores per cluster, slowest first. */
  clusters: number[];
}

export type PerfEvent =
  | { type: "info"; cpu: CpuInfo }
  | { type: "sample"; sample: PerfSample }
  | { type: "error"; error: AppError };

export interface Process {
  pid: number;
  user: string;
  cpu: number;
  rssKb: number;
  state: string;
  name: string;
}

export const SAMPLE_INTERVAL_MS = 1000;

export function subscribePerf(
  serial: string,
  pkg: string | null,
  onEvent: (event: PerfEvent) => void,
) {
  const channel = new Channel<PerfEvent>();
  channel.onmessage = onEvent;
  return invoke<number>("perf_subscribe", {
    serial,
    package: pkg,
    intervalMs: SAMPLE_INTERVAL_MS,
    onEvent: channel,
  });
}

export const unsubscribePerf = (id: number) =>
  invoke<void>("perf_unsubscribe", { id });

export const listProcesses = (serial: string) =>
  invoke<Process[]>("perf_processes", { serial });

export const killProcess = (serial: string, pid: number, pkg: string | null) =>
  invoke<void>("perf_kill", { serial, pid, package: pkg });

/** Saves CSV into Downloads; resolves to the written path. */
export const exportCsv = (fileName: string, contents: string) =>
  invoke<string>("perf_export_csv", { fileName, contents });

/** App processes run as `u0_a<n>`; their package is the name before `:`. */
export function appPackage(p: Process): string | null {
  if (!/^u\d+_a\d+$/.test(p.user)) return null;
  const pkg = p.name.split(":")[0] ?? "";
  return /^[\w.]+\.[\w.]+$/.test(pkg) ? pkg : null;
}

export type TimeWindow = 30 | 60 | 300;

interface PerfPrefs {
  window: TimeWindow;
  /** Package whose frame rate and PSS are sampled. */
  fpsPackage: string | null;
  setWindow: (window: TimeWindow) => void;
  setFpsPackage: (pkg: string | null) => void;
}

export const usePerfPrefs = create<PerfPrefs>()(
  persist(
    (set) => ({
      window: 60,
      fpsPackage: null,
      setWindow: (window) => set({ window }),
      setFpsPackage: (fpsPackage) => set({ fpsPackage }),
    }),
    { name: "tether.performance" },
  ),
);
