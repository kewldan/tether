import type { TFunction } from "i18next";

import i18n from "@/lib/i18n";

import type { FileEntry } from "./api";

const UNITS: Record<string, string[]> = {
  en: ["B", "KB", "MB", "GB", "TB"],
  ru: ["Б", "КБ", "МБ", "ГБ", "ТБ"],
};

const lang = () => (i18n.language?.startsWith("ru") ? "ru" : "en");

/** Decimal units like Android and Finder: 4.1 MB, 212.6 MB, 256 GB. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  const units = UNITS[lang()] ?? (UNITS.en as string[]);
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  const digits = unit === 0 ? 0 : 1;
  const number = value.toLocaleString(lang(), {
    maximumFractionDigits: digits,
  });
  return `${number} ${units[unit]}`;
}

export function formatSpeed(bytesPerSecond: number): string {
  return `${formatBytes(Math.round(bytesPerSecond))}/${lang() === "ru" ? "с" : "s"}`;
}

export function formatEta(seconds: number, t: TFunction): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  if (seconds < 60)
    return t("files:eta.seconds", { count: Math.ceil(seconds) });
  if (seconds < 3600)
    return t("files:eta.minutes", { count: Math.ceil(seconds / 60) });
  return t("files:eta.hours", { count: Math.round(seconds / 360) / 10 });
}

/** "Today, 19:30", "Oct 24, 18:12", "Oct 24, 2025". */
export function formatDate(
  unixSeconds: number,
  locale: string,
  t: TFunction,
): string {
  if (!unixSeconds) return "—";
  const date = new Date(unixSeconds * 1000);
  const now = new Date();
  const time = date.toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (sameDay(date, now)) return t("files:date.today", { time });
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(date, yesterday)) return t("files:date.yesterday", { time });
  if (date.getFullYear() === now.getFullYear()) {
    const day = date.toLocaleDateString(locale, {
      month: "short",
      day: "numeric",
    });
    return `${day}, ${time}`;
  }
  return date.toLocaleDateString(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function formatFullDate(unixSeconds: number, locale: string): string {
  if (!unixSeconds) return "—";
  return new Date(unixSeconds * 1000).toLocaleString(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

export type Category =
  | "folder"
  | "image"
  | "video"
  | "audio"
  | "text"
  | "code"
  | "archive"
  | "apk"
  | "document"
  | "link"
  | "other";

const EXT: Record<string, Category> = {};
const add = (category: Category, exts: string) => {
  for (const ext of exts.split(" ")) EXT[ext] = category;
};
add("image", "jpg jpeg png gif webp bmp heic heif avif svg ico dng");
add("video", "mp4 mkv webm mov 3gp avi m4v ts");
add("audio", "mp3 m4a aac ogg opus wav flac amr mid");
add("text", "txt log md csv rc prop properties ini conf cfg mht");
add(
  "code",
  "json xml html htm css js mjs ts tsx jsx kt java py sh c cc cpp h hpp gradle toml yml yaml smali",
);
add("archive", "zip tar gz tgz 7z rar xz bz2 zst ab br lz4 obb");
add("apk", "apk apks xapk aab apex");
add("document", "pdf doc docx xls xlsx ppt pptx odt epub");

export function extension(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

export function categoryOf(
  entry: Pick<FileEntry, "name" | "kind" | "linkToDir">,
) {
  if (entry.kind === "dir") return "folder";
  if (entry.kind === "symlink") return entry.linkToDir ? "folder" : "link";
  return EXT[extension(entry.name)] ?? "other";
}

/** Formats WebView can decode, keyed by extension. */
const IMAGE_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  avif: "image/avif",
  svg: "image/svg+xml",
  ico: "image/x-icon",
};

export const imageMime = (name: string) => IMAGE_MIME[extension(name)] ?? null;

/** Largest image shown in the preview panel and grid thumbnails. */
export const IMAGE_PREVIEW_MAX = 12 * 1024 * 1024;
export const THUMBNAIL_MAX = 6 * 1024 * 1024;
/** Text previews read only the head of the file. */
export const TEXT_PREVIEW_MAX = 64 * 1024;

export function isTextLike(entry: FileEntry): boolean {
  const c = categoryOf(entry);
  return c === "text" || c === "code";
}

/** True when the bytes look like text (no NUL in the sample). */
export function looksLikeText(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, 4096);
  for (const b of sample) if (b === 0) return false;
  return true;
}
