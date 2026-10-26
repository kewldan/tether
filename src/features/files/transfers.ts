import { toast } from "sonner";
import { create } from "zustand";

import i18n from "@/lib/i18n";
import { type Task, useTasks } from "@/lib/tasks";
import type { AppError } from "@/lib/tauri";

import {
  controlTransfer,
  pullPaths,
  pushPaths,
  type TransferEvent,
  type TransferSummary,
} from "./api";
import { formatBytes } from "./format";
import { basename, localBasename } from "./paths";
import { reveal } from "./reveal";

/** Transfers that run at the same time; the rest wait in the queue. */
const MAX_ACTIVE = 2;

export type Direction = "pull" | "push";

export type TransferStatus =
  | "queued"
  | "scanning"
  | "running"
  | "paused"
  | "done"
  | "failed"
  | "cancelled";

export interface TransferSpec {
  serial: string;
  direction: Direction;
  /** Device paths for pulls, local paths for pushes. */
  sources: string[];
  /** Local folder for pulls, device folder for pushes. */
  target: string;
}

export interface Transfer extends TransferSpec {
  id: string;
  /**
   * Multi-file transfers get one row per file; rows started together share
   * a batch id and are reported with one toast.
   */
  batch: string | null;
  name: string;
  /** Number of top-level sources beyond the first. */
  more: number;
  status: TransferStatus;
  bytes: number;
  totalBytes: number;
  filesDone: number;
  totalFiles: number;
  current: string;
  /** Smoothed bytes per second. */
  speed: number;
  error: AppError | null;
  summary: TransferSummary | null;
}

const ACTIVE: TransferStatus[] = ["scanning", "running", "paused"];
export const isActive = (t: Transfer) => ACTIVE.includes(t.status);
export const isFinished = (t: Transfer) =>
  t.status === "done" || t.status === "failed" || t.status === "cancelled";

type DoneListener = (transfer: Transfer) => void;
const doneListeners = new Set<DoneListener>();

/** Called whenever a transfer ends (done, failed or cancelled). */
export function onTransferFinished(listener: DoneListener) {
  doneListeners.add(listener);
  return () => {
    doneListeners.delete(listener);
  };
}

interface TransfersState {
  items: Transfer[];
  enqueue: (spec: TransferSpec) => string;
  cancel: (id: string) => void;
  pause: (id: string) => void;
  resume: (id: string) => void;
  pauseAll: () => void;
  resumeAll: () => void;
  retry: (id: string) => void;
  remove: (id: string) => void;
  clearFinished: () => void;
}

let counter = 0;
const newId = () => `xfer-${Date.now().toString(36)}-${++counter}`;

const samples = new Map<string, { t: number; bytes: number }>();

