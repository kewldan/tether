import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { DevKey, DevSettings } from "@/features/device-settings/api";

type Originals = Partial<Record<DevKey, DevSettings[DevKey]>>;

interface OriginalsState {
  /** Values before Tether first changed them, per device serial. */
  bySerial: Record<string, Originals>;
  /** Remembers `value` as the original unless one is already stored. */
  remember: <K extends DevKey>(
    serial: string,
    key: K,
    value: DevSettings[K],
  ) => void;
  forget: (serial: string, key?: DevKey) => void;
  /** Per-app languages before Tether changed them: serial → package → tags. */
  appLocales: Record<string, Record<string, string[]>>;
  rememberAppLocales: (serial: string, pkg: string, tags: string[]) => void;
  forgetAppLocales: (serial: string, pkg?: string) => void;
}

/**
 * Original values of developer toggles and per-app languages, kept in localStorage so "Restore
 * all original values" works across app restarts.
 */
export const useOriginals = create<OriginalsState>()(
  persist(
    (set) => ({
      bySerial: {},
      remember: (serial, key, value) =>
        set((s) => {
          const current = s.bySerial[serial] ?? {};
          if (key in current) return s;
          return {
            bySerial: { ...s.bySerial, [serial]: { ...current, [key]: value } },
          };
        }),
      forget: (serial, key) =>
        set((s) => {
          const bySerial = { ...s.bySerial };
          if (key === undefined) {
            delete bySerial[serial];
          } else {
            const next = { ...bySerial[serial] };
            delete next[key];
            bySerial[serial] = next;
          }
          return { bySerial };
        }),
      appLocales: {},
      rememberAppLocales: (serial, pkg, tags) =>
        set((s) => {
          const current = s.appLocales[serial] ?? {};
          if (pkg in current) return s;
          return {
            appLocales: {
              ...s.appLocales,
              [serial]: { ...current, [pkg]: tags },
            },
          };
        }),
      forgetAppLocales: (serial, pkg) =>
        set((s) => {
          const appLocales = { ...s.appLocales };
          if (pkg === undefined) {
            delete appLocales[serial];
          } else {
            const next = { ...appLocales[serial] };
            delete next[pkg];
            appLocales[serial] = next;
          }
          return { appLocales };
        }),
    }),
    { name: "tether.dev-settings.originals" },
  ),
);

export function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") {
    return Math.abs(a - b) < 1e-3;
  }
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** Keys whose current value differs from the remembered original. */
export function modifiedKeys(
  settings: DevSettings | undefined,
  originals: Originals | undefined,
): DevKey[] {
  if (!settings || !originals) return [];
  return (Object.keys(originals) as DevKey[]).filter(
    (k) => !sameValue(settings[k], originals[k]),
  );
}
