import type { Level, LogEntry } from "./api";
import type { Row } from "./view";

/** Text color of the level letter. */
export const LEVEL_TEXT: Record<Level, string> = {
  V: "text-log-v",
  D: "text-log-d",
  I: "text-log-i",
  W: "text-log-w",
  E: "text-log-e",
  F: "text-log-f",
};

/** Message color per level (Logcat board: W amber, E/F red, V dim). */
export const MESSAGE_TEXT: Record<Level, string> = {
  V: "text-muted-foreground",
  D: "text-foreground",
  I: "text-foreground",
  W: "text-log-w",
  E: "text-log-e",
  F: "text-log-e",
};

/** Row tint per level. */
export const ROW_TINT: Record<Level, string> = {
  V: "",
  D: "",
  I: "",
  W: "bg-warning/12",
  E: "bg-error/13",
  F: "bg-error/13 shadow-[inset_3px_0_0_var(--color-log-f)]",
};

/** One entry in `threadtime` layout, one physical line per message line. */
export function formatEntry(e: LogEntry): string {
  const head = `${e.date} ${e.time} ${String(e.pid).padStart(5)} ${String(
    e.tid,
  ).padStart(5)} ${e.level} ${e.tag}: `;
  return e.message
    .split("\n")
    .map((l) => head + l)
    .join("\n");
}

export function formatRows(rows: Row[]): string {
  const out: string[] = [];
  for (const r of rows) if (r.kind === "line") out.push(formatEntry(r.line));
  return `${out.join("\n")}\n`;
}

/** `logcat-emulator-5554-20261025-224107.txt` */
export function exportFileName(serial: string, now = new Date()) {
  const safe = serial.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 48);
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(
    now.getDate(),
  )}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `logcat-${safe}-${stamp}.txt`;
}

/** 1,240 / 12.4k / 1.2M — keeps level counters narrow. */
export function compactCount(n: number, locale: string) {
  return new Intl.NumberFormat(locale, {
    notation: n >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(n);
}

export function formatNumber(n: number, locale: string) {
  return new Intl.NumberFormat(locale).format(n);
}
