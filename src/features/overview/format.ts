/** Formatting helpers shared by Overview, Captures and Bugreport. */

const GB = 1024 ** 3;

/** `168.4` (no unit) for a byte count shown next to "of 256 GB". */
export function gigabytes(bytes: number, digits = 1): string {
  return (bytes / GB).toFixed(digits);
}

/** Human size with unit: 412 KB, 38.4 MB, 1.2 GB. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = value >= 100 || unit === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

/** `3d 4h`, `5h 12m`, `12m`, `40s`. */
export function formatUptime(secs: number): string {
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${Math.floor(secs)}s`;
}

/** `1:05`, `12:40` for a recording timer. */
export function formatClock(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** `2 min 06 s`, `48 s`. */
export function formatElapsed(ms: number): string {
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m === 0) return `${s} s`;
  return `${m} min ${s.toString().padStart(2, "0")} s`;
}

const pad = (n: number) => n.toString().padStart(2, "0");

/** Local time stamp used in capture file names: `2026-10-25_22-38-12`. */
export function fileStamp(date = new Date()): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

function sameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export type DayBucket = "today" | "yesterday" | "earlier";

export function dayBucket(ms: number, now = new Date()): DayBucket {
  const date = new Date(ms);
  if (sameDay(date, now)) return "today";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(date, yesterday)) return "yesterday";
  return "earlier";
}

/** `22:38` today, otherwise `Oct 23 15:40` in the UI language. */
export function formatWhen(ms: number, language: string): string {
  const date = new Date(ms);
  const time = date.toLocaleTimeString(language, {
    hour: "2-digit",
    minute: "2-digit",
  });
  if (sameDay(date, new Date())) return time;
  const day = date.toLocaleDateString(language, {
    month: "short",
    day: "numeric",
  });
  return `${day} ${time}`;
}
