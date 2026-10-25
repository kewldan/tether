import { create } from "zustand";
import { persist } from "zustand/middleware";

import { type Direction, ruleKey } from "@/features/ports/api";

export interface SavedRule {
  direction: Direction;
  local: string;
  remote: string;
  label?: string;
}

interface PortsState {
  /** Rules the user added, per serial; re-applied on reconnect. */
  saved: Record<string, SavedRule[]>;
  /** Last failure per `serial` → `ruleKey` (not persisted). */
  errors: Record<string, Record<string, string>>;
  save: (serial: string, rule: SavedRule) => void;
  unsave: (serial: string, direction: Direction, local: string) => void;
  setLabel: (
    serial: string,
    direction: Direction,
    local: string,
    label: string,
  ) => void;
  clear: (serial: string) => void;
  setError: (
    serial: string,
    direction: Direction,
    local: string,
    message: string | null,
  ) => void;
}

const same = (r: SavedRule, direction: Direction, local: string) =>
  r.direction === direction && r.local === local;

export const usePortsStore = create<PortsState>()(
  persist(
    (set) => ({
      saved: {},
      errors: {},
      save: (serial, rule) =>
        set((s) => {
          const list = s.saved[serial] ?? [];
          const previous = list.find((r) =>
            same(r, rule.direction, rule.local),
          );
          const next = list.filter((r) => !same(r, rule.direction, rule.local));
          next.push({ ...rule, label: rule.label ?? previous?.label });
          return { saved: { ...s.saved, [serial]: next } };
        }),
      unsave: (serial, direction, local) =>
        set((s) => ({
          saved: {
            ...s.saved,
            [serial]: (s.saved[serial] ?? []).filter(
              (r) => !same(r, direction, local),
            ),
          },
        })),
      setLabel: (serial, direction, local, label) =>
        set((s) => {
          const list = s.saved[serial] ?? [];
          const exists = list.some((r) => same(r, direction, local));
          return {
            saved: {
              ...s.saved,
              [serial]: exists
                ? list.map((r) =>
                    same(r, direction, local)
                      ? { ...r, label: label || undefined }
                      : r,
                  )
                : list,
            },
          };
        }),
      clear: (serial) =>
        set((s) => ({
          saved: { ...s.saved, [serial]: [] },
          errors: { ...s.errors, [serial]: {} },
        })),
      setError: (serial, direction, local, message) =>
        set((s) => {
          const current = { ...(s.errors[serial] ?? {}) };
          const key = ruleKey(direction, local);
          if (message === null) delete current[key];
          else current[key] = message;
          return { errors: { ...s.errors, [serial]: current } };
        }),
    }),
    {
      name: "tether.ports",
      partialize: (s) => ({ saved: s.saved }),
    },
  ),
);
