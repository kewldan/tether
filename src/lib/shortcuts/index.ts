export {
  type Combo,
  comboFromEvent,
  comboKeys,
  comboProblem,
  comboText,
  DIGITS,
  parseCombo,
} from "@/lib/shortcuts/combo";
export {
  SHORTCUT_IDS,
  SHORTCUTS,
  type ShortcutDef,
  type ShortcutId,
} from "@/lib/shortcuts/registry";
export {
  ShortcutKbd,
  useShortcutText,
  useShortcutTitle,
} from "@/lib/shortcuts/ShortcutKbd";
export {
  bindingOf,
  conflictOf,
  defaultKeys,
  isCustomized,
  useBinding,
  useShortcuts,
} from "@/lib/shortcuts/store";
export { useShortcut } from "@/lib/shortcuts/useShortcut";
