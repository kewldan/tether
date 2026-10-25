import "@xterm/xterm/css/xterm.css";

import { openUrl } from "@tauri-apps/plugin-opener";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { type ITheme, Terminal } from "@xterm/xterm";

import { errorMessage } from "@/features/performance/common";
import {
  closeShell,
  execShell,
  LineTracker,
  openShell,
  resizeShell,
  writeShell,
} from "@/features/shell/api";
import { useShellStore } from "@/features/shell/store";
import { hasMod } from "@/lib/platform";

/**
 * Terminal sessions live outside React so they survive page switches:
 * each owns an xterm instance, its DOM element (moved into whichever
 * container shows it) and the backend PTY session.
 */
class ShellSession {
  readonly term: Terminal;
  readonly el: HTMLDivElement;
  private readonly fit = new FitAddon();
  private readonly tracker = new LineTracker();
  private backendId: number | null = null;
  private v2 = true;
  private opened = false;
  private exited = false;
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly uid: string,
    readonly serial: string,
    private readonly cwd: string | null,
  ) {
    this.el = document.createElement("div");
    this.el.className = "h-full w-full";
    this.term = new Terminal({
      fontFamily:
        '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, monospace',
      fontSize: 12.5,
      lineHeight: 1.6,
      cursorBlink: true,
      allowProposedApi: false,
      scrollback: 10_000,
      macOptionIsMeta: true,
      theme: readTheme(),
    });
    this.term.loadAddon(this.fit);
    this.term.loadAddon(
      new WebLinksAddon((_event, uri) => {
        openUrl(uri).catch(() => window.open(uri, "_blank", "noopener"));
      }),
    );
    this.term.attachCustomKeyEventHandler((e) => {
      // ⌘K / Ctrl+K clears this terminal instead of opening the palette.
      if (e.type === "keydown" && hasMod(e) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        e.stopPropagation();
        this.term.clear();
        return false;
      }
      // ⌘T is handled by the page (new tab).
      if (hasMod(e) && e.key.toLowerCase() === "t") return false;
      return true;
    });
    this.term.onData((data) => this.input(data));
    this.term.onResize(({ cols, rows }) => this.resized(cols, rows));
  }

  /** Puts the terminal into `container` and starts the PTY on first use. */
  attach(container: HTMLElement) {
    if (this.el.parentElement !== container) container.appendChild(this.el);
    if (!this.opened) {
      this.opened = true;
      this.term.open(this.el);
      this.fitNow();
      void this.connect();
    } else {
      this.fitNow();
    }
  }

  fitNow() {
    if (!this.el.isConnected || this.el.clientWidth === 0) return;
    try {
      this.fit.fit();
    } catch {
      // Not measurable yet (hidden); the next attach fits again.
    }
  }

  focus() {
    this.term.focus();
  }

  clear() {
    this.term.clear();
  }

  /** Sends text as if typed (snippets, history). */
  type(text: string) {
    if (this.exited) return;
    this.input(text);
  }

  private async connect() {
    const meta = useShellStore.getState();
    this.exited = false;
    meta.patchSession(this.uid, { status: "connecting", error: null });
    try {
      const info = await openShell(
        this.serial,
        { cols: this.term.cols, rows: this.term.rows },
        this.cwd,
        (bytes) => this.term.write(bytes),
        (code) => this.ended(code),
      );
      if (this.disposed) {
        void closeShell(info.id);
        return;
      }
      this.backendId = info.id;
      this.v2 = info.v2;
      useShellStore.getState().patchSession(this.uid, {
        status: "running",
        cols: this.term.cols,
        rows: this.term.rows,
      });
      void this.probeUser();
    } catch (e) {
      this.exited = true;
      const message = errorMessage(e);
      this.term.write(`\r\n\x1b[31m${message}\x1b[0m\r\n`);
      this.term.write("\x1b[2mPress Enter to reconnect.\x1b[0m\r\n");
      useShellStore
        .getState()
        .patchSession(this.uid, { status: "error", error: message });
    }
  }

  private async probeUser() {
    try {
      const out = await execShell(this.serial, "id -u; command -v su");
      const [uid, su] = out.stdout.split("\n");
      useShellStore.getState().patchSession(this.uid, {
        user: uid?.trim() === "0" ? "root" : "sh",
        hasSu: Boolean(su?.trim()),
      });
    } catch {
      // Purely cosmetic.
    }
  }

  private ended(code: number | null) {
    this.exited = true;
    this.backendId = null;
    const suffix = code === null ? "" : ` (exit code ${code})`;
    this.term.write(
      `\r\n\x1b[2m[session ended${suffix}] Press Enter to reconnect.\x1b[0m\r\n`,
    );
    useShellStore
      .getState()
      .patchSession(this.uid, { status: "exited", exitCode: code });
  }

  private input(data: string) {
    if (this.exited) {
      if (data.includes("\r")) {
        this.term.reset();
        void this.connect();
      }
      return;
    }
    if (this.backendId === null) return;
    for (const command of this.tracker.feed(data)) {
      useShellStore.getState().remember(command);
    }
    writeShell(this.backendId, data).catch(() => {});
  }

  private resized(cols: number, rows: number) {
    useShellStore.getState().patchSession(this.uid, { cols, rows });
    if (this.backendId === null || !this.v2) return;
    const id = this.backendId;
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      resizeShell(id, cols, rows).catch(() => {});
    }, 60);
  }

  private disposed = false;

  dispose() {
    this.disposed = true;
    if (this.backendId !== null) void closeShell(this.backendId);
    this.backendId = null;
    this.term.dispose();
    this.el.remove();
  }
}

