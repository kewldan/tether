import { useQueryClient } from "@tanstack/react-query";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { create } from "zustand";

import { useNavigation } from "@/app/navigation";
import { Checkbox } from "@/components/ui/checkbox";
import { useTasks } from "@/lib/tasks";
import {
  type AppSummary,
  cancelAppsJob,
  clearAppData,
  extractApks,
  forceStopApp,
  installExistingApp,
  launchApp,
  setAppEnabled,
  uninstallApp,
} from "./api";
import type { ConfirmRequest } from "./components/ConfirmDialog";
import { appName } from "./naming";
import { appsKey, errorHint, errorMessage } from "./queries";
import { useAppMetaStore } from "./store";

/** The confirmation currently asked by the Apps page, if any. */
export const useConfirm = create<{
  request: ConfirmRequest | null;
  ask: (request: ConfirmRequest | null) => void;
}>()((set) => ({ request: null, ask: (request) => set({ request }) }));

function KeepDataOption({ onChange }: { onChange: (keep: boolean) => void }) {
  const { t } = useTranslation("apps");
  const [keep, setKeep] = useState(false);
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: Checkbox renders the control
    <label className="text-body flex cursor-pointer items-center gap-2.5">
      <Checkbox
        checked={keep}
        onCheckedChange={(v) => {
          setKeep(v);
          onChange(v);
        }}
      />
      <span>
        {t("confirm.uninstall.keepData")}{" "}
        <span className="text-muted-foreground font-mono">-k</span>
      </span>
    </label>
  );
}

/**
 * Per-app actions shared by the table, the bulk bar and the detail view:
 * confirmation, toasts with undo, refetching and task progress.
 */
