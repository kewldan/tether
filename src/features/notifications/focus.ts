/**
 * Whether the Tether window is the active window. WebKit, WebView2 and
 * WebKitGTK fire `focus` / `blur` on the page when the native window gains
 * or loses key status, and a hidden window is never focused.
 */
let focused = document.hasFocus();
const listeners = new Set<(focused: boolean) => void>();

function set(next: boolean) {
  if (next === focused) return;
  focused = next;
  for (const listener of listeners) listener(next);
}

window.addEventListener("focus", () => set(true));
window.addEventListener("blur", () => set(false));
document.addEventListener("visibilitychange", () => {
  set(!document.hidden && document.hasFocus());
});

export const isWindowFocused = () => focused && !document.hidden;

/** Calls `listener` whenever the window gains or loses focus. */
export function onWindowFocusChange(listener: (focused: boolean) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
