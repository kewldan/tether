import { invoke } from "@tauri-apps/api/core";

import type { Capture } from "@/features/overview/api";

export interface Thumbnail {
  /** `data:image/png;base64,…` of the scaled screen. */
  dataUrl: string;
  /** Real screen size, for mapping taps. */
  screenWidth: number;
  screenHeight: number;
}

export interface Shot {
  serial: string;
  capture: Capture | null;
  error: string | null;
}

export interface MultiCapture {
  dir: string;
  shots: Shot[];
  elapsedMs: number;
}

/** A scaled-down screencap, at most `maxWidth` px wide. */
export const thumbnail = (serial: string, maxWidth: number) =>
  invoke<Thumbnail>("multi_thumbnail", { serial, maxWidth });

/** Screenshots all `targets` at once into `<captures>/Grid_<stamp>/`. */
export const screenshotAll = (
  targets: { serial: string; name: string }[],
  stamp: string,
) => invoke<MultiCapture>("multi_screenshot", { targets, stamp });

/** Saved screenshots side by side as `Grid.png` in the same folder. */
export const composeGrid = (paths: string[]) =>
  invoke<Capture>("multi_compose", { paths });
