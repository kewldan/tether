import type { IBuffer, Terminal } from "@xterm/xterm";

import type { LineSource } from "./api";

/** Ends of the usual prompts: `emu64a:/ $ `, `# `, `% `, `> `. */
const PROMPT_END = /[$#%>] $/;
/** Fallback when the remembered prompt doesn't match: up to the first `$ `/`# `. */
const PROMPT = /^\S[^$#]*[$#] /;

/** The rows of the (possibly wrapped) line that contains buffer row `y`. */
function logicalRows(
  buffer: IBuffer,
  y: number,
): { first: number; last: number } {
  let first = y;
  while (first > 0 && buffer.getLine(first)?.isWrapped) first--;
  let last = y;
  while (buffer.getLine(last + 1)?.isWrapped) last++;
  return { first, last };
}

function rowText(buffer: IBuffer, y: number, trimRight: boolean, end?: number) {
  return buffer.getLine(y)?.translateToString(trimRight, 0, end) ?? "";
}

/**
 * Strips the prompt from a line read off the screen: the prompt that was
 * there when the user started typing, else a usual-looking one. Null when
 * neither is found, e.g. input to a program other than the shell.
 */
export function stripPrompt(
  text: string,
  prompt: string | null,
): string | null {
  if (prompt && PROMPT_END.test(prompt) && text.startsWith(prompt))
    return text.slice(prompt.length);
  const m = PROMPT.exec(text);
  return m ? text.slice(m[0].length) : null;
}

/**
 * Reads the line being edited off an xterm screen. The prompt is
 * remembered on the first key of a line (the cursor then sits right after
 * it), so whatever the shell redraws behind it on Up/Down or Tab is the
 * command. mksh scrolls a line longer than the screen sideways instead of
 * wrapping it, so a line that reaches the right edge may be clipped and is
 * reported as unknown.
 */
export class ScreenLine implements LineSource {
  private prompt: string | null = null;

  constructor(private readonly term: Terminal) {}

  mark() {
    const buffer = this.term.buffer.active;
    this.prompt = null;
    if (buffer.type !== "normal") return;
    const y = buffer.baseY + buffer.cursorY;
    const { first } = logicalRows(buffer, y);
    let prompt = "";
    for (let row = first; row < y; row++) prompt += rowText(buffer, row, false);
    prompt += rowText(buffer, y, false, buffer.cursorX);
    this.prompt = prompt;
  }

  read(): string | null {
    const buffer = this.term.buffer.active;
    // Full-screen programs (vi, top) are not shell input.
    if (buffer.type !== "normal") return null;
    const { first, last } = logicalRows(buffer, buffer.baseY + buffer.cursorY);
    let text = "";
    for (let row = first; row < last; row++)
      text += rowText(buffer, row, false);
    // Not just `trimRight`: shells clear the old text by writing spaces.
    const tail = rowText(buffer, last, true).trimEnd();
    if (tail.length >= this.term.cols - 1) return null;
    text += tail;
    return stripPrompt(text, this.prompt);
  }
}
