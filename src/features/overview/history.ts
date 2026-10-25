import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Small per-device log of things the user did through Tether, shown as
 * "Recent" on the Overview page. Any feature may append to it:
 *
 *   recordHistory({ serial, kind: "install", label: "shop-2.14.0.apk" })
 */
export type HistoryKind =
  | "screenshot"
  | "recording"
  | "install"
  | "uninstall"
  | "shell"
  | "bugreport"
  | "reboot"
  | "settings"
  | "file"
  | "other";

export interface HistoryEntry {
  id: string;
  serial: string;
  kind: HistoryKind;
  /** File name, command line or short description. */
  label: string;
  /** ms since epoch. */
  at: number;
  /** Local file the entry refers to, if any (captures, bugreports). */
  path?: string;
}

const MAX_PER_DEVICE = 50;

interface HistoryState {
  entries: HistoryEntry[];
  add: (entry: Omit<HistoryEntry, "id" | "at"> & { at?: number }) => void;
  clear: (serial: string) => void;
}

export const useHistory = create<HistoryState>()(
  persist(
    (set) => ({
      entries: [],
      add: (entry) =>
        set((s) => {
          const full: HistoryEntry = {
            ...entry,
            at: entry.at ?? Date.now(),
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          };
          const same = s.entries.filter((e) => e.serial === entry.serial);
          const others = s.entries.filter((e) => e.serial !== entry.serial);
          return {
            entries: [full, ...same].slice(0, MAX_PER_DEVICE).concat(others),
          };
        }),
      clear: (serial) =>
        set((s) => ({ entries: s.entries.filter((e) => e.serial !== serial) })),
    }),
    { name: "tether.history" },
  ),
);

/** Appends an entry from anywhere (not only React components). */
export const recordHistory = (
  entry: Omit<HistoryEntry, "id" | "at"> & { at?: number },
) => useHistory.getState().add(entry);
