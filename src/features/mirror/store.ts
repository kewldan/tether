import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { MirrorOptions, VideoCodec } from "@/features/mirror/api";

export const BITRATE_RANGE = { min: 1, max: 20 } as const; // Mbps
export const MAX_SIZES = [0, 2560, 1920, 1600, 1280, 1024, 800] as const;
export const FRAME_RATES = [30, 60, 120] as const;
export const CODECS: VideoCodec[] = ["h264", "h265", "av1"];

export const STREAM_DEFAULTS = {
  bitrateMbps: 8,
  maxSize: 1920,
  maxFps: 60,
  codec: "h264" as VideoCodec,
};

interface MirrorSettings {
  bitrateMbps: number;
  maxSize: number;
  maxFps: number;
  codec: VideoCodec;
  screenOff: boolean;
  showTouches: boolean;
  stayAwake: boolean;
  audio: boolean;
  clipboardSync: boolean;
  panelOpen: boolean;
  set: (patch: Partial<Omit<MirrorSettings, "set" | "resetStream">>) => void;
  resetStream: () => void;
}

/** Mirroring preferences, shared by all devices and kept across launches. */
export const useMirrorSettings = create<MirrorSettings>()(
  persist(
    (set) => ({
      ...STREAM_DEFAULTS,
      screenOff: false,
      showTouches: false,
      stayAwake: true,
      audio: false,
      clipboardSync: true,
      panelOpen: true,
      set: (patch) => set(patch),
      resetStream: () => set(STREAM_DEFAULTS),
    }),
    {
      name: "tether.mirror",
      partialize: ({ set: _set, resetStream: _reset, ...rest }) => rest,
    },
  ),
);

/** The subset that needs a server restart when it changes. */
export function streamOptions(s: MirrorSettings): MirrorOptions {
  return {
    videoCodec: s.codec,
    maxSize: s.maxSize,
    videoBitRate: Math.round(s.bitrateMbps * 1_000_000),
    maxFps: s.maxFps,
    audio: s.audio,
    showTouches: s.showTouches,
    stayAwake: s.stayAwake,
  };
}
