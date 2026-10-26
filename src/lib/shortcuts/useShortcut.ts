import { useEffect, useRef } from "react";

import { comboFromEvent, matchCombo } from "@/lib/shortcuts/combo";
import type { ShortcutId } from "@/lib/shortcuts/registry";
import { bindingOf, useShortcuts } from "@/lib/shortcuts/store";

/**
 * Runs `handler` when the shortcut's current binding is pressed. For a
 * `Digits` binding the pressed digit (1…9) is passed as the second
 * argument. Return `false` from the handler to leave the key alone (no
 * `preventDefault`), e.g. when there is nothing to act on.
 */
export function useShortcut(
  id: ShortcutId,
  handler: (e: KeyboardEvent, digit: number | null) => unknown,
  enabled = true,
) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || useShortcuts.getState().recording) return;
      const binding = bindingOf(id);
      const pressed = comboFromEvent(e);
      if (!binding || !pressed) return;
      const match = matchCombo(binding, pressed);
      if (match === false) return;
      const handled = ref.current(e, typeof match === "number" ? match : null);
      if (handled !== false) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [id, enabled]);
}
