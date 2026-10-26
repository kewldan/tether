import { convertFileSrc, invoke } from "@tauri-apps/api/core";

import type { Capture } from "@/features/overview/api";

export type { Capture, CaptureKind } from "@/features/overview/api";

export interface CaptureList {
  /** Root folder, e.g. `~/Pictures/Tether`. */
  dir: string;
  captures: Capture[];
}

export const listCaptures = () => invoke<CaptureList>("list_captures");

export const deleteCapture = (path: string) =>
  invoke<void>("delete_capture", { path });

/**
 * URL the webview can load for a capture file (Tauri asset protocol).
 * Browser mocks hand out `data:` URLs, which pass through unchanged.
 * `version` (the modification time) makes the webview reload a file that
 * was overwritten in place.
 */
export function captureSrc(path: string, version?: number): string {
  if (path.startsWith("data:") || path.startsWith("http")) return path;
  const url = convertFileSrc(path);
  return version ? `${url}?v=${version}` : url;
}

/**
 * A screenshot's bytes as a same-origin blob, so a canvas can read and
 * export its pixels (an asset-protocol image would taint the canvas).
 */
export async function readCaptureBlob(path: string): Promise<Blob> {
  if (path.startsWith("data:")) return fetch(path).then((r) => r.blob());
  const bytes = await invoke<ArrayBuffer>("read_capture", { path });
  return new Blob([bytes], { type: "image/png" });
}

/**
 * Saves an annotated PNG: next to the original as `<name>_annotated.png`,
 * or over the original when `overwrite` is set (PNG originals only).
 */
export async function saveAnnotated(
  path: string,
  png: Blob,
  overwrite: boolean,
): Promise<Capture> {
  const bytes = new Uint8Array(await png.arrayBuffer());
  return invoke<Capture>("save_annotated", bytes, {
    headers: {
      "x-path": encodeURIComponent(path),
      "x-overwrite": overwrite ? "1" : "0",
    },
  });
}
