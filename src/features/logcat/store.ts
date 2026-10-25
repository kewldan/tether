import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { BufferName } from "./api";
import { DEFAULT_FILTER, type LogFilter } from "./filter";

export interface Preset {
  id: string;
  /** Built-in presets carry a translation key instead of a user name. */
  name: string;
  builtin?: "warnings" | "network" | "crashes";
  filter: LogFilter;
}

const BUILTIN_PRESETS: Preset[] = [
  {
    id: "warnings",
    name: "",
    builtin: "warnings",
    filter: {
      ...DEFAULT_FILTER,
      levels: { V: false, D: false, I: false, W: true, E: true, F: true },
    },
  },
  {
    id: "network",
    name: "",
    builtin: "network",
    filter: { ...DEFAULT_FILTER, includeTags: ["OkHttp"] },
  },
  {
    id: "crashes",
    name: "",
    builtin: "crashes",
    filter: { ...DEFAULT_FILTER, onlyCrashes: true },
  },
];

interface LogcatUiState {
  filter: LogFilter;
  buffers: BufferName[];
  wrap: boolean;
  presets: Preset[];
  setFilter: (patch: Partial<LogFilter>) => void;
  resetFilter: () => void;
  applyPreset: (id: string) => void;
  savePreset: (name: string) => void;
  deletePreset: (id: string) => void;
  setBuffers: (buffers: BufferName[]) => void;
  toggleWrap: () => void;
}

/** Comparable form of a filter; the highlight toggle is a view option. */
const normalize = (f: LogFilter) =>
  JSON.stringify({
    ...DEFAULT_FILTER,
    ...f,
    highlight: false,
    includeTags: [...f.includeTags].sort(),
    excludeTags: [...f.excludeTags].sort(),
  });

/** The preset that exactly matches the current filter, if any. */
export function activePreset(
  presets: Preset[],
  filter: LogFilter,
): Preset | null {
  const current = normalize(filter);
  return presets.find((p) => normalize(p.filter) === current) ?? null;
}

/** Logcat filters, view options and saved presets; kept in localStorage. */
export const useLogcatUi = create<LogcatUiState>()(
  persist(
    (set, get) => ({
      filter: DEFAULT_FILTER,
      buffers: ["main", "system", "crash"],
      wrap: true,
      presets: BUILTIN_PRESETS,
      setFilter: (patch) => set((s) => ({ filter: { ...s.filter, ...patch } })),
      resetFilter: () =>
        set((s) => ({
          filter: { ...DEFAULT_FILTER, highlight: s.filter.highlight },
        })),
      applyPreset: (id) => {
        const preset = get().presets.find((p) => p.id === id);
        if (preset)
          set((s) => ({
            filter: {
              ...DEFAULT_FILTER,
              ...preset.filter,
              highlight: s.filter.highlight,
            },
          }));
      },
      savePreset: (name) =>
        set((s) => ({
          presets: [
            ...s.presets,
            { id: crypto.randomUUID(), name, filter: { ...s.filter } },
          ],
        })),
      deletePreset: (id) =>
        set((s) => ({ presets: s.presets.filter((p) => p.id !== id) })),
      setBuffers: (buffers) => set({ buffers }),
      toggleWrap: () => set((s) => ({ wrap: !s.wrap })),
    }),
    {
      name: "tether.logcat",
      version: 1,
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<LogcatUiState>;
        return {
          ...current,
          ...p,
          filter: { ...DEFAULT_FILTER, ...p.filter },
        };
      },
    },
  ),
);
