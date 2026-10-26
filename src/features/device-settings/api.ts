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
  /** Primary system locale (BCP 47). */
  locale: string | null;
  /** Read only: the system language can be switched live (Android 16+). */
  localeSettable: boolean;
}

/** Settings the UI can change (everything but the read-only facts). */
export type DevKey = Exclude<
  keyof DevSettings,
  "physicalSize" | "physicalDensity" | "localeSettable"
>;

export type DevChange = {
  [K in DevKey]: { key: K; value: NonNullable<DevSettings[K]> | null };
}[DevKey];

export const readDevSettings = (serial: string) =>
  invoke<DevSettings>("read_dev_settings", { serial });

export const applyDevSetting = (serial: string, change: DevChange) =>
  invoke<DevSettings>("apply_dev_setting", { serial, change });

/** Locales the system language can be switched to (Android 16+). */
export const deviceLocales = (serial: string) =>
  invoke<string[]>("device_locales", { serial });

/** An app's own languages (Android 13+); empty = follows the system. */
export const appLocales = (serial: string, pkg: string) =>
  invoke<string[]>("app_locales", { serial, package: pkg });

/** Sets an app's languages and returns what the device reports after. */
export const setAppLocales = (serial: string, pkg: string, locales: string[]) =>
  invoke<string[]>("set_app_locales", { serial, package: pkg, locales });
