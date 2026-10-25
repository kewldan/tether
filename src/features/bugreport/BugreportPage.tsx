import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { Archive, Bug, Check, CircleAlert, Loader, Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useNavigation } from "@/app/navigation";
import { Page } from "@/components/layout/Page";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  type BugreportFile,
  deleteBugreport,
  listBugreports,
} from "@/features/bugreport/api";
import {
  type Failure,
  overallProgress,
  type Run,
  useBugreports,
} from "@/features/bugreport/store";
import { deviceName } from "@/features/devices/naming";
import { useDeviceInfo } from "@/features/devices/queries";
import { useDevices, useSelectedDevice } from "@/features/devices/store";
import {
  formatBytes,
  formatElapsed,
  formatWhen,
} from "@/features/overview/format";
import { os } from "@/lib/platform";
import type { AppError } from "@/lib/tauri";
import { cn } from "@/lib/utils";

function errorText(error: unknown) {
  return (error as Partial<AppError>)?.message ?? String(error);
}

function reveal(path: string) {
  void revealItemInDir(path).catch((e) => toast.error(String(e)));
}

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

export default function BugreportPage() {
  const { t } = useTranslation("bugreport");
  const { t: tc } = useTranslation();
  const device = useSelectedDevice();
  const ready = device?.state.kind === "device";
  const { data: info } = useDeviceInfo(ready ? device.serial : null);
  const name = device ? deviceName(device, info) : "";
  const run = useBugreports((s) =>
    device ? (s.runs[device.serial] ?? null) : null,
  );
  const start = useBugreports((s) => s.start);
  const version = useBugreports((s) => s.version);
  const failures = useBugreports((s) => s.failures);
  const forgetFailure = useBugreports((s) => s.forgetFailure);
  const devices = useDevices((s) => s.devices);
  const select = useDevices((s) => s.select);
  const queryClient = useQueryClient();
  const navigate = useNavigation((s) => s.navigate);

  const listKey = ["bugreports", version];
  const { data: list } = useQuery({
    queryKey: listKey,
    queryFn: listBugreports,
  });
  const [confirmDelete, setConfirmDelete] = useState<BugreportFile | null>(
    null,
  );
  const remove = useMutation({
    mutationFn: (f: BugreportFile) => deleteBugreport(f.path),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ["bugreports"] }),
    onError: (e) =>
      toast.error(t("deleteFailed"), { description: errorText(e) }),
  });

  const running = run?.phase === "running" || run?.phase === "pulling";
  const canStart = ready && !running;

  const retry = (f: Failure) => {
    const target = devices.find(
      (d) => d.serial === f.serial && d.state.kind === "device",
    );
    if (!target) {
      toast.error(t("retryUnavailable", { name: f.deviceName }));
      return;
    }
    forgetFailure(f.id);
    select(f.serial);
    start(f.serial, f.deviceName);
  };

  type Row =
    | { kind: "file"; at: number; file: BugreportFile }
    | { kind: "failure"; at: number; failure: Failure };
  const rows: Row[] = [
    ...(list?.reports ?? []).map(
      (file): Row => ({ kind: "file", at: file.modified, file }),
    ),
    ...failures.map(
      (failure): Row => ({ kind: "failure", at: failure.at, failure }),
    ),
  ].sort((a, b) => b.at - a.at);

  return (
    <Page
      title={tc("nav.bugreport")}
      parent={device ? { label: name } : undefined}
      actions={
        <Button
          size="sm"
          variant={canStart ? "default" : "outline"}
          disabled={!canStart}
          onClick={() => device && start(device.serial, name)}
        >
          {t("create")}
        </Button>
      }
    >
      <div className="mx-auto flex w-full max-w-[900px] flex-col gap-4">
        {run && (run.phase === "running" || run.phase === "pulling") && (
          <ProgressCard run={run} />
        )}
        {run?.phase === "done" && run.result && <DoneCard run={run} />}
        {run?.phase === "cancelled" && (
          <Notice
            tone="neutral"
            onDismiss={() =>
              device && useBugreports.getState().dismiss(device.serial)
            }
          >
            {t("cancelled")}
          </Notice>
        )}
        {run?.phase === "failed" && (
          <Notice
            tone="error"
            onDismiss={() =>
              device && useBugreports.getState().dismiss(device.serial)
            }
          >
            <span className="font-semibold">{t("failed")}</span>
            <span className="text-secondary-foreground"> · {run.error}</span>
          </Notice>
        )}
        {!run && (
          <section className="bg-card flex items-center gap-4 rounded-lg border p-[22px]">
            <span className="bg-selected text-secondary-foreground flex size-11 flex-none items-center justify-center rounded-[10px]">
              <Bug className="size-5" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-section font-semibold">
                {t("intro.title")}
              </div>
              <div className="text-secondary-foreground">
                {ready ? t("intro.body") : t("intro.noDevice")}
              </div>
            </div>
            <Button
              disabled={!canStart}
              onClick={() => device && start(device.serial, name)}
            >
              {t("create")}
            </Button>
          </section>
        )}

        <section className="bg-card overflow-hidden rounded-lg border">
          <div className="flex items-center justify-between gap-3 px-4 py-3">
            <h2 className="font-semibold">{t("previous")}</h2>
            {list && (
              <span className="text-muted-foreground text-small min-w-0 truncate">
                {t("savedTo")}{" "}
                <button
                  type="button"
                  className="hover:text-foreground font-mono"
                  onClick={() => reveal(list.dir)}
                >
                  {list.dir.replace(/^\/(Users|home)\/[^/]+/, "~")}
                </button>
              </span>
            )}
          </div>
          {rows.length === 0 ? (
            <p className="text-muted-foreground text-small border-t px-4 py-3">
              {t("none")}
            </p>
          ) : (
            rows.map((row) =>
              row.kind === "file" ? (
                <FileRow
                  key={row.file.path}
                  file={row.file}
                  onDelete={() => setConfirmDelete(row.file)}
                />
              ) : (
                <FailureRow
                  key={row.failure.id}
                  failure={row.failure}
                  onRetry={() => retry(row.failure)}
                  onDismiss={() => forgetFailure(row.failure.id)}
                />
              ),
            )
          )}
        </section>
        {!device && (
          <Button variant="link" onClick={() => navigate("devices")}>
            {tc("sidebar.allDevices")}
          </Button>
        )}
      </div>

      <AlertDialog
        open={confirmDelete !== null}
        onOpenChange={(open) => !open && setConfirmDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription className="break-all">
              {confirmDelete?.name}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tc("actions.cancel")}</AlertDialogCancel>
            <Button
              variant="destructive"
              onClick={() => {
                if (confirmDelete) remove.mutate(confirmDelete);
                setConfirmDelete(null);
              }}
            >
              {t("delete")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Page>
  );
}

