import { create } from "zustand";
import { persist } from "zustand/middleware";

import type {
  AudioCodec,
  MirrorOptions,
  VideoCodec,
} from "@/features/mirror/api";

export const BITRATE_RANGE = { min: 1, max: 20 } as const; // Mbps
export const MAX_SIZES = [0, 2560, 1920, 1600, 1280, 1024, 800] as const;
export const FRAME_RATES = [30, 60, 120] as const;
export const CODECS: VideoCodec[] = ["h264", "h265", "av1"];

/** Everything a mirroring session starts with. */
export interface MirrorPrefs {
  bitrateMbps: number;
  maxSize: number;
  maxFps: number;
  codec: VideoCodec;
  audio: boolean;
  screenOff: boolean;
  showTouches: boolean;
  stayAwake: boolean;
}

export const PREF_KEYS = [
  "bitrateMbps",
  "maxSize",
  "maxFps",
  "codec",
  "audio",
  "screenOff",
  "showTouches",
  "stayAwake",
] as const satisfies readonly (keyof MirrorPrefs)[];

/** What "Reset" in Settings › Mirroring goes back to. */
export const FACTORY_DEFAULTS: MirrorPrefs = {
  bitrateMbps: 8,
  maxSize: 1920,
  maxFps: 60,
  codec: "h264",
  audio: false,
  screenOff: false,
  showTouches: false,
  stayAwake: true,
};

export const pickPrefs = (s: MirrorPrefs): MirrorPrefs => ({
  bitrateMbps: s.bitrateMbps,
  maxSize: s.maxSize,
  maxFps: s.maxFps,
  codec: s.codec,
  audio: s.audio,
  screenOff: s.screenOff,
  showTouches: s.showTouches,
  stayAwake: s.stayAwake,
});

export const samePrefs = (a: MirrorPrefs, b: MirrorPrefs) =>
  PREF_KEYS.every((key) => a[key] === b[key]);

/** Keeps only known keys with the right types (old or edited storage). */
function sanitize(value: unknown): MirrorPrefs {
  const out = { ...FACTORY_DEFAULTS };
  if (!value || typeof value !== "object") return out;
  const v = value as Record<string, unknown>;
  for (const key of PREF_KEYS) {
    if (typeof v[key] === typeof FACTORY_DEFAULTS[key]) {
      (out as Record<string, unknown>)[key] = v[key];
    }
  }
  if (!CODECS.includes(out.codec)) out.codec = FACTORY_DEFAULTS.codec;
  return out;
}

interface MirrorSettings extends MirrorPrefs {
  /** Saved defaults every new session starts with (persisted). */
  defaults: MirrorPrefs;
  clipboardSync: boolean;
  panelOpen: boolean;
  /** Device whose session the flat values above belong to. */
  serial: string | null;
  /** Values of other devices mirrored earlier in this run (not persisted). */
  bySerial: Record<string, MirrorPrefs>;
  set: (
    patch: Partial<
      MirrorPrefs & Pick<MirrorSettings, "clipboardSync" | "panelOpen">
    >,
  ) => void;
  /** Switches the values to `serial`: its earlier values or the defaults. */
  activate: (serial: string) => void;
  /** Current values become the defaults. */
  saveAsDefaults: () => void;
  /** Current values go back to the saved defaults. */
  resetToDefaults: () => void;
  setDefaults: (patch: Partial<MirrorPrefs>) => void;
  /** Saved defaults go back to the factory values. */
  resetDefaults: () => void;
}

/**
 * Mirroring settings. The flat values are the current session's (the mirror
 * page's settings panel edits them); `defaults` are what each device's
 * first session in a run starts with (Settings › Mirroring edits them).
 */
export const useMirrorSettings = create<MirrorSettings>()(
  persist(
    (set, get) => ({
      ...FACTORY_DEFAULTS,
      defaults: FACTORY_DEFAULTS,
      clipboardSync: true,
      panelOpen: true,
      serial: null,
      bySerial: {},
      set: (patch) => set(patch),
      activate: (serial) => {
        const s = get();
        if (s.serial === serial) return;
        const bySerial = { ...s.bySerial };
        if (s.serial) bySerial[s.serial] = pickPrefs(s);
        set({ ...(bySerial[serial] ?? s.defaults), serial, bySerial });
      },
      saveAsDefaults: () => set((s) => ({ defaults: pickPrefs(s) })),
      resetToDefaults: () => set((s) => ({ ...s.defaults })),
      // Devices mirrored earlier take the new defaults next time.
      setDefaults: (patch) =>
        set((s) => ({ defaults: { ...s.defaults, ...patch }, bySerial: {} })),
      resetDefaults: () => set({ defaults: FACTORY_DEFAULTS, bySerial: {} }),
    }),
    {
      name: "tether.mirror",
      version: 1,
      partialize: ({ defaults, clipboardSync, panelOpen }) => ({
        defaults,
        clipboardSync,
        panelOpen,
      }),
      // Version 0 kept the last used values; they become the defaults.
      migrate: (persisted, version) => {
        const old = (persisted ?? {}) as Record<string, unknown>;
        return {
          defaults: sanitize(version === 0 ? old : old.defaults),
          clipboardSync: old.clipboardSync !== false,
          panelOpen: old.panelOpen !== false,
        };
      },
      // A new run starts from the saved defaults.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<MirrorSettings>;
        const defaults = sanitize(p.defaults);
        return {
          ...current,
          ...defaults,
          defaults,
          clipboardSync: p.clipboardSync ?? current.clipboardSync,
          panelOpen: p.panelOpen ?? current.panelOpen,
        };
      },
    },
  ),
);

/** The subset that needs a server restart when it changes. */
export function streamOptions(
  s: MirrorPrefs,
  audioCodec: AudioCodec,
): MirrorOptions {
  return {
    videoCodec: s.codec,
    maxSize: s.maxSize,
    videoBitRate: Math.round(s.bitrateMbps * 1_000_000),
    maxFps: s.maxFps,
    audio: s.audio,
    audioCodec,
    showTouches: s.showTouches,
    stayAwake: s.stayAwake,
  };
}
