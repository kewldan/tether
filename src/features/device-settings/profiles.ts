import type { TFunction } from "i18next";
import { create } from "zustand";
import { persist } from "zustand/middleware";

import {
  applyDevSetting,
  type DevChange,
  type DevKey,
  type DevSettings,
  readDevSettings,
} from "@/features/device-settings/api";
import { sameValue, useOriginals } from "@/features/device-settings/originals";
import type { AppError, Transport } from "@/lib/tauri";

export type ProfileIcon = "camera" | "gauge" | "type" | "sliders";

export interface DevProfile {
  id: string;
  name: string;
  icon: ProfileIcon;
  /** Applied in order. */
  changes: DevChange[];
  /** Id of the built-in preset it came from (its name is translated). */
  builtin?: string;
}

/** Keys a profile can hold, in the order they are applied and listed. */
export const PROFILE_KEYS: DevKey[] = [
  "darkTheme",
  "animationScale",
  "fontScale",
  "screenSize",
  "density",
  "demoMode",
  "showTouches",
  "pointerLocation",
  "layoutBounds",
  "gpuProfiling",
  "stayAwake",
  "wifi",
  "mobileData",
  "airplane",
];

/** `null` means "reset the override", not "unsupported". */
const NULLABLE: DevKey[] = ["screenSize", "density"];

export const BUILTIN_PROFILES: DevProfile[] = [
  {
    id: "builtin-store-screenshots",
    builtin: "storeScreenshots",
    name: "Store screenshots",
    icon: "camera",
    changes: [
      { key: "demoMode", value: true },
      { key: "darkTheme", value: true },
      { key: "animationScale", value: 0 },
      { key: "fontScale", value: 1 },
    ],
  },
  {
    id: "builtin-performance-test",
    builtin: "performanceTest",
    name: "Performance test",
    icon: "gauge",
    changes: [
      { key: "animationScale", value: 1 },
      { key: "gpuProfiling", value: true },
      { key: "stayAwake", value: true },
      { key: "wifi", value: true },
      { key: "mobileData", value: false },
    ],
  },
  {
    id: "builtin-large-text",
    builtin: "largeText",
    name: "Large text",
    icon: "type",
    changes: [
      { key: "fontScale", value: 1.3 },
      { key: "density", value: 360 },
    ],
  },
];

interface ProfilesState {
  profiles: DevProfile[];
  add: (name: string, changes: DevChange[]) => DevProfile;
  rename: (id: string, name: string) => void;
  remove: (id: string) => void;
  restoreBuiltins: () => void;
}

