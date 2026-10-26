import { Channel, invoke } from "@tauri-apps/api/core";

export type EntryKind = "file" | "dir" | "symlink" | "other";

export interface FileEntry {
  name: string;
  path: string;
  kind: EntryKind;
  /** For symlinks: the target is a folder. */
  linkToDir: boolean;
  size: number;
  /** Unix seconds. */
  mtime: number;
  mode: number;
  /** `ls -l` style, e.g. `drwxrwx--x`. */
  permissions: string;
  owner: string | null;
  group: string | null;
  unreadable: boolean;
}

export interface DirListing {
  path: string;
  entries: FileEntry[];
  /** The folder exists but the shell user may not read it. */
  denied: boolean;
}

export interface StorageInfo {
  total: number;
  used: number;
  available: number;
  mount: string;
}

export interface LocalSummary {
  files: number;
  folders: number;
  bytes: number;
}

export type TransferEvent =
  | { type: "scanning" }
  | { type: "started"; totalBytes: number; totalFiles: number }
  | {
      type: "progress";
      bytes: number;
      totalBytes: number;
      filesDone: number;
      totalFiles: number;
      current: string;
    };

export interface TransferSummary {
  bytes: number;
  files: number;
  skipped: number;
  /** Top-level destinations (local paths for pulls, device paths for pushes). */
  destinations: string[];
}

export type TransferAction = "cancel" | "pause" | "resume";

export const isDirLike = (e: FileEntry) =>
  e.kind === "dir" || (e.kind === "symlink" && e.linkToDir);

export const listDir = (serial: string, path: string) =>
  invoke<DirListing>("files_list", { serial, path });

export const makeDir = (serial: string, path: string) =>
  invoke<void>("files_mkdir", { serial, path });

export const renamePath = (serial: string, from: string, to: string) =>
  invoke<void>("files_rename", { serial, from, to });

export const deletePaths = (serial: string, paths: string[]) =>
  invoke<void>("files_delete", { serial, paths });

export const chmodPaths = (
  serial: string,
  paths: string[],
  mode: string,
  recursive: boolean,
) => invoke<void>("files_chmod", { serial, paths, mode, recursive });

export const storageInfo = (serial: string, path: string) =>
  invoke<StorageInfo>("files_storage", { serial, path });

/** The first `maxBytes` of a file. */
export const readPreview = (serial: string, path: string, maxBytes: number) =>
  invoke<ArrayBuffer>("files_preview", { serial, path, maxBytes });

export const defaultDownloadDir = () =>
  invoke<string>("files_default_download_dir");

export const localSummary = (paths: string[]) =>
  invoke<LocalSummary>("files_local_summary", { paths });

export function pullPaths(
  id: string,
  serial: string,
  paths: string[],
  localDir: string,
  onEvent: (event: TransferEvent) => void,
) {
  const channel = new Channel<TransferEvent>();
  channel.onmessage = onEvent;
  return invoke<TransferSummary>("files_pull", {
    id,
    serial,
    paths,
    localDir,
    onEvent: channel,
  });
}

export function pushPaths(
  id: string,
  serial: string,
  paths: string[],
  remoteDir: string,
  onEvent: (event: TransferEvent) => void,
) {
  const channel = new Channel<TransferEvent>();
  channel.onmessage = onEvent;
  return invoke<TransferSummary>("files_push", {
    id,
    serial,
    paths,
    remoteDir,
    onEvent: channel,
  });
}

export const controlTransfer = (id: string, action: TransferAction) =>
  invoke<void>("files_transfer_control", { id, action });

// ---- computer side (two-pane mode, drag-out) ---------------------------------

/** A local entry: device entry shape plus the platform's hidden flag. */
export interface LocalEntry extends FileEntry {
  hidden: boolean;
}

export interface LocalListing {
  path: string;
  /** null at a file system root. */
  parent: string | null;
  /** From the root down to `path`. */
  crumbs: { name: string; path: string }[];
  entries: LocalEntry[];
  denied: boolean;
}

export type LocalPlaceKey =
  | "home"
  | "desktop"
  | "documents"
  | "downloads"
  | "pictures"
  | "videos"
  | "music"
  | "volume";

export interface LocalPlace {
  key: LocalPlaceKey;
  label: string;
  path: string;
}

export const listLocal = (path: string) =>
  invoke<LocalListing>("files_local_list", { path });

export const resolveLocal = (base: string, input: string) =>
  invoke<string>("files_local_resolve", { base, input });

export const localPlaces = () => invoke<LocalPlace[]>("files_local_places");

/** Staging folders live in `<temp>/tether-drag/drag-…`. */
export const isStagedPath = (path: string) =>
  /[\\/]tether-drag[\\/]drag-[\w-]+[\\/]/.test(path);

/** A fresh staging folder for one drag-out. */
export const dragStage = (id: string) =>
  invoke<string>("files_drag_stage", { id });

/**
 * Starts the OS drag of local files (while the mouse button is held).
 * `onEnd` fires once the user drops or cancels.
 */
export function startNativeDrag(
  paths: string[],
  icon: string | null,
  onEnd: (outcome: { dropped: boolean }) => void,
) {
  const channel = new Channel<{ dropped: boolean }>();
  channel.onmessage = onEnd;
  return invoke<void>("files_start_drag", { paths, icon, onEvent: channel });
}
