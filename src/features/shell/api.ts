import { Channel, invoke } from "@tauri-apps/api/core";

/** Message tags of the binary output channel (see commands/shell.rs). */
const TAG_OUTPUT = 1;
const TAG_EXIT = 3;

export interface ShellSessionInfo {
  id: number;
  /** False on devices without shell v2: no resize, no exit code. */
  v2: boolean;
}

export interface CommandOutput {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/**
 * Opens an interactive PTY session. Output arrives as raw bytes (one
 * `ArrayBuffer` per socket read, no JSON); `onExit` fires once with the
 * exit code, or null when unknown (legacy shell, device gone).
 */
export function openShell(
  serial: string,
  size: { cols: number; rows: number },
  cwd: string | null,
  onData: (bytes: Uint8Array) => void,
  onExit: (code: number | null) => void,
) {
  const channel = new Channel<ArrayBuffer>();
  channel.onmessage = (buffer) => {
    const bytes = new Uint8Array(buffer);
    if (bytes[0] === TAG_OUTPUT) onData(bytes.subarray(1));
    else if (bytes[0] === TAG_EXIT)
      onExit(bytes.length > 1 ? (bytes[1] ?? null) : null);
  };
  return invoke<ShellSessionInfo>("shell_open", {
    serial,
    cols: size.cols,
    rows: size.rows,
    cwd,
    onOutput: channel,
  });
}

export const writeShell = (id: number, data: string) =>
  invoke<void>("shell_write", { id, data });

export const resizeShell = (id: number, cols: number, rows: number) =>
  invoke<void>("shell_resize", { id, cols, rows });

export const closeShell = (id: number) => invoke<void>("shell_close", { id });

/** One command without a PTY: separate stdout/stderr and the exit code. */
export const execShell = (serial: string, command: string) =>
  invoke<CommandOutput>("shell_exec", { serial, command });

const VAR = /\{([A-Za-z_][\w-]*)\}/g;

/** `{package}`-style variables of a snippet, in order, without repeats. */
export function snippetVars(command: string): string[] {
  return [...new Set([...command.matchAll(VAR)].map((m) => m[1] ?? ""))];
}

export function fillSnippet(
  command: string,
  values: Record<string, string>,
): string {
  return command.replace(VAR, (_, name: string) => values[name] ?? "");
}

/** Splits a snippet into text and variable parts for highlighting. */
export function snippetParts(
  command: string,
): { text: string; isVar: boolean; at: number }[] {
  const parts: { text: string; isVar: boolean; at: number }[] = [];
  let last = 0;
  for (const m of command.matchAll(VAR)) {
    const i = m.index ?? 0;
    if (i > last)
      parts.push({ text: command.slice(last, i), isVar: false, at: last });
    parts.push({ text: m[0], isVar: true, at: i });
    last = i + m[0].length;
  }
  if (last < command.length) {
    parts.push({ text: command.slice(last), isVar: false, at: last });
  }
  return parts;
}

/** Where the line being edited can be read back from (the terminal). */
export interface LineSource {
  /** Called on the first key of a line: remember where the input starts. */
  mark(): void;
  /** The line as the shell shows it now, without the prompt; null if unsure. */
  read(): string | null;
}

/**
 * Tracks what the user types to record commands for the history panel.
 * Arrow keys, Tab completion and other control keys let the device shell
 * edit the line, so such lines are read back from the screen when Enter is
 * pressed (see `screenLine.ts`).
 */
export class LineTracker {
  private line = "";
  private dirty = false;
  /** The next key starts a new line. */
  private fresh = true;

  /**
   * `screen` reads lines the shell edited (history, completion) off the
   * terminal; without it such lines are skipped.
   */
  constructor(private readonly screen: LineSource | null = null) {}

  /** Feeds xterm `onData`; returns the commands completed by it. */
  feed(data: string): string[] {
    const done: string[] = [];
    for (let i = 0; i < data.length; i++) {
      const ch = data[i] ?? "";
      if (this.fresh) {
        this.fresh = false;
        this.screen?.mark();
      }
      if (ch === "\r" || ch === "\n") {
        // A line typed key by key is known exactly; one the shell edited
        // is read back from the screen.
        const cmd = this.dirty
          ? (this.screen?.read()?.trim() ?? "")
          : this.line.trim();
        if (cmd) done.push(cmd);
        this.line = "";
        this.dirty = false;
        this.fresh = true;
      } else if (ch === "\x7f" || ch === "\b") {
        this.line = this.line.slice(0, -1);
      } else if (ch === "\x03" || ch === "\x15") {
        // Ctrl+C / Ctrl+U drop the line.
        this.line = "";
        this.dirty = false;
        this.fresh = true;
      } else if (ch === "\x1b") {
        this.dirty = true;
        // Skip the rest of a CSI/SS3 sequence.
        if (data[i + 1] === "[" || data[i + 1] === "O") {
          i += 2;
          while (i < data.length && !/[@-~]/.test(data[i] ?? "")) i++;
        }
      } else if (ch < " ") {
        this.dirty = true;
      } else {
        this.line += ch;
      }
    }
    return done;
  }
}