export const useTransfers = create<TransfersState>()((set, get) => {
  const patch = (id: string, change: Partial<Transfer>) => {
    set((s) => ({
      items: s.items.map((t) => (t.id === id ? { ...t, ...change } : t)),
    }));
    const item = get().items.find((t) => t.id === id);
    if (item) syncTask(item);
  };

  const onEvent = (id: string, event: TransferEvent) => {
    const item = get().items.find((t) => t.id === id);
    if (!item) return;
    if (event.type === "scanning") {
      patch(id, { status: item.status === "paused" ? "paused" : "scanning" });
    } else if (event.type === "started") {
      samples.set(id, { t: performance.now(), bytes: 0 });
      patch(id, {
        status: item.status === "paused" ? "paused" : "running",
        totalBytes: event.totalBytes,
        totalFiles: event.totalFiles,
      });
    } else {
      const now = performance.now();
      const last = samples.get(id);
      let speed = item.speed;
      if (last && now - last.t >= 250) {
        const instant = ((event.bytes - last.bytes) * 1000) / (now - last.t);
        speed = speed === 0 ? instant : speed * 0.7 + instant * 0.3;
        samples.set(id, { t: now, bytes: event.bytes });
      }
      patch(id, {
        bytes: event.bytes,
        totalBytes: event.totalBytes,
        filesDone: event.filesDone,
        totalFiles: event.totalFiles,
        current: event.current,
        speed: item.status === "paused" ? 0 : speed,
      });
    }
  };

  const finish = (id: string, change: Partial<Transfer>) => {
    samples.delete(id);
    patch(id, { ...change, speed: 0 });
    const item = get().items.find((t) => t.id === id);
    if (item) for (const listener of doneListeners) listener(item);
    pump();
  };

  const start = (item: Transfer) => {
    patch(item.id, { status: "scanning" });
    const run = item.direction === "pull" ? pullPaths : pushPaths;
    run(item.id, item.serial, item.sources, item.target, (e) =>
      onEvent(item.id, e),
    )
      .then((summary) =>
        finish(item.id, {
          status: "done",
          summary,
          bytes: summary.bytes,
          totalBytes: summary.bytes,
          filesDone: summary.files,
          totalFiles: summary.files,
        }),
      )
      .catch((error: AppError) =>
        finish(
          item.id,
          error?.kind === "cancelled"
            ? { status: "cancelled" }
            : {
                status: "failed",
                error: error?.message
                  ? error
                  : { kind: "unknown", message: String(error), hint: null },
              },
        ),
      );
  };

  const pump = () => {
    const { items } = get();
    let active = items.filter(isActive).length;
    for (const item of items) {
      if (active >= MAX_ACTIVE) break;
      if (item.status === "queued") {
        start(item);
        active++;
      }
    }
  };

  return {
    items: [],
    enqueue: (spec) => {
      const nameOf = spec.direction === "pull" ? basename : localBasename;
      // One row per top-level item, unless two share a name: then they go
      // together so the backend can give them unique names at the target.
      const names = spec.sources.map(nameOf);
      const split =
        spec.sources.length > 1 && new Set(names).size === names.length;
      const batch = split ? newId() : null;
      const specs = split
        ? spec.sources.map((source) => ({ ...spec, sources: [source] }))
        : [spec];
      const items = specs.map(
        (one): Transfer => ({
          ...one,
          id: newId(),
          batch,
          name: nameOf(one.sources[0] ?? ""),
          more: Math.max(0, one.sources.length - 1),
          status: "queued",
          bytes: 0,
          totalBytes: 0,
          filesDone: 0,
          totalFiles: 0,
          current: "",
          speed: 0,
          error: null,
          summary: null,
        }),
      );
      set((s) => ({ items: [...s.items, ...items] }));
      for (const item of items) syncTask(item);
      pump();
      return items[0]?.id ?? "";
    },
    cancel: (id) => {
      const item = get().items.find((t) => t.id === id);
      if (!item) return;
      if (item.status === "queued") {
        finish(id, { status: "cancelled" });
      } else if (isActive(item)) {
        void controlTransfer(id, "cancel");
      }
    },
    pause: (id) => {
      const item = get().items.find((t) => t.id === id);
      if (!item || !isActive(item)) return;
      void controlTransfer(id, "pause");
      patch(id, { status: "paused", speed: 0 });
    },
    resume: (id) => {
      const item = get().items.find((t) => t.id === id);
      if (item?.status !== "paused") return;
      void controlTransfer(id, "resume");
      samples.set(id, { t: performance.now(), bytes: item.bytes });
      patch(id, { status: item.totalFiles > 0 ? "running" : "scanning" });
    },
    pauseAll: () => {
      for (const t of get().items) if (isActive(t)) get().pause(t.id);
    },
    resumeAll: () => {
      for (const t of get().items)
        if (t.status === "paused") get().resume(t.id);
    },
    retry: (id) => {
      const item = get().items.find((t) => t.id === id);
      if (!item || !isFinished(item)) return;
      get().remove(id);
      get().enqueue({
        serial: item.serial,
        direction: item.direction,
        sources: item.sources,
        target: item.target,
      });
    },
    remove: (id) => {
      set((s) => ({ items: s.items.filter((t) => t.id !== id) }));
      useTasks.getState().remove(id);
    },
    clearFinished: () => {
      for (const t of get().items) if (isFinished(t)) get().remove(t.id);
    },
  };
});

function syncTask(t: Transfer) {
  const status: Task["status"] =
    t.status === "done"
      ? "done"
      : t.status === "failed"
        ? "failed"
        : t.status === "cancelled"
          ? "cancelled"
          : "running";
  useTasks.getState().upsert({
    id: t.id,
    kind: "transfer",
    label: t.name,
    progress:
      t.status === "done"
        ? 1
        : t.totalBytes > 0
          ? Math.min(1, t.bytes / t.totalBytes)
          : t.status === "running" && t.totalFiles === 0
            ? 1
            : null,
    status,
  });
}

// Report finished transfers wherever the user is in the app: once per
// batch, when its last row ends.
onTransferFinished((tr) => {
  const rows = tr.batch
    ? useTransfers.getState().items.filter((x) => x.batch === tr.batch)
    : [tr];
  if (rows.some((x) => !isFinished(x))) return;
  const t = i18n.getFixedT(null, "files");
  const label = (list: Transfer[]) => {
    const first = list[0] as Transfer;
    const more = list.length - 1 + list.reduce((n, x) => n + x.more, 0);
    return more > 0
      ? t("queue.more", { name: first.name, count: more })
      : first.name;
  };
  const done = rows.filter((x) => x.status === "done");
  const failed = rows.filter((x) => x.status === "failed");
  if (done.length > 0) {
    const name = label(done);
    const size = formatBytes(
      done.reduce((sum, x) => sum + (x.summary?.bytes ?? 0), 0),
    );
    const dest = done[0]?.summary?.destinations[0];
    if (tr.direction === "pull") {
      toast.success(t("toast.downloaded", { name, size }), {
        action: dest
          ? { label: t("queue.reveal"), onClick: () => reveal(dest) }
          : undefined,
      });
    } else {
      toast.success(t("toast.uploaded", { name, size, path: tr.target }));
    }
  }
  if (failed.length > 0) {
    const name = label(failed);
    toast.error(
      tr.direction === "pull"
        ? t("toast.downloadFailed", { name })
        : t("toast.uploadFailed", { name }),
      { description: failed[0]?.error?.message },
    );
  }
});
