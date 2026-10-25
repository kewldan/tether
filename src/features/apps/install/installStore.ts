import { create } from "zustand";

import i18n from "@/lib/i18n";
import { useTasks } from "@/lib/tasks";
import {
  cancelAppsJob,
  type InstallFailure,
  type InstallOptions,
  type InstallStage,
  inspectPackageFile,
  installPackage,
  type PackageFile,
} from "../api";
import { errorMessage } from "../queries";

export type RowStatus =
  | "idle"
  | "waiting"
  | "installing"
  | "done"
  | "failed"
  | "cancelled";

export interface DeviceRow {
  status: RowStatus;
  stage: InstallStage | null;
  sent: number;
  total: number;
  elapsedMs: number | null;
  error: InstallFailure | null;
  jobId: string | null;
}

const IDLE: DeviceRow = {
  status: "idle",
  stage: null,
  sent: 0,
  total: 0,
  elapsedMs: null,
  error: null,
  jobId: null,
};

export const DEFAULT_OPTIONS: InstallOptions = {
  reinstall: true,
  downgrade: false,
  grantAll: true,
  testOnly: false,
  bypassLowTargetSdk: false,
  launch: false,
};

interface InstallState {
  open: boolean;
  path: string | null;
  file: PackageFile | null;
  fileError: string | null;
  inspecting: boolean;
  selected: string[];
  rows: Record<string, DeviceRow>;
  options: InstallOptions;
  /** Called after any device finished installing (refresh app lists). */
  onInstalled: ((serial: string) => void) | null;

  openWith: (path: string, serials: string[]) => void;
  reopen: () => void;
  close: () => void;
  toggle: (serial: string, on: boolean) => void;
  setOption: (key: keyof InstallOptions, value: boolean) => void;
  start: (serials: string[], overrides?: Partial<InstallOptions>) => void;
  cancel: (serial?: string) => void;
  skip: (serial: string) => void;
}

const isActive = (r: DeviceRow) =>
  r.status === "waiting" || r.status === "installing";

export const useInstall = create<InstallState>()((set, get) => {
  const patch = (serial: string, p: Partial<DeviceRow>) =>
    set((s) => ({
      rows: { ...s.rows, [serial]: { ...(s.rows[serial] ?? IDLE), ...p } },
    }));

  /** Mirrors the overall progress into the sidebar task indicator. */
  const syncTask = () => {
    const { file, rows, path } = get();
    const active = Object.entries(rows).filter(([, r]) => r.status !== "idle");
    if (!path || active.length === 0) return;
    const running = active.some(([, r]) => isActive(r));
    const failed = active.some(([, r]) => r.status === "failed");
    const progress =
      active.reduce((sum, [, r]) => {
        if (r.status === "done") return sum + 1;
        return sum + (r.total > 0 ? r.sent / r.total : 0);
      }, 0) / active.length;
    useTasks.getState().upsert({
      id: `install:${path}`,
      kind: "install",
      label: i18n.t("apps:install.task", {
        name: file?.label ?? file?.package ?? path.split(/[\\/]/).pop(),
      }),
      progress,
      status: running ? "running" : failed ? "failed" : "done",
    });
  };

  return {
    open: false,
    path: null,
    file: null,
    fileError: null,
    inspecting: false,
    selected: [],
    rows: {},
    options: DEFAULT_OPTIONS,
    onInstalled: null,

    openWith: (path, serials) => {
      const busy = Object.values(get().rows).some(isActive);
      if (busy && get().path !== path) {
        // Keep the running job; just show it.
        set({ open: true });
        return;
      }
      set({
        open: true,
        path,
        file: null,
        fileError: null,
        inspecting: true,
        selected: serials,
        rows: {},
        options: DEFAULT_OPTIONS,
      });
      inspectPackageFile(path, i18n.language)
        .then((file) => {
          if (get().path !== path) return;
          set((s) => ({
            file,
            inspecting: false,
            options: { ...s.options, testOnly: file.testOnly },
          }));
        })
        .catch((error) => {
          if (get().path !== path) return;
          set({ inspecting: false, fileError: errorMessage(error) });
        });
    },
    reopen: () => set({ open: true }),
    close: () => set({ open: false }),
    toggle: (serial, on) =>
      set((s) => ({
        selected: on
          ? [...new Set([...s.selected, serial])]
          : s.selected.filter((x) => x !== serial),
      })),
    setOption: (key, value) =>
      set((s) => ({ options: { ...s.options, [key]: value } })),

    start: (serials, overrides) => {
      const { path, options } = get();
      if (!path || serials.length === 0) return;
      const jobId = crypto.randomUUID();
      for (const serial of serials) {
        patch(serial, { ...IDLE, status: "waiting", jobId });
      }
      syncTask();
      const opts = { ...options, ...overrides };
      installPackage({ jobId, serials, path, options: opts }, (e) => {
        switch (e.type) {
          case "stage":
            patch(e.serial, { status: "installing", stage: e.stage });
            break;
          case "progress":
            patch(e.serial, {
              status: "installing",
              sent: e.sent,
              total: e.total,
            });
            break;
          case "done":
            patch(e.serial, { status: "done", elapsedMs: e.elapsedMs });
            get().onInstalled?.(e.serial);
            break;
          case "failed":
            patch(e.serial, { status: "failed", error: e.error });
            break;
          case "cancelled":
            patch(e.serial, { status: "cancelled" });
            break;
        }
        syncTask();
      }).catch((error) => {
        for (const serial of serials) {
          if (isActive(get().rows[serial] ?? IDLE)) {
            patch(serial, {
              status: "failed",
              error: { code: null, message: errorMessage(error), raw: "" },
            });
          }
        }
        syncTask();
      });
    },

    cancel: (serial) => {
      const rows = get().rows;
      const targets = serial ? [serial] : Object.keys(rows);
      for (const s of targets) {
        const row = rows[s];
        if (row?.jobId && isActive(row)) void cancelAppsJob(row.jobId, s);
      }
    },
    skip: (serial) => {
      patch(serial, { ...IDLE, status: "cancelled" });
      get().toggle(serial, false);
      syncTask();
    },
  };
});

export function summarize(rows: Record<string, DeviceRow>, serials: string[]) {
  let done = 0;
  let running = 0;
  let waiting = 0;
  let failed = 0;
  for (const s of serials) {
    const r = rows[s] ?? IDLE;
    if (r.status === "done") done++;
    else if (r.status === "installing") running++;
    else if (r.status === "waiting") waiting++;
    else if (r.status === "failed") failed++;
  }
  return { done, running, waiting, failed, total: serials.length };
}

export const rowOf = (rows: Record<string, DeviceRow>, serial: string) =>
  rows[serial] ?? IDLE;
