import { create } from "zustand";
import { persist } from "zustand/middleware";

import {
  EMPTY_SPEC,
  type IntentKind,
  type IntentSpec,
  type Outcome,
} from "@/features/intents/api";

export interface HistoryEntry {
  id: string;
  time: number;
  kind: IntentKind;
  spec: IntentSpec;
  outcome: Outcome;
  /** Short failure text shown under the row. */
  message: string | null;
}

export interface Favorite {
  id: string;
  kind: IntentKind;
  spec: IntentSpec;
}

const MAX_HISTORY = 100;

interface IntentsState {
  deepLink: string;
  draft: IntentSpec;
  history: HistoryEntry[];
  favorites: Favorite[];
  setDeepLink: (deepLink: string) => void;
  setDraft: (draft: IntentSpec) => void;
  record: (entry: Omit<HistoryEntry, "id" | "time">) => void;
  clearHistory: () => void;
  addFavorite: (kind: IntentKind, spec: IntentSpec) => void;
  removeFavorite: (id: string) => void;
}

const sameSpec = (a: IntentSpec, b: IntentSpec) =>
  JSON.stringify(a) === JSON.stringify(b);

export const useIntentsStore = create<IntentsState>()(
  persist(
    (set) => ({
      deepLink: "",
      draft: EMPTY_SPEC,
      history: [],
      favorites: [],
      setDeepLink: (deepLink) => set({ deepLink }),
      setDraft: (draft) => set({ draft }),
      record: (entry) =>
        set((s) => ({
          history: [
            { ...entry, id: crypto.randomUUID(), time: Date.now() },
            // The latest run of the same intent replaces older ones.
            ...s.history.filter(
              (h) => !(h.kind === entry.kind && sameSpec(h.spec, entry.spec)),
            ),
          ].slice(0, MAX_HISTORY),
        })),
      clearHistory: () => set({ history: [] }),
      addFavorite: (kind, spec) =>
        set((s) =>
          s.favorites.some((f) => f.kind === kind && sameSpec(f.spec, spec))
            ? s
            : {
                favorites: [
                  { id: crypto.randomUUID(), kind, spec },
                  ...s.favorites,
                ],
              },
        ),
      removeFavorite: (id) =>
        set((s) => ({ favorites: s.favorites.filter((f) => f.id !== id) })),
    }),
    { name: "tether.intents" },
  ),
);
