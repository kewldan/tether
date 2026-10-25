import { create } from "zustand";
import { persist } from "zustand/middleware";

import {
  type BugreportResult,
  cancelBugreport,
  createBugreport,
} from "@/features/bugreport/api";
import { recordHistory } from "@/features/overview/history";
import i18n from "@/lib/i18n";
import { useTasks } from "@/lib/tasks";
import type { AppError } from "@/lib/tauri";

export interface Run {
  serial: string;
  deviceName: string;
  phase: "running" | "pulling" | "done" | "failed" | "cancelled";
  startedAt: number;
  /** When dumpstate reported its first progress. */
  firstProgressAt: number | null;
  /** When pulling started. */
  pullStartedAt: number | null;
  finishedAt: number | null;
  done: number;
  total: number;
  received: number;
  pullTotal: number | null;
  result: BugreportResult | null;
  error: string | null;
}

export interface Failure {
  id: string;
  serial: string;
  deviceName: string;
  message: string;
  at: number;
}

interface BugreportState {
  /** Latest run per device (kept after it finishes to show the result). */
  runs: Record<string, Run>;
  failures: Failure[];
  /** Bumped when a report lands on disk, so lists refetch. */
  version: number;
  start: (serial: string, deviceName: string) => void;
  cancel: (serial: string) => void;
  dismiss: (serial: string) => void;
  forgetFailure: (id: string) => void;
}

/** Share of the overall progress given to generating (the rest is the pull). */
const GENERATE_SHARE = 0.9;

export function overallProgress(run: Run): number {
  if (run.phase === "done") return 1;
  const gen = run.total > 0 ? Math.min(run.done / run.total, 1) : 0;
  if (run.phase !== "pulling") return gen * GENERATE_SHARE;
  const pull = run.pullTotal ? Math.min(run.received / run.pullTotal, 1) : 0;
  return GENERATE_SHARE + pull * (1 - GENERATE_SHARE);
}

const taskId = (serial: string) => `bugreport-${serial}`;

export const useBugreports = create<BugreportState>()(
  persist(
    (set, get) => {
      const update = (serial: string, patch: Partial<Run>) => {
        const run = get().runs[serial];
        if (!run) return;
        const next = { ...run, ...patch };
        set((s) => ({ runs: { ...s.runs, [serial]: next } }));
        const status =
          next.phase === "done"
            ? "done"
            : next.phase === "failed"
              ? "failed"
              : next.phase === "cancelled"
                ? "cancelled"
                : "running";
        useTasks.getState().upsert({
          id: taskId(serial),
          kind: "bugreport",
          label: i18n.t("task", { ns: "bugreport", name: next.deviceName }),
          progress: next.total > 0 ? overallProgress(next) : null,
          status,
        });
      };

      return {
        runs: {},
        failures: [],
        version: 0,
        start: (serial, deviceName) => {
          const current = get().runs[serial];
          if (
            current &&
            (current.phase === "running" || current.phase === "pulling")
          )
            return;
          set((s) => ({
            runs: {
              ...s.runs,
              [serial]: {
                serial,
                deviceName,
                phase: "running",
                startedAt: Date.now(),
                firstProgressAt: null,
                pullStartedAt: null,
                finishedAt: null,
                done: 0,
                total: 0,
                received: 0,
                pullTotal: null,
                result: null,
                error: null,
              },
            },
          }));
          update(serial, {});
          createBugreport(serial, (event) => {
            const run = get().runs[serial];
            if (!run) return;
            if (event.type === "progress") {
              update(serial, {
                done: event.done,
                total: event.total,
                firstProgressAt: run.firstProgressAt ?? Date.now(),
              });
            } else {
              update(serial, {
                phase: "pulling",
                received: event.received,
                pullTotal: event.total,
                pullStartedAt: run.pullStartedAt ?? Date.now(),
              });
            }
          })
            .then((result) => {
              update(serial, {
                phase: "done",
                result,
                finishedAt: Date.now(),
              });
              set((s) => ({ version: s.version + 1 }));
              recordHistory({
                serial,
                kind: "bugreport",
                label: result.file.name,
                path: result.file.path,
              });
            })
            .catch((error: AppError) => {
              const cancelled = error?.kind === "cancelled";
              const message = error?.message ?? String(error);
              update(serial, {
                phase: cancelled ? "cancelled" : "failed",
                error: message,
                finishedAt: Date.now(),
              });
              if (!cancelled) {
                set((s) => ({
                  failures: [
                    {
                      id: `${Date.now()}`,
                      serial,
                      deviceName,
                      message,
                      at: Date.now(),
                    },
                    ...s.failures,
                  ].slice(0, 20),
                }));
              }
            });
        },
        cancel: (serial) => {
          void cancelBugreport(serial);
        },
        dismiss: (serial) => {
          set((s) => {
            const runs = { ...s.runs };
            delete runs[serial];
            return { runs };
          });
          useTasks.getState().remove(taskId(serial));
        },
        forgetFailure: (id) =>
          set((s) => ({ failures: s.failures.filter((f) => f.id !== id) })),
      };
    },
    {
      name: "tether.bugreport",
      partialize: (s) => ({ failures: s.failures }),
    },
  ),
);
