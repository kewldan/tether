import { isMac } from "@/lib/platform";

/**
 * A key combination. Stored as text such as `Mod+Shift+KeyW`: modifiers in
 * a fixed order, then a `KeyboardEvent.code`. `Mod` is ⌘ on macOS and Ctrl
 * elsewhere; `Ctrl` is the macOS Control key (on Windows and Linux it is the
 * same key as `Mod`). Codes are physical keys, so shortcuts keep working
 * with a Russian or any other layout. The pseudo code `Digits` stands for
 * 1…9 (device switching).
 */
export interface Combo {
  mod: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  code: string;
}

export const DIGITS = "Digits";

const MODIFIER_CODES = new Set([
  "ShiftLeft",
  "ShiftRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
  "OSLeft",
  "OSRight",
  "CapsLock",
  "Fn",
]);

export function parseCombo(text: string): Combo | null {
  if (!text) return null;
  const parts = text.split("+");
  const code = parts.pop();
  if (!code) return null;
  return {
    mod: parts.includes("Mod"),
    ctrl: parts.includes("Ctrl"),
    alt: parts.includes("Alt"),
    shift: parts.includes("Shift"),
    code,
  };
}

export function serializeCombo(combo: Combo): string {
  return [
    combo.mod && "Mod",
    combo.ctrl && "Ctrl",
    combo.alt && "Alt",
    combo.shift && "Shift",
    combo.code,
  ]
    .filter(Boolean)
    .join("+");
}

const PUNCTUATION: Record<string, string> = {
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  BracketLeft: "[",
  BracketRight: "]",
  Minus: "-",
  Equal: "=",
};

const CODE_OF_CHAR: Record<string, string> = Object.fromEntries(
  Object.entries(PUNCTUATION).map(([code, char]) => [char, code]),
);

/**
 * `KeyboardEvent.code` of a press. Real keyboards always set it; synthetic
 * events (automation, some IMEs) may not, so derive it from `key` then.
 */
function codeOf(e: Pick<KeyboardEvent, "code" | "key">): string {
  if (e.code && e.code !== "Unidentified") return e.code;
  const key = e.key ?? "";
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  if (key === " ") return "Space";
  if (CODE_OF_CHAR[key]) return CODE_OF_CHAR[key];
  if (key === "Control") return "ControlLeft";
  if (key === "Meta") return "MetaLeft";
  if (key === "Alt") return "AltLeft";
  if (key === "Shift") return "ShiftLeft";
  return key;
}

/** The combo a key press makes, or null for a bare modifier press. */
export function comboFromEvent(
  e: Pick<
    KeyboardEvent,
    "code" | "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
  >,
): Combo | null {
  const code = codeOf(e);
  if (!code || MODIFIER_CODES.has(code)) return null;
  // The Windows / Super key is the OS's; never part of our shortcuts.
  if (!isMac && e.metaKey) return null;
  return {
    mod: isMac ? e.metaKey : e.ctrlKey,
    ctrl: isMac && e.ctrlKey,
    alt: e.altKey,
    shift: e.shiftKey,
    code,
  };
}

/** 1…9 for `Digit1`…`Digit9` and the numpad, else null. */
export function digitOf(code: string): number | null {
  const m = /^(?:Digit|Numpad)([1-9])$/.exec(code);
  return m ? Number(m[1]) : null;
}

function sameModifiers(a: Combo, b: Combo) {
  return (
    a.mod === b.mod &&
    a.ctrl === b.ctrl &&
    a.alt === b.alt &&
    a.shift === b.shift
  );
}

/**
 * Whether `pressed` triggers `binding`. For a `Digits` binding the answer
 * is the digit (1…9), otherwise `true`; `false` when it doesn't match.
 */
export function matchCombo(binding: Combo, pressed: Combo): boolean | number {
  if (!sameModifiers(binding, pressed)) return false;
  if (binding.code === DIGITS) return digitOf(pressed.code) ?? false;
  return binding.code === pressed.code;
}

/** Two bindings that some key press would trigger both. */
export function combosOverlap(a: Combo, b: Combo): boolean {
  if (!sameModifiers(a, b)) return false;
  if (a.code === b.code) return true;
  if (a.code === DIGITS) return digitOf(b.code) !== null;
  if (b.code === DIGITS) return digitOf(a.code) !== null;
  return false;
}

/** Can stand alone as a shortcut without a modifier (function keys). */
function isFunctionKey(code: string) {
  return /^F([1-9]|1[0-9]|2[0-4])$/.test(code);
}

/**
 * Why a recorded combo can't be a shortcut: plain typing keys need ⌘/Ctrl,
 * Alt or (macOS) Control, and the clipboard / undo / quit keys stay with
 * the system.
 */
export function comboProblem(
  combo: Combo,
): "needsModifier" | "reserved" | null {
  const modified = combo.mod || combo.ctrl || combo.alt;
  if (!modified && !isFunctionKey(combo.code)) return "needsModifier";
  const text = serializeCombo(combo);
  if (RESERVED.has(text)) return "reserved";
  return null;
}

const RESERVED = new Set([
  "Mod+KeyA",
  "Mod+KeyC",
  "Mod+KeyV",
  "Mod+KeyX",
  "Mod+KeyZ",
  "Mod+Shift+KeyZ",
  "Mod+KeyY",
  ...(isMac ? ["Mod+KeyQ", "Mod+KeyH", "Mod+KeyM", "Mod+Alt+KeyH"] : []),
  ...(isMac ? [] : ["Alt+F4"]),
]);

const KEY_LABELS: Record<string, string> = {
  [DIGITS]: "1…9",
  ...PUNCTUATION,
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Enter: isMac ? "↩" : "Enter",
  Backspace: isMac ? "⌫" : "Backspace",
  Delete: isMac ? "⌦" : "Del",
  Tab: isMac ? "⇥" : "Tab",
  Space: "Space",
  Escape: "Esc",
  Home: "Home",
  End: "End",
  PageUp: "PgUp",
  PageDown: "PgDn",
};

export function keyLabel(code: string): string {
  if (KEY_LABELS[code]) return KEY_LABELS[code];
  const m = /^(?:Key|Digit)(.)$/.exec(code);
  if (m) return m[1];
  const numpad = /^Numpad(.+)$/.exec(code);
  if (numpad) return `Num${numpad[1]}`;
  return code;
}

/**
 * Keycaps for display: `["⌘", "⇧", "W"]` on macOS (Apple's ⌃⌥⇧⌘ order),
 * `["Ctrl", "Shift", "W"]` elsewhere.
 */
export function comboKeys(combo: Combo): string[] {
  const keys = isMac
    ? [
        combo.ctrl && "⌃",
        combo.alt && "⌥",
        combo.shift && "⇧",
        combo.mod && "⌘",
      ]
    : [combo.mod && "Ctrl", combo.alt && "Alt", combo.shift && "Shift"];
  return [...keys.filter((k): k is string => !!k), keyLabel(combo.code)];
}

/** One-line form for tooltips and menus: `⌘⇧W` / `Ctrl+Shift+W`. */
export function comboText(combo: Combo): string {
  return comboKeys(combo).join(isMac ? "" : "+");
}
