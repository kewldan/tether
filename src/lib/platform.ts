export type Os = "macos" | "windows" | "linux";

function detectOs(): Os {
  const ua = navigator.userAgent;
  if (/Mac OS X|Macintosh/.test(ua)) return "macos";
  if (/Windows/.test(ua)) return "windows";
  return "linux";
}

export const os: Os = detectOs();
export const isMac = os === "macos";

/** Label of the primary shortcut modifier: ⌘ on macOS, Ctrl elsewhere. */
export const modKey = isMac ? "⌘" : "Ctrl";

/** True when the platform's primary modifier is held. */
export function hasMod(event: KeyboardEvent | React.KeyboardEvent) {
  return isMac ? event.metaKey : event.ctrlKey;
}