const registry = new Map<string, ShellSession>();

export function getSession(uid: string): ShellSession | undefined {
  return registry.get(uid);
}

/** Creates a session for `serial`; it connects when first attached. */
export function createSession(serial: string, cwd: string | null = null) {
  const uid = crypto.randomUUID();
  registry.set(uid, new ShellSession(uid, serial, cwd));
  const store = useShellStore.getState();
  store.upsertSession({
    uid,
    serial,
    status: "connecting",
    exitCode: null,
    user: "sh",
    hasSu: null,
    cols: 80,
    rows: 24,
    error: null,
  });
  store.setActive(uid);
  return uid;
}

export function destroySession(uid: string) {
  registry.get(uid)?.dispose();
  registry.delete(uid);
  useShellStore.getState().removeSession(uid);
}

// ---------------------------------------------------------------- theme

function cssVar(style: CSSStyleDeclaration, name: string) {
  return style.getPropertyValue(name).trim();
}

/** `#rrggbb` + alpha → `#rrggbbaa` (xterm accepts it). */
function withAlpha(hex: string, alpha: number) {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return hex;
  const a = Math.round(alpha * 255)
    .toString(16)
    .padStart(2, "0");
  return `${hex}${a}`;
}

/** Terminal palette from the design tokens in index.css. */
export function readTheme(): ITheme {
  const s = getComputedStyle(document.documentElement);
  const v = (n: string) => cssVar(s, n);
  return {
    background: v("--background"),
    foreground: v("--foreground"),
    cursor: v("--foreground"),
    cursorAccent: v("--background"),
    selectionBackground: withAlpha(v("--brand"), 0.3),
    black: v("--muted"),
    red: v("--error"),
    green: v("--success"),
    yellow: v("--warning"),
    blue: v("--info"),
    magenta: v("--log-f"),
    cyan: v("--chart-3"),
    white: v("--secondary-foreground"),
    brightBlack: v("--muted-foreground"),
    brightRed: v("--error"),
    brightGreen: v("--success"),
    brightYellow: v("--warning"),
    brightBlue: v("--chart-1"),
    brightMagenta: v("--chart-4"),
    brightCyan: v("--chart-3"),
    brightWhite: v("--foreground"),
  };
}

// Re-theme every terminal when the app switches light/dark.
new MutationObserver(() => {
  const theme = readTheme();
  for (const session of registry.values()) session.term.options.theme = theme;
}).observe(document.documentElement, {
  attributes: true,
  attributeFilter: ["class"],
});
