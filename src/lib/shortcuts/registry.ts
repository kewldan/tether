import type { SectionId } from "@/app/sections";
import type { Os } from "@/lib/platform";

/**
 * Every rebindable keyboard shortcut. Settings › Shortcuts lists them in
 * this order, detects conflicts between them and persists the user's
 * changes; hints in menus, tooltips and the palette read the current
 * binding from here.
 *
 * Adding a shortcut to a feature:
 * 1. Add an entry below. `keys` is the default as `Mod+Shift+KeyX`
 *    (`Mod` = ⌘ on macOS, Ctrl elsewhere; the key is a
 *    `KeyboardEvent.code`); `keysByOs` overrides it per platform.
 *    `scope: "page"` with `section` marks a shortcut that only acts on that
 *    page; it may reuse a combo of a shortcut on another page.
 * 2. Add its label to `shortcuts.<id>` in `locales/<lang>/settings.json`.
 * 3. Handle it with `useShortcut("<id>", handler)` from
 *    `@/lib/shortcuts` (mounted by the page or component that owns it);
 *    show its keys with `<ShortcutKbd id="<id>" />` or `useShortcutText`.
 */
export interface ShortcutDef {
  keys: string;
  keysByOs?: Partial<Record<Os, string>>;
  scope: "global" | "page";
  /** For page shortcuts: the page they act on. */
  section?: SectionId;
}

export const SHORTCUTS = {
  palette: { keys: "Mod+KeyK", scope: "global" },
  sidebar: { keys: "Mod+KeyB", scope: "global" },
  /** `Digits`: the n-th device for 1…9; only the modifiers are editable. */
  switch: { keys: "Mod+Digits", scope: "global" },
  devices: { keys: "Mod+KeyD", scope: "global" },
  wifi: { keys: "Mod+Shift+KeyW", scope: "global" },
  theme: { keys: "Mod+Shift+KeyL", scope: "global" },
  settings: { keys: "Mod+Comma", scope: "global" },
} satisfies Record<string, ShortcutDef>;

export type ShortcutId = keyof typeof SHORTCUTS;

export const SHORTCUT_IDS = Object.keys(SHORTCUTS) as ShortcutId[];
