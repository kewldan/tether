import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { create } from "zustand";

export type UpdaterStatus =
  | "idle"
  | "checking"
  | "upToDate"
  | "available"
  | "downloading"
  | "ready"
  | "error";

interface UpdaterState {
  status: UpdaterStatus;
  /** Version offered by the update server. */
  version: string | null;
  notes: string | null;
  /** Download progress 0..1, or null while the size is unknown. */
  progress: number | null;
  error: string | null;
  update: Update | null;
  check: () => Promise<void>;
  install: () => Promise<void>;
}

/**
 * OTA updates via tauri-plugin-updater. The server is the `latest.json`
 * attached to the latest GitHub release (see docs/releasing.md); updates
 * are signature-checked against the pubkey in tauri.conf.json.
 */
export const useUpdater = create<UpdaterState>()((set, get) => ({
  status: "idle",
  version: null,
  notes: null,
  progress: null,
  error: null,
  update: null,

  check: async () => {
    const { status } = get();
    if (status === "checking" || status === "downloading") return;
    set({ status: "checking", error: null });
    try {
      const update = await check();
      if (!update) {
        set({ status: "upToDate", update: null, version: null });
        return;
      }
      set({
        status: "available",
        update,
        version: update.version,
        notes: update.body ?? null,
      });
    } catch (error) {
      set({ status: "error", error: String(error) });
    }
  },

  install: async () => {
    const { update } = get();
    if (!update) return;
    set({ status: "downloading", progress: null, error: null });
    let total = 0;
    let received = 0;
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? 0;
        } else if (event.event === "Progress") {
          received += event.data.chunkLength;
          set({ progress: total > 0 ? received / total : null });
        }
      });
      set({ status: "ready", progress: 1 });
      await relaunch();
    } catch (error) {
      set({ status: "error", error: String(error) });
    }
  },
}));
