import { create } from "zustand";

/** Result of the last grid action on one device, shown under its screen. */
export interface TileStatus {
  tone: "success" | "warning" | "error" | "info";
  text: string;
  /** Full output (shell commands), shown on demand. */
  detail?: string;
  busy?: boolean;
}

interface MultiState {
  /**
   * Ready devices left out of grid actions. Stored as exclusions so a
   * device that connects later joins the selection.
   */
  excluded: string[];
  /** Real screen size per serial, from the latest thumbnail. */
  screens: Record<string, { width: number; height: number }>;
  status: Record<string, TileStatus>;
  broadcast: boolean;
  /** Bumped after input so every live tile grabs a fresh frame. */
  tick: number;
  bump: () => void;
  setIncluded: (serial: string, on: boolean) => void;
  /** Keeps exactly `serials` selected out of `ready`. */
  selectOnly: (serials: string[], ready: string[]) => void;
  setScreen: (serial: string, width: number, height: number) => void;
  setStatus: (serial: string, status: TileStatus | null) => void;
  setBroadcast: (on: boolean) => void;
}

export const useMulti = create<MultiState>()((set) => ({
  excluded: [],
  screens: {},
  status: {},
  broadcast: false,
  tick: 0,
  bump: () => set((s) => ({ tick: s.tick + 1 })),
  setIncluded: (serial, on) =>
    set((s) => ({
      excluded: on
        ? s.excluded.filter((x) => x !== serial)
        : [...new Set([...s.excluded, serial])],
    })),
  selectOnly: (serials, ready) =>
    set({ excluded: ready.filter((x) => !serials.includes(x)) }),
  setScreen: (serial, width, height) =>
    set((s) => {
      const prev = s.screens[serial];
      if (prev?.width === width && prev.height === height) return s;
      return { screens: { ...s.screens, [serial]: { width, height } } };
    }),
  setStatus: (serial, status) =>
    set((s) => {
      const next = { ...s.status };
      if (status) next[serial] = status;
      else delete next[serial];
      return { status: next };
    }),
  setBroadcast: (broadcast) => set({ broadcast }),
}));