function Ring({ value }: { value: number }) {
  const r = 34;
  const c = 2 * Math.PI * r;
  const pct = Math.round(value * 100);
  return (
    <svg
      viewBox="0 0 80 80"
      className="size-[88px] flex-none"
      role="img"
      aria-label={`${pct}%`}
    >
      <circle
        cx="40"
        cy="40"
        r={r}
        fill="none"
        stroke="var(--selected)"
        strokeWidth="6"
      />
      <circle
        cx="40"
        cy="40"
        r={r}
        fill="none"
        stroke="var(--primary)"
        strokeWidth="6"
        strokeLinecap="round"
        strokeDasharray={`${c * value} ${c}`}
        transform="rotate(-90 40 40)"
        className="transition-[stroke-dasharray] duration-500"
      />
      <text
        x="40"
        y="45"
        textAnchor="middle"
        className="fill-foreground text-[15px] font-semibold tabular-nums"
      >
        {pct}%
      </text>
    </svg>
  );
}

type StepState = "done" | "active" | "pending";

function Step({
  state,
  children,
  time,
}: {
  state: StepState;
  children: ReactNode;
  time?: string | null;
}) {
  return (
    <div
      className={cn(
        "text-small flex h-[26px] items-center gap-2.5",
        state === "pending" && "text-muted-foreground",
      )}
    >
      {state === "done" ? (
        <Check className="text-success size-3.5 flex-none" aria-hidden />
      ) : state === "active" ? (
        <Loader
          className="text-brand size-3.5 flex-none animate-spin"
          aria-hidden
        />
      ) : (
        <span className="flex w-3.5 flex-none justify-center">
          <span className="bg-muted-foreground size-[7px] rounded-full" />
        </span>
      )}
      <span
        className={cn("min-w-0 truncate", state === "active" && "font-medium")}
      >
        {children}
      </span>
      {time && (
        <span className="text-muted-foreground ml-auto tabular-nums">
          {time}
        </span>
      )}
    </div>
  );
}

function ProgressCard({ run }: { run: Run }) {
  const { t } = useTranslation("bugreport");
  const now = useNow(true);
  const cancel = useBugreports((s) => s.cancel);
  const progress = overallProgress(run);
  const pulling = run.phase === "pulling";
  const generating = !pulling && run.firstProgressAt !== null;

  const genElapsed =
    run.firstProgressAt !== null
      ? (run.pullStartedAt ?? now) - run.firstProgressAt
      : 0;
  // Remaining time from the generation rate so far (pull is quick).
  let left: string | null = null;
  if (!pulling && run.total > 0 && run.done > 0 && genElapsed > 3000) {
    const remaining = (genElapsed * (run.total - run.done)) / run.done;
    left = t("left", { time: formatElapsed(remaining + 3000) });
  }
  const pct = run.total > 0 ? Math.round((run.done / run.total) * 100) : 0;

  return (
    <section className="bg-card flex items-center gap-6 rounded-lg border p-[22px]">
      <Ring value={progress} />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="text-[16px] font-semibold">{t("creating")}</div>
        <div className="text-secondary-foreground">{t("creatingBody")}</div>
        <div className="mt-1 grid grid-cols-2 gap-x-6">
          <Step
            state={run.firstProgressAt !== null ? "done" : "active"}
            time={
              run.firstProgressAt !== null
                ? formatElapsed(run.firstProgressAt - run.startedAt)
                : null
            }
          >
            {t("steps.start")}
          </Step>
          <Step
            state={pulling ? "done" : generating ? "active" : "pending"}
            time={pulling ? formatElapsed(genElapsed) : null}
          >
            {pulling ? t("steps.collected") : t("steps.collect", { pct })}
          </Step>
          <Step state={pulling ? "active" : "pending"} time={null}>
            {pulling && run.pullTotal
              ? t("steps.pullProgress", {
                  received: formatBytes(run.received),
                  total: formatBytes(run.pullTotal),
                })
              : t(`steps.pull.${os}`)}
          </Step>
        </div>
      </div>
      <div className="flex flex-none flex-col items-end gap-1.5">
        <span className="text-muted-foreground text-small tabular-nums">
          {left ?? formatElapsed(now - run.startedAt)}
        </span>
        <Button variant="ghost" size="sm" onClick={() => cancel(run.serial)}>
          {t("cancel")}
        </Button>
      </div>
    </section>
  );
}

