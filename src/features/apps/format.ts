import type { TFunction } from "i18next";

const UNITS = ["B", "KB", "MB", "GB", "TB"];

/** `48.2 MB`; decimal units like Android's own storage screens. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "—";
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000;
    unit++;
  }
  const digits = unit === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}

/** "2 min ago", "Yesterday", "Oct 23", "Aug 02, 2024". */
export function formatWhen(
  ms: number | null | undefined,
  t: TFunction,
  locale: string,
  now = Date.now(),
): string {
  if (!ms) return "—";
  const diff = now - ms;
  const minute = 60_000;
  if (diff < minute) return t("apps:time.justNow");
  if (diff < 60 * minute)
    return t("apps:time.minutes", { count: Math.floor(diff / minute) });
  const date = new Date(ms);
  const today = new Date(now);
  const startOfToday = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
  ).getTime();
  if (ms >= startOfToday)
    return t("apps:time.hours", { count: Math.floor(diff / (60 * minute)) });
  if (ms >= startOfToday - 86_400_000) return t("apps:time.yesterday");
  const sameYear = date.getFullYear() === today.getFullYear();
  return date.toLocaleDateString(locale, {
    month: "short",
    day: "2-digit",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

export function formatDate(ms: number | null | undefined, locale: string) {
  if (!ms) return "—";
  return new Date(ms).toLocaleDateString(locale, {
    year: "numeric",
    month: "short",
    day: "2-digit",
  });
}

export function formatDuration(ms: number): string {
  return ms < 10_000
    ? `${(ms / 1000).toFixed(1)} s`
    : `${Math.round(ms / 1000)} s`;
}
