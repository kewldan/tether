import { invoke } from "@tauri-apps/api/core";

import type { Size } from "@/features/overview/api";

export interface DevSettings {
  darkTheme: boolean | null;
  animationScale: number | null;
  fontScale: number | null;
  physicalSize: Size | null;
  /** `wm size` override; null = physical size. */
  screenSize: Size | null;
  physicalDensity: number | null;
  /** `wm density` override; null = physical density. */
  density: number | null;
  showTouches: boolean | null;
  pointerLocation: boolean | null;
  layoutBounds: boolean | null;
  gpuProfiling: boolean | null;
  stayAwake: boolean | null;
  demoMode: boolean | null;
  wifi: boolean | null;
  mobileData: boolean | null;
  airplane: boolean | null;
  /** Read only. */
  locale: string | null;
}

/** Settings the UI can change (everything but the read-only facts). */
export type DevKey = Exclude<
  keyof DevSettings,
  "physicalSize" | "physicalDensity" | "locale"
>;

export type DevChange = {
  [K in DevKey]: { key: K; value: NonNullable<DevSettings[K]> | null };
}[DevKey];

export const readDevSettings = (serial: string) =>
  invoke<DevSettings>("read_dev_settings", { serial });

export const applyDevSetting = (serial: string, change: DevChange) =>
  invoke<DevSettings>("apply_dev_setting", { serial, change });
