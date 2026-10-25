import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { AppMeta } from "./api";

/** Labels and icons per device, filled by `load_app_meta`. */
interface MetaState {
  bySerial: Record<string, Record<string, AppMeta>>;
  merge: (serial: string, batch: AppMeta[]) => void;
}

export const useAppMetaStore = create<MetaState>()((set) => ({
  bySerial: {},
  merge: (serial, batch) =>
    set((s) => {
      const current = { ...(s.bySerial[serial] ?? {}) };
      for (const m of batch) current[m.package] = m;
      return { bySerial: { ...s.bySerial, [serial]: current } };
    }),
}));

const EMPTY: Record<string, AppMeta> = {};

export function useAppMeta(serial: string | null) {
  return useAppMetaStore((s) => (serial ? s.bySerial[serial] : null) ?? EMPTY);
}

export type Segment = "user" | "system" | "disabled" | "all";
export type SortKey = "name" | "updated" | "installed" | "size" | "package";

/** List filters, kept while visiting an app's details. */
interface ViewState {
  segment: Segment;
  query: string;
  sort: SortKey;
  descending: boolean;
  setSegment: (segment: Segment) => void;
  setQuery: (query: string) => void;
  setSort: (sort: SortKey, descending?: boolean) => void;
}

export const DEFAULT_DESCENDING: Record<SortKey, boolean> = {
  name: false,
  package: false,
  updated: true,
  installed: true,
  size: true,
};

export const useAppsView = create<ViewState>()(
  persist(
    (set, get) => ({
      segment: "user",
      query: "",
      sort: "updated",
      descending: true,
      setSegment: (segment) => set({ segment }),
      setQuery: (query) => set({ query }),
      setSort: (sort, descending) =>
        set({
          sort,
          descending:
            descending ??
            (get().sort === sort
              ? !get().descending
              : DEFAULT_DESCENDING[sort]),
        }),
    }),
    {
      name: "tether.apps.view",
      partialize: (s) => ({
        segment: s.segment,
        sort: s.sort,
        descending: s.descending,
      }),
    },
  ),
);
