import { Channel, invoke } from "@tauri-apps/api/core";

export interface BugreportFile {
  path: string;
  name: string;
  /** Product name parsed from the file name, e.g. `husky`. */
  device: string | null;
  sizeBytes: number;
  modified: number;
}

export interface ZipSummary {
  anrTraces: number;
  tombstones: number;
}

export interface BugreportResult {
  file: BugreportFile;
  summary: ZipSummary | null;
}

export interface BugreportList {
  dir: string;
  reports: BugreportFile[];
}

export type BugreportEvent =
  | { type: "progress"; done: number; total: number }
  | { type: "pulling"; received: number; total: number | null };

export function createBugreport(
  serial: string,
  onEvent: (event: BugreportEvent) => void,
) {
  const channel = new Channel<BugreportEvent>();
  channel.onmessage = onEvent;
  return invoke<BugreportResult>("create_bugreport", {
    serial,
    onEvent: channel,
  });
}

export const cancelBugreport = (serial: string) =>
  invoke<void>("cancel_bugreport", { serial });

export const listBugreports = () => invoke<BugreportList>("list_bugreports");

export const deleteBugreport = (path: string) =>
  invoke<void>("delete_bugreport", { path });