/** Saved developer-toggle profiles, kept in localStorage. */
export const useProfiles = create<ProfilesState>()(
  persist(
    (set) => ({
      profiles: BUILTIN_PROFILES,
      add: (name, changes) => {
        const profile: DevProfile = {
          id: `profile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          name,
          icon: "sliders",
          changes,
        };
        set((s) => ({ profiles: [...s.profiles, profile] }));
        return profile;
      },
      rename: (id, name) =>
        set((s) => ({
          profiles: s.profiles.map((p) =>
            // A renamed preset keeps its icon but is no longer translated.
            p.id === id ? { ...p, name, builtin: undefined } : p,
          ),
        })),
      remove: (id) =>
        set((s) => ({ profiles: s.profiles.filter((p) => p.id !== id) })),
      restoreBuiltins: () =>
        set((s) => ({
          profiles: [
            ...BUILTIN_PROFILES.filter(
              (b) => !s.profiles.some((p) => p.id === b.id),
            ),
            ...s.profiles,
          ],
        })),
    }),
    { name: "tether.dev-settings.profiles", version: 1 },
  ),
);

export function profileName(profile: DevProfile, t: TFunction): string {
  return profile.builtin
    ? t(`device-settings:profiles.builtin.${profile.builtin}`, {
        defaultValue: profile.name,
      })
    : profile.name;
}

const fmtScale = (v: number) =>
  Number.isInteger(v) ? v.toFixed(1) : String(v);

/** One change as a short phrase: "animations 0", "GPU bars on". */
export function describeChange(change: DevChange, t: TFunction): string {
  const p = (key: string, values?: Record<string, unknown>) =>
    t(`device-settings:profiles.change.${key}`, values);
  const onOff = (v: boolean | null) => p(v ? "on" : "off");
  switch (change.key) {
    case "animationScale":
      return p("animationScale", { value: change.value ?? 1 });
    case "fontScale":
      return p("fontScale", { value: fmtScale(change.value ?? 1) });
    case "density":
      return change.value === null
        ? p("densityReset")
        : p("density", { value: change.value });
    case "screenSize":
      return change.value === null
        ? p("sizeReset")
        : p("size", { w: change.value.width, h: change.value.height });
    default:
      return `${p(change.key)} ${onOff(change.value)}`;
  }
}

export const capitalize = (s: string) =>
  s.charAt(0).toLocaleUpperCase() + s.slice(1);

/** "Demo mode on · dark theme on · animations 0 · font 1.0". */
export function describeProfile(profile: DevProfile, t: TFunction): string {
  return capitalize(
    profile.changes.map((c) => describeChange(c, t)).join(" · "),
  );
}

/** Some of the profile's keys have a remembered original to go back to. */
export function canRevert(
  profile: DevProfile,
  originals: Partial<Record<DevKey, unknown>> | undefined,
): boolean {
  return profile.changes.some(
    (c) => originals !== undefined && c.key in originals,
  );
}

/** Every change already matches the device. */
export function isApplied(
  profile: DevProfile,
  settings: DevSettings | undefined,
): boolean {
  if (!settings || profile.changes.length === 0) return false;
  return profile.changes.every(
    (c) =>
      // Unsupported on this device: skipped when applying.
      (settings[c.key] === null && !NULLABLE.includes(c.key)) ||
      sameValue(settings[c.key], c.value),
  );
}

/** A change that would cut a wireless adb session. */
function cutsWireless(change: DevChange, transport: Transport): boolean {
  if (transport !== "wifi") return false;
  return (
    (change.key === "wifi" && change.value === false) ||
    (change.key === "airplane" && change.value === true)
  );
}

export interface ApplyResult {
  settings: DevSettings;
  applied: DevKey[];
  /** Not supported by the device, or skipped to keep a Wi-Fi session. */
  skipped: DevKey[];
  failed: { key: DevKey; message: string }[];
}

/**
 * Applies a profile to one device. Originals are remembered first, so
 * "Restore all original values" and per-profile Revert keep working.
 */
export async function applyProfile(
  serial: string,
  transport: Transport,
  profile: DevProfile,
  current?: DevSettings,
): Promise<ApplyResult> {
  let settings = current ?? (await readDevSettings(serial));
  const { remember } = useOriginals.getState();
  const result: ApplyResult = {
    settings,
    applied: [],
    skipped: [],
    failed: [],
  };
  for (const change of profile.changes) {
    const value = settings[change.key];
    if (
      (value === null && !NULLABLE.includes(change.key)) ||
      cutsWireless(change, transport)
    ) {
      result.skipped.push(change.key);
      continue;
    }
    if (sameValue(value, change.value)) continue;
    remember(serial, change.key, value);
    try {
      settings = await applyDevSetting(serial, change);
      result.applied.push(change.key);
    } catch (error) {
      result.failed.push({
        key: change.key,
        message: (error as Partial<AppError>)?.message ?? String(error),
      });
    }
  }
  result.settings = settings;
  return result;
}

/** Puts the profile's keys back to their remembered originals. */
export async function revertProfile(
  serial: string,
  profile: DevProfile,
  current: DevSettings,
): Promise<DevSettings> {
  const { bySerial, forget } = useOriginals.getState();
  const originals = bySerial[serial] ?? {};
  let settings = current;
  for (const { key } of profile.changes) {
    if (!(key in originals)) continue;
    const original = originals[key];
    if (
      !sameValue(settings[key], original) &&
      (original !== null || NULLABLE.includes(key))
    )
      settings = await applyDevSetting(serial, {
        key,
        value: original,
      } as DevChange);
    forget(serial, key);
  }
  return settings;
}

/** Changes that capture `settings` for the chosen keys. */
export function changesFrom(
  settings: DevSettings,
  keys: DevKey[],
): DevChange[] {
  return PROFILE_KEYS.filter(
    (k) => keys.includes(k) && (settings[k] !== null || NULLABLE.includes(k)),
  ).map((key) => ({ key, value: settings[key] }) as DevChange);
}