export function useAppActions(serial: string | null, deviceName: string) {
  const { t } = useTranslation("apps");
  const client = useQueryClient();
  const ask = useConfirm((s) => s.ask);
  const navigate = useNavigation((s) => s.navigate);
  const upsertTask = useTasks((s) => s.upsert);

  const nameOf = (app: AppSummary) =>
    appName(
      app,
      useAppMetaStore.getState().bySerial[serial ?? ""]?.[app.package],
    );

  const refresh = () => {
    void client.invalidateQueries({ queryKey: appsKey(serial) });
    void client.invalidateQueries({ queryKey: ["app", serial] });
  };

  const fail = (error: unknown) =>
    toast.error(errorMessage(error), { description: errorHint(error) });

  /** Runs `run` for every app; reports a single summary toast. */
  async function forEach(
    apps: AppSummary[],
    run: (app: AppSummary) => Promise<unknown>,
    done: (ok: AppSummary[]) => void,
  ) {
    const ok: AppSummary[] = [];
    const failed: string[] = [];
    for (const app of apps) {
      try {
        await run(app);
        ok.push(app);
      } catch (error) {
        failed.push(`${app.package}: ${errorMessage(error)}`);
      }
    }
    refresh();
    if (ok.length > 0) done(ok);
    if (failed.length > 0) {
      toast.error(t("toast.someFailed", { count: failed.length }), {
        description: failed.slice(0, 3).join("\n"),
      });
    }
  }

  const subject = (apps: AppSummary[]) =>
    apps.length === 1
      ? nameOf(apps[0])
      : t("toast.appsCount", { count: apps.length });

  if (!serial) return null;
  const pkg = (app: AppSummary) => ({ serial, package: app.package });

  return {
    open: (app: AppSummary) => launchApp(pkg(app)).catch(fail),
    forceStop: (app: AppSummary) =>
      forceStopApp(pkg(app))
        .then(() => {
          toast.success(t("toast.stopped", { name: nameOf(app) }));
          refresh();
        })
        .catch(fail),
    clearCache: (app: AppSummary) =>
      clearAppData({ ...pkg(app), cacheOnly: true })
        .then(() => {
          toast.success(t("toast.cacheCleared", { name: nameOf(app) }));
          refresh();
        })
        .catch(fail),
    logcat: (app: AppSummary) => navigate("logcat", { package: app.package }),

    clearData: (apps: AppSummary[]) => {
      const single = apps.length === 1 ? apps[0] : null;
      ask({
        title: t("confirm.clearData.title", { count: apps.length }),
        description: single ? (
          <>
            {t("confirm.clearData.single.before")}
            <span className="text-foreground font-mono">{single.package}</span>
            {t("confirm.clearData.single.after", { device: deviceName })}
          </>
        ) : (
          t("confirm.clearData.many", {
            count: apps.length,
            device: deviceName,
          })
        ),
        confirmLabel: t("actions.clearData"),
        destructive: true,
        typeToConfirm: single ? single.package : String(apps.length),
        onConfirm: () =>
          void forEach(
            apps,
            (a) => clearAppData({ ...pkg(a), cacheOnly: false }),
            (ok) =>
              toast.success(t("toast.dataCleared", { name: subject(ok) })),
          ),
      });
    },

    setEnabled: (apps: AppSummary[], enabled: boolean) => {
      const run = () =>
        void forEach(
          apps,
          (a) => setAppEnabled({ ...pkg(a), enabled }),
          (ok) =>
            toast.success(
              t(enabled ? "toast.enabled" : "toast.disabled", {
                name: subject(ok),
              }),
              {
                action: {
                  label: t("toast.undo"),
                  onClick: () =>
                    void forEach(
                      ok,
                      (a) => setAppEnabled({ ...pkg(a), enabled: !enabled }),
                      () => {},
                    ),
                },
              },
            ),
        );
      if (enabled) return run();
      ask({
        title: t("confirm.disable.title", {
          count: apps.length,
          name: subject(apps),
        }),
        description: apps.some((a) => a.system)
          ? t("confirm.disable.system")
          : t("confirm.disable.user"),
        confirmLabel: t("actions.disable"),
        onConfirm: run,
      });
    },

    uninstall: (apps: AppSummary[], onDone?: () => void) => {
      let keepData = false;
      const system = apps.some((a) => a.system);
      ask({
        title: t("confirm.uninstall.title", {
          count: apps.length,
          name: subject(apps),
        }),
        description: system
          ? t("confirm.uninstall.system", { device: deviceName })
          : t("confirm.uninstall.user", {
              count: apps.length,
              device: deviceName,
            }),
        confirmLabel: t("actions.uninstall"),
        destructive: true,
        extra: <KeepDataOption onChange={(v) => (keepData = v)} />,
        onConfirm: () =>
          void forEach(
            apps,
            (a) => uninstallApp({ ...pkg(a), keepData, system: a.system }),
            (ok) => {
              onDone?.();
              const restorable = ok.filter((a) => a.system);
              toast.success(
                t("toast.uninstalled", { name: subject(ok) }),
                restorable.length > 0
                  ? {
                      action: {
                        label: t("toast.undo"),
                        onClick: () =>
                          void forEach(
                            restorable,
                            (a) => installExistingApp(pkg(a)),
                            () =>
                              toast.success(
                                t("toast.restored", {
                                  name: subject(restorable),
                                }),
                              ),
                          ),
                      },
                    }
                  : undefined,
              );
            },
          ),
      });
    },

    extract: async (apps: AppSummary[]) => {
      let dest: string | null = null;
      try {
        const picked = await openDialog({
          directory: true,
          title: t("extract.pickFolder"),
        });
        dest = typeof picked === "string" ? picked : null;
      } catch (error) {
        fail(error);
      }
      if (!dest) return;
      const jobId = crypto.randomUUID();
      const taskId = `extract:${jobId}`;
      const label = t("extract.task", { name: subject(apps) });
      const done = new Set<string>();
      let last = "";
      upsertTask({
        id: taskId,
        kind: "transfer",
        label,
        progress: 0,
        status: "running",
      });
      try {
        const written = await extractApks(
          { jobId, serial, packages: apps.map((a) => a.package), dest },
          (e) => {
            if (e.type === "progress") {
              const current = e.total > 0 ? e.received / e.total : 0;
              upsertTask({
                id: taskId,
                kind: "transfer",
                label,
                progress: (done.size + current) / apps.length,
                status: "running",
              });
            } else if (e.type === "done") {
              done.add(e.package);
              last = e.path;
            } else {
              toast.error(t("extract.failed", { name: e.package }), {
                description: e.message,
              });
            }
          },
        );
        upsertTask({
          id: taskId,
          kind: "transfer",
          label,
          progress: 1,
          status: "done",
        });
        if (written.length > 0) {
          toast.success(t("extract.done", { count: written.length }), {
            description: written.length === 1 ? last : dest,
            action: {
              label: t("extract.reveal"),
              onClick: () =>
                void revealItemInDir(last || dest || "").catch(fail),
            },
          });
        }
      } catch (error) {
        upsertTask({
          id: taskId,
          kind: "transfer",
          label,
          progress: null,
          status: "failed",
        });
        void cancelAppsJob(jobId);
        fail(error);
      }
    },
  };
}

export type AppActions = NonNullable<ReturnType<typeof useAppActions>>;