function DoneCard({ run }: { run: Run }) {
  const { t } = useTranslation("bugreport");
  const { t: tg } = useTranslation("gallery");
  const result = run.result;
  if (!result) return null;
  const parts = [
    formatBytes(result.file.sizeBytes),
    run.finishedAt !== null && formatElapsed(run.finishedAt - run.startedAt),
    result.summary &&
      t("includes", {
        anr: t("anr", { count: result.summary.anrTraces }),
        tombstones: t("tombstones", { count: result.summary.tombstones }),
      }),
  ].filter(Boolean);
  return (
    <section className="bg-card border-success flex items-center gap-3.5 rounded-lg border px-[18px] py-4">
      <span className="bg-success/12 text-success flex size-9 flex-none items-center justify-center rounded-[9px]">
        <Check className="size-[18px]" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate font-semibold">
          {t("done", { name: result.file.name })}
        </div>
        <div className="text-muted-foreground text-small truncate">
          {parts.join(" · ")}
        </div>
      </div>
      <Button size="sm" onClick={() => reveal(result.file.path)}>
        {tg(`reveal.${os}`)}
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={() =>
          void navigator.clipboard
            .writeText(result.file.path)
            .then(() => toast.success(t("pathCopied")))
        }
      >
        {t("copyPath")}
      </Button>
      <Button
        variant="outline"
        size="sm"
        title={t("perfettoHint")}
        onClick={() => void openUrl("https://ui.perfetto.dev")}
      >
        {t("perfetto")}
      </Button>
    </section>
  );
}

function Notice({
  tone,
  children,
  onDismiss,
}: {
  tone: "error" | "neutral";
  children: ReactNode;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  return (
    <section
      className={cn(
        "flex items-center gap-3 rounded-lg border px-[18px] py-3",
        tone === "error" ? "bg-error/13" : "bg-card",
      )}
    >
      {tone === "error" && (
        <CircleAlert className="text-error size-4 flex-none" aria-hidden />
      )}
      <div className="min-w-0 flex-1">{children}</div>
      <Button variant="ghost" size="sm" onClick={onDismiss}>
        {t("actions.close")}
      </Button>
    </section>
  );
}

const ROW =
  "grid h-12 grid-cols-[28px_minmax(0,1fr)_140px_90px_auto] items-center gap-3 border-t px-4";

function FileRow({
  file,
  onDelete,
}: {
  file: BugreportFile;
  onDelete: () => void;
}) {
  const { t, i18n } = useTranslation("bugreport");
  return (
    <div className={ROW}>
      <Archive className="text-muted-foreground size-4" aria-hidden />
      <span className="flex min-w-0 items-center gap-2">
        <span className="text-small truncate font-mono">{file.name}</span>
        {file.device && <Badge className="flex-none">{file.device}</Badge>}
      </span>
      <span className="text-muted-foreground text-small tabular-nums">
        {formatWhen(file.modified, i18n.language)}
      </span>
      <span className="text-small tabular-nums">
        {formatBytes(file.sizeBytes)}
      </span>
      <span className="flex items-center gap-0.5">
        <Button variant="ghost" size="sm" onClick={() => reveal(file.path)}>
          {t("reveal")}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("delete")}
          title={t("delete")}
          onClick={onDelete}
        >
          <Trash2 />
        </Button>
      </span>
    </div>
  );
}

function FailureRow({
  failure,
  onRetry,
  onDismiss,
}: {
  failure: Failure;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  const { t, i18n } = useTranslation("bugreport");
  return (
    <div className={cn(ROW, "bg-error/13")}>
      <CircleAlert className="text-error size-4" aria-hidden />
      <span className="text-small truncate" title={failure.message}>
        {t("failedRow", { name: failure.deviceName, message: failure.message })}
      </span>
      <span className="text-muted-foreground text-small tabular-nums">
        {formatWhen(failure.at, i18n.language)}
      </span>
      <span />
      <span className="flex items-center gap-0.5">
        <Button variant="outline" size="sm" onClick={onRetry}>
          {t("retry")}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("dismiss")}
          title={t("dismiss")}
          onClick={onDismiss}
        >
          <Trash2 />
        </Button>
      </span>
    </div>
  );
}
