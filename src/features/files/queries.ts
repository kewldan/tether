import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo } from "react";

import type { AppError } from "@/lib/tauri";

import {
  type DirListing,
  type FileEntry,
  type ImageDetails,
  type LocalListing,
  type LocalPlace,
  listDir,
  listLocal,
  localPlaces,
  readExif,
  readPreview,
  storageInfo,
} from "./api";
import {
  IMAGE_PREVIEW_MAX,
  imageMime,
  isTextLike,
  looksLikeText,
  mayHaveExif,
  TEXT_PREVIEW_MAX,
  THUMBNAIL_MAX,
} from "./format";

export const filesKeys = {
  all: (serial: string) => ["files", serial] as const,
  listing: (serial: string, path: string) =>
    ["files", serial, "list", path] as const,
  storage: (serial: string) => ["files", serial, "storage"] as const,
  preview: (serial: string, path: string, mtime: number, kind: string) =>
    ["files", serial, "preview", kind, path, mtime] as const,
};

export const localKeys = {
  all: ["files-local"] as const,
  listing: (path: string) => ["files-local", "list", path] as const,
  places: ["files-local", "places"] as const,
};

/** A folder on the computer (two-pane mode). */
export function useLocalListing(path: string | null) {
  return useQuery<LocalListing, AppError>({
    queryKey: localKeys.listing(path ?? ""),
    queryFn: () => listLocal(path as string),
    enabled: !!path,
    staleTime: 5_000,
    retry: false,
  });
}

export function useLocalPlaces() {
  return useQuery<LocalPlace[], AppError>({
    queryKey: localKeys.places,
    queryFn: localPlaces,
    staleTime: 60_000,
    retry: false,
  });
}

export function useRefreshLocal() {
  const client = useQueryClient();
  return useCallback(
    () => void client.invalidateQueries({ queryKey: localKeys.all }),
    [client],
  );
}

export function useListing(serial: string | null, path: string) {
  return useQuery<DirListing, AppError>({
    queryKey: filesKeys.listing(serial ?? "", path),
    queryFn: () => listDir(serial as string, path),
    enabled: serial !== null,
    staleTime: 5_000,
    retry: false,
  });
}

export function useStorage(serial: string | null) {
  return useQuery({
    queryKey: filesKeys.storage(serial ?? ""),
    queryFn: () => storageInfo(serial as string, "/sdcard"),
    enabled: serial !== null,
    staleTime: 30_000,
    retry: false,
  });
}

/** Refetches every listing (and storage) of a device. */
export function useRefreshFiles(serial: string | null) {
  const client = useQueryClient();
  return useCallback(() => {
    if (serial)
      void client.invalidateQueries({ queryKey: filesKeys.all(serial) });
  }, [client, serial]);
}

export type Preview =
  | { type: "image"; url: string }
  | { type: "text"; text: string; truncated: boolean }
  | { type: "none" };

/** Thumbnails pull whole images, so only a few run at once. */
function limiter(max: number) {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (running >= max) await new Promise<void>((r) => waiting.push(r));
    running++;
    try {
      return await task();
    } finally {
      running--;
      waiting.shift()?.();
    }
  };
}
const thumbnailSlot = limiter(3);

async function loadPreview(
  serial: string,
  entry: FileEntry,
  maxImage: number,
): Promise<Preview> {
  const mime = imageMime(entry.name);
  if (mime && entry.size <= maxImage) {
    const data = await readPreview(serial, entry.path, maxImage);
    return {
      type: "image",
      url: URL.createObjectURL(new Blob([data], { type: mime })),
    };
  }
  if (isTextLike(entry) || (entry.size > 0 && entry.size <= TEXT_PREVIEW_MAX)) {
    const data = new Uint8Array(
      await readPreview(serial, entry.path, TEXT_PREVIEW_MAX),
    );
    if (!looksLikeText(data)) return { type: "none" };
    return {
      type: "text",
      text: new TextDecoder("utf-8", { fatal: false }).decode(data),
      truncated: entry.size > data.byteLength,
    };
  }
  return { type: "none" };
}

function usePreviewQuery(
  serial: string | null,
  entry: FileEntry | null,
  kind: "full" | "thumb",
  enabled: boolean,
) {
  const query = useQuery<Preview, AppError>({
    queryKey: filesKeys.preview(
      serial ?? "",
      entry?.path ?? "",
      entry?.mtime ?? 0,
      kind,
    ),
    queryFn: () =>
      kind === "full"
        ? loadPreview(serial as string, entry as FileEntry, IMAGE_PREVIEW_MAX)
        : thumbnailSlot(() =>
            loadPreview(serial as string, entry as FileEntry, THUMBNAIL_MAX),
          ),
    enabled:
      enabled && serial !== null && entry !== null && entry.kind !== "dir",
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 60_000,
    retry: false,
  });
  // Object URLs are revoked once the cached preview is dropped.
  const url = query.data?.type === "image" ? query.data.url : null;
  useRevokeOnGc(url);
  return query;
}

const urlRefs = new Map<string, number>();
function useRevokeOnGc(url: string | null) {
  useEffect(() => {
    if (!url) return;
    urlRefs.set(url, (urlRefs.get(url) ?? 0) + 1);
    return () => {
      const n = (urlRefs.get(url) ?? 1) - 1;
      if (n > 0) {
        urlRefs.set(url, n);
        return;
      }
      urlRefs.delete(url);
      // Keep it for a while: the query cache may hand it out again.
      setTimeout(() => {
        if (!urlRefs.has(url)) URL.revokeObjectURL(url);
      }, 90_000);
    };
  }, [url]);
}

/** EXIF of a photo; null when the file has none. */
export function useExif(serial: string | null, entry: FileEntry | null) {
  return useQuery<ImageDetails | null, AppError>({
    queryKey: filesKeys.preview(
      serial ?? "",
      entry?.path ?? "",
      entry?.mtime ?? 0,
      "exif",
    ),
    queryFn: () => readExif(serial as string, (entry as FileEntry).path),
    enabled:
      serial !== null &&
      entry !== null &&
      entry.kind !== "dir" &&
      mayHaveExif(entry.name),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 60_000,
    retry: false,
  });
}

export function usePreview(serial: string | null, entry: FileEntry | null) {
  return usePreviewQuery(serial, entry, "full", true);
}

export function useThumbnail(
  serial: string | null,
  entry: FileEntry,
  visible: boolean,
) {
  const eligible = useMemo(
    () => imageMime(entry.name) !== null && entry.size <= THUMBNAIL_MAX,
    [entry.name, entry.size],
  );
  return usePreviewQuery(serial, entry, "thumb", visible && eligible);
}
