import { Kbd } from "@/components/ui/kbd";
import {
  type Combo,
  comboKeys,
  comboText,
  DIGITS,
  digitOf,
} from "@/lib/shortcuts/combo";
import type { ShortcutId } from "@/lib/shortcuts/registry";
import { useBinding } from "@/lib/shortcuts/store";
import { cn } from "@/lib/utils";

/** `Digits` bindings shown for one digit (`⌘3` for the third device). */
function withDigit(combo: Combo, digit?: number): Combo {
  if (combo.code !== DIGITS || digit === undefined) return combo;
  return { ...combo, code: `Digit${digit}` };
}

/** One-line hint for a shortcut (`⌘⇧W`), or null when it is unbound. */
export function useShortcutText(id: ShortcutId, digit?: number) {
  const combo = useBinding(id);
  return combo ? comboText(withDigit(combo, digit)) : null;
}

/** Appends the shortcut to a tooltip text: `Collapse sidebar (⌘B)`. */
export function useShortcutTitle(label: string, id: ShortcutId) {
  const text = useShortcutText(id);
  return text ? `${label} (${text})` : label;
}

/**
 * The current keys of a shortcut. `split` draws one keycap per key (as in
 * Settings); otherwise the whole combo sits in one keycap, as in menus.
 * Renders nothing when the shortcut is unbound.
 */
export function ShortcutKbd({
  id,
  digit,
  split,
  className,
}: {
  id: ShortcutId;
  /** For `switch`: show the binding for this digit. */
  digit?: number;
  split?: boolean;
  className?: string;
}) {
  const combo = useBinding(id);
  if (!combo || (digit !== undefined && digitOf(`Digit${digit}`) === null)) {
    return null;
  }
  const shown = withDigit(combo, digit);
  if (!split) {
    return <Kbd className={className}>{comboText(shown)}</Kbd>;
  }
  return (
    <span className={cn("flex gap-[3px]", className)}>
      {comboKeys(shown).map((k) => (
        <Kbd key={k}>{k}</Kbd>
      ))}
    </span>
  );
}
