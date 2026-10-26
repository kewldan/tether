import { create } from "zustand";

import {
  cancelSideload,
  type OtaPackage,
  type SideloadMode,
  startSideload,
} from "@/features/sideload/api";
import i18n from "@/lib/i18n";
import { useTasks } from "@/lib/tasks";
import type { AppError } from "@/lib/tauri";

export interface SideloadJob {
  serial: string;
  path: string;
  name: string;
  status: "running" | "done" | "failed" | "cancelled";
  mode: SideloadMode | null;
  transferred: number;
  size: number;
  /** adb's estimate, 0..100. */
  percent: number;
  startedAt: number;
  elapsedMs: number | null;
  error: string | null;
}

export interface BatteryReading {
  level: number;
  charging: boolean;
  /** When it was read (ms since epoch). */
  at: number;
}

interface SideloadState {
  jobs: Record<string, SideloadJob>;
  /**
   * Last battery level seen while the device was booted: recovery's
   * sideload mode has no shell to ask.
   */
  batteries: Record<string, BatteryReading>;
  start: (serial: string, pkg: OtaPackage) => void;
  cancel: (serial: string) => void;
  dismiss: (serial: string) => void;
  noteBattery: (serial: string, level: number, charging: boolean) => void;
}

const taskId = (serial: string) => `sideload:${serial}`;

/** Sideload jobs per device; they keep running across navigation. */
export const useSideload = create<SideloadState>()((set, get) => {
  const patch = (serial: string, p: Partial<SideloadJob>) =>
    set((s) => {
      const job = s.jobs[serial];
      return job ? { jobs: { ...s.jobs, [serial]: { ...job, ...p } } } : s;
    });

  const publishTask = (job: SideloadJob) =>
    useTasks.getState().upsert({
      id: taskId(job.serial),
      kind: "other",
      label: i18n.t("sideload:task", { name: job.name }),
      progress: job.status === "running" ? job.percent / 100 : 1,
      status: job.status,
    });

  return {
    jobs: {},
    batteries: {},
    start: (serial, pkg) => {
      if (get().jobs[serial]?.status === "running") return;
      const job: SideloadJob = {
        serial,
        path: pkg.path,
        name: pkg.name,
        status: "running",
        mode: null,
        transferred: 0,
        size: pkg.sizeBytes,
        percent: 0,
        startedAt: Date.now(),
        elapsedMs: null,
        error: null,
      };
      set((s) => ({ jobs: { ...s.jobs, [serial]: job } }));
      publishTask(job);
      let lastTask = 0;
      startSideload(serial, pkg.path, (e) => {
        patch(serial, {
          mode: e.mode,
          transferred: e.transferred,
          size: e.size,
          percent: e.percent,
        });
        const now = Date.now();
        const current = get().jobs[serial];
        if (current && now - lastTask > 500) {
          lastTask = now;
          publishTask(current);
        }
      })
        .then((result) => {
          patch(serial, {
            status: "done",
            mode: result.mode,
            percent: 100,
            elapsedMs: result.elapsedMs,
          });
        })
        .catch((error: AppError) => {
          patch(serial, {
            status: error?.kind === "cancelled" ? "cancelled" : "failed",
            error: error?.message ?? String(error),
            elapsedMs: Date.now() - job.startedAt,
          });
        })
        .finally(() => {
          const done = get().jobs[serial];
          if (done) publishTask(done);
        });
    },
    cancel: (serial) => void cancelSideload(serial).catch(() => {}),
    dismiss: (serial) => {
      set((s) => {
        const jobs = { ...s.jobs };
        delete jobs[serial];
        return { jobs };
      });
      useTasks.getState().remove(taskId(serial));
    },
    noteBattery: (serial, level, charging) =>
      set((s) => ({
        batteries: {
          ...s.batteries,
          [serial]: { level, charging, at: Date.now() },
        },
      })),
  };
});
