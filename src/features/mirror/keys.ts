import type { ControlMessage } from "@/features/mirror/api";

/** Android `KeyEvent.KEYCODE_*` for keys that are not plain text. */
const SPECIAL: Record<string, number> = {
  Enter: 66,
  NumpadEnter: 66,
  Backspace: 67,
  Delete: 112,
  Tab: 61,
  Escape: 111,
  ArrowUp: 19,
  ArrowDown: 20,
  ArrowLeft: 21,
  ArrowRight: 22,
  Home: 122,
  End: 123,
  PageUp: 92,
  PageDown: 93,
  Insert: 124,
  Space: 62,
};

/** `KeyEvent.META_*` (left variants, as scrcpy sends them). */
function metastate(e: KeyboardEvent): number {
  let meta = 0;
  if (e.shiftKey) meta |= 0x01 | 0x40;
  if (e.altKey) meta |= 0x02 | 0x10;
  if (e.ctrlKey) meta |= 0x1000 | 0x2000;
  if (e.metaKey) meta |= 0x10000 | 0x20000;
  return meta;
}

/** Keycode for a physical key (`KeyboardEvent.code`), or null. */
export function androidKeycode(code: string): number | null {
  if (code in SPECIAL) return SPECIAL[code] ?? null;
  const letter = /^Key([A-Z])$/.exec(code)?.[1];
  if (letter) return 29 + letter.charCodeAt(0) - 65; // KEYCODE_A..Z
  const digit = /^Digit(\d)$/.exec(code)?.[1];
  if (digit) return 7 + Number(digit); // KEYCODE_0..9
  return null;
}

/**
 * Translates a keydown/keyup into control messages. Printable characters
 * without shortcut modifiers go as text (keyboard-layout independent);
 * everything else as key events with the meta state.
 */
export function keyMessages(
  e: KeyboardEvent,
  action: "down" | "up",
): ControlMessage[] {
  const shortcut = e.ctrlKey || e.metaKey || e.altKey;
  const printable = e.key.length === 1 || /^\p{L}$/u.test(e.key);
  if (printable && !shortcut && e.code !== "Space") {
    return action === "down" ? [{ type: "text", text: e.key }] : [];
  }
  const keycode = androidKeycode(e.code);
  if (keycode === null) return [];
  return [
    {
      type: "key",
      action,
      keycode,
      repeat: e.repeat ? 1 : 0,
      metastate: metastate(e),
    },
  ];
}
