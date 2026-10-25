import type { AppMeta, AppSummary } from "./api";

// Package segments that say nothing about the app.
const GENERIC = new Set([
  "com",
  "org",
  "net",
  "io",
  "dev",
  "app",
  "apps",
  "android",
  "mobile",
  "client",
  "google",
  "ru",
  "de",
  "me",
  "tech",
  "co",
  "uk",
  "v1",
  "v2",
  "prod",
  "release",
  "debug",
]);

/**
 * Readable stand-in until the real label is read from the APK:
 * `com.google.android.youtube` → "Youtube", `org.telegram.messenger` →
 * "Messenger". Only used while labels load or when an APK has none.
 */
export function derivedName(pkg: string): string {
  const parts = pkg.split(".").filter(Boolean);
  const meaningful = parts.filter((p) => !GENERIC.has(p.toLowerCase()));
  const pick = meaningful.at(-1) ?? parts.at(-1) ?? pkg;
  const words = pick
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[_-]+/)
    .filter(Boolean);
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

export function appName(app: Pick<AppSummary, "package">, meta?: AppMeta) {
  return meta?.label ?? derivedName(app.package);
}

/** First letter or digit of a name for the lettered tile. */
export function tileLetter(name: string): string {
  const match = name.match(/[\p{L}\p{N}]/u);
  return (match?.[0] ?? "?").toUpperCase();
}

const TILE_CLASSES = [
  "bg-chart-1",
  "bg-chart-2",
  "bg-chart-3",
  "bg-chart-4",
  "bg-chart-5",
  "bg-brand",
] as const;

/** Stable tile color per package, from the chart palette. */
export function tileClass(pkg: string): string {
  let hash = 0;
  for (let i = 0; i < pkg.length; i++) {
    hash = (hash * 31 + pkg.charCodeAt(i)) | 0;
  }
  return TILE_CLASSES[Math.abs(hash) % TILE_CLASSES.length];
}

/** `com.pkg/.Main` or `com.pkg.ui.Main` → `.ui.Main` relative to `pkg`. */
export function shortClass(pkg: string, name: string): string {
  const cls = name.includes("/") ? name.slice(name.indexOf("/") + 1) : name;
  if (cls.startsWith(".")) return cls;
  return cls.startsWith(`${pkg}.`) ? cls.slice(pkg.length) : cls;
}
