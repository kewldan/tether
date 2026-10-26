import { create } from "zustand";
import { persist } from "zustand/middleware";

import { os } from "@/lib/platform";
import {
  type Combo,
  combosOverlap,
  parseCombo,
  serializeCombo,
} from "@/lib/shortcuts/combo";
import {
  SHORTCUT_IDS,
  SHORTCUTS,
  type ShortcutDef,
  type ShortcutId,
} from "@/lib/shortcuts/registry";

interface ShortcutsState {
  /** User bindings; `""` = no shortcut. Missing ids use the default. */
  overrides: Partial<Record<ShortcutId, string>>;
  /** True while Settings records a combo: shortcuts don't fire then. */
  recording: boolean;
  bind: (id: ShortcutId, combo: Combo | null) => void;
  reset: (id: ShortcutId) => void;
  resetAll: () => void;
  setRecording: (recording: boolean) => void;
}

export const useShortcuts = create<ShortcutsState>()(
  persist(
    (set) => ({
      overrides: {},
      recording: false,
      bind: (id, combo) =>
        set((s) => {
          const value = combo ? serializeCombo(combo) : "";
          const overrides = { ...s.overrides, [id]: value };
          if (value === defaultKeys(id)) delete overrides[id];
          return { overrides };
        }),
      reset: (id) =>
        set((s) => {
          const overrides = { ...s.overrides };
          delete overrides[id];
          return { overrides };
        }),
      resetAll: () => set({ overrides: {} }),
      setRecording: (recording) => set({ recording }),
    }),
    {
      name: "tether.shortcuts",
      partialize: (s) => ({ overrides: s.overrides }),
    },
  ),
);

export function defaultKeys(id: ShortcutId): string {
  const def: ShortcutDef = SHORTCUTS[id];
  return def.keysByOs?.[os] ?? def.keys;
}

function keysFor(
  id: ShortcutId,
  overrides: ShortcutsState["overrides"],
): string {
  return overrides[id] ?? defaultKeys(id);
}

/** Current combo of a shortcut, or null when it was cleared. */
export function bindingOf(
  id: ShortcutId,
  overrides = useShortcuts.getState().overrides,
): Combo | null {
  return parseCombo(keysFor(id, overrides));
}

/** Reactive {@link bindingOf}. */
export function useBinding(id: ShortcutId): Combo | null {
  const keys = useShortcuts((s) => keysFor(id, s.overrides));
  return parseCombo(keys);
}

export function isCustomized(
  id: ShortcutId,
  overrides: ShortcutsState["overrides"],
): boolean {
  return id in overrides;
}

/** Whether two shortcuts can be active at the same time. */
function canCollide(a: ShortcutDef, b: ShortcutDef) {
  if (a.scope === "global" || b.scope === "global") return true;
  return a.section === b.section;
}

/** The other shortcut `combo` would clash with if given to `id`. */
export function conflictOf(
  id: ShortcutId,
  combo: Combo,
  overrides = useShortcuts.getState().overrides,
): ShortcutId | null {
  const def: ShortcutDef = SHORTCUTS[id];
  for (const other of SHORTCUT_IDS) {
    if (other === id || !canCollide(def, SHORTCUTS[other])) continue;
    const bound = bindingOf(other, overrides);
    if (bound && combosOverlap(bound, combo)) return other;
  }
  return null;
}
