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
 */
export function captureSrc(path: string): string {
  if (path.startsWith("data:") || path.startsWith("http")) return path;
  return convertFileSrc(path);
}
