import { useQuery } from "@tanstack/react-query";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { cn } from "cn";
import {
  Check as CheckIcon,
  Minus,
  RefreshCw,
  TriangleAlert,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { toast } from "sonner";

import { useNavigation } from "@/app/navigation";
import { Page } from "@/components/layout/Page";
import {
  AlertDialog,
  AlertDialogAction,
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { reconnectDevice } from "@/features/devices/api";
import { UdevDialog } from "@/features/devices/dialogs";
import { useDevices } from "@/features/devices/store";
import {
  type Check,
  type CheckStatus,
  type DiagnosticsReport,
  runDiagnostics,
} from "@/features/diagnostics/api";
import { formatReport } from "@/features/diagnostics/report";
import { restartServer } from "@/features/onboarding/api";
import {
  type Brand,
  BrandSwitch,
  PhoneSteps,
} from "@/features/onboarding/PhoneGuide";
import { useAdb } from "@/lib/adb";
import type { AppError } from "@/lib/tauri";

const WIN_DRIVER_URL = "https://developer.android.com/studio/run/win-usb";
const TEXT = {
  m: <span className="font-mono" />,
  b: <b className="text-foreground font-semibold" />,
};

type Action = "restart" | "howto" | "retryAuth" | "udev" | "driver";

function actionFor(c: Check): Action | null {
  if (c.id === "server_running" && c.status === "fail") return "restart";
  if (c.id === "server_conflict" && c.status === "warn") return "restart";
  if (c.id === "usb_debugging" && c.status !== "pass") return "howto";
  if (c.id === "authorization" && c.status === "warn") return "retryAuth";
  if (c.id === "permissions" && c.status === "fail" && c.params.os === "linux")
    return "udev";
  if (c.id === "drivers" && c.variant === "udev_missing") return "udev";
  if (c.id === "drivers" && c.variant === "windows_unknown") return "driver";
  return null;
}

function useNow(interval = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(timer);
  }, [interval]);
  return now;
}

/** 04 · Can't see your device? Real checks, worst first in the headline. */
export default function DiagnosticsPage() {
  const { t } = useTranslation("diagnostics");
  const navigate = useNavigation((s) => s.navigate);
  const { data, isFetching, refetch, error } = useQuery({
    queryKey: ["diagnostics"],
    queryFn: runDiagnostics,
    refetchOnMount: "always",
  });
  const [dialog, setDialog] = useState<Action | null>(null);
  const now = useNow();

  // Re-check shortly after the device list changes: fixes resolve live.
  const signature = useDevices((s) =>
    s.devices.map((d) => `${d.serial}:${d.state.kind}`).join(","),
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run on device changes only
  useEffect(() => {
    const timer = setTimeout(() => void refetch(), 800);
    return () => clearTimeout(timer);
  }, [signature]);

  const ago = data
    ? Math.max(0, Math.round((now - data.checkedAt) / 1000))
    : null;

  return (
    <Page
      title={t("title")}
      parent={{
        label: t("common:nav.devices"),
        onClick: () => navigate("devices"),
      }}
      actions={
        <>
          {ago !== null && (
            <span className="text-small text-muted-foreground tabular-nums">
              {t("checkedAgo", { count: ago })}
            </span>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={isFetching}
            onClick={() => void refetch()}
          >
            <RefreshCw className={cn(isFetching && "animate-spin")} />
            {t("runAgain")}
          </Button>
        </>
      }
    >
      <div className="mx-auto flex w-full max-w-[860px] flex-col gap-4">
        {error && !data && (
          <div
            role="alert"
            className="bg-error/13 text-error rounded-md px-3 py-2"
          >
            {(error as unknown as AppError).message}
          </div>
        )}
        {data ? (
          <>
            <Summary report={data} />
            <ul className="bg-card overflow-hidden rounded-[10px] border">
              {data.checks.map((c) => (
                <CheckRow
                  key={`${c.id}-${c.variant}`}
                  check={c}
                  report={data}
                  onAction={setDialog}
                />
              ))}
            </ul>
            <ReportFooter report={data} />
          </>
        ) : (
          !error && <Skeleton />
        )}
      </div>
      <RestartDialog
        open={dialog === "restart"}
        onClose={() => setDialog(null)}
        onDone={() => void refetch()}
      />
      <HowToDialog open={dialog === "howto"} onClose={() => setDialog(null)} />
      <UdevDialog open={dialog === "udev"} onClose={() => setDialog(null)} />
    </Page>
  );
}

function Skeleton() {
  return (
    <div className="bg-card flex flex-col rounded-[10px] border" aria-busy>
      {["a", "b", "c", "d", "e", "f"].map((key) => (
        <div
          key={key}
          className="flex gap-3.5 border-b px-[18px] py-3.5 last:border-b-0"
        >
          <span className="bg-selected size-6 rounded-full" />
          <span className="flex flex-1 flex-col gap-2">
            <span className="bg-selected h-3 w-1/3 rounded-xs" />
            <span className="bg-selected h-2.5 w-2/3 rounded-xs" />
          </span>
        </div>
      ))}
    </div>
  );
}

function Summary({ report }: { report: DiagnosticsReport }) {
  const { t } = useTranslation("diagnostics");
  const count = (s: CheckStatus) =>
    report.checks.filter((c) => c.status === s).length;
  const worst =
    report.checks.find((c) => c.status === "fail") ??
    report.checks.find((c) => c.status === "warn");
  const devices = report.facts.devices.length;
  const tone =
    worst?.status === "fail" ? "error" : worst ? "warning" : "success";
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-4 rounded-[10px] border px-[18px] py-4",
        tone === "error" && "border-error bg-error/13",
        tone === "warning" && "border-warning bg-warning/12",
        tone === "success" && "border-success bg-success/12",
      )}
    >
      <div className="min-w-0 flex-[1_1_300px]">
        <div className="text-section font-semibold">
          {worst
            ? t(`headline.${worst.id}.${worst.variant}`, {
                defaultValue: t(
                  `checks.${worst.id}.${worst.variant}.title`,
                  worst.params,
                ),
                ...worst.params,
              })
            : devices > 0
              ? t("headline.ok", { count: devices })
              : t("headline.okEmpty")}
        </div>
        <div className="text-secondary-foreground mt-0.5">
          {worst ? t("headline.fixFirst") : t("headline.allGood")}
        </div>
      </div>
      <div className="flex gap-1.5">
        <Badge variant="success" className="tabular-nums">
          {t("passed", { count: count("pass") })}
        </Badge>
        {count("warn") > 0 && (
          <Badge variant="warning" className="tabular-nums">
            {t("warnings", { count: count("warn") })}
          </Badge>
        )}
        {count("fail") > 0 && (
          <Badge variant="error" className="tabular-nums">
            {t("problems", { count: count("fail") })}
          </Badge>
        )}
      </div>
    </div>
  );
}

function uptime(
  secs: number,
  t: (k: string, o?: Record<string, unknown>) => string,
) {
  if (secs < 60) return t("time.seconds", { count: secs });
  if (secs < 3600) return t("time.minutes", { count: Math.round(secs / 60) });
  if (secs < 86_400) return t("time.hours", { count: Math.round(secs / 3600) });
  return t("time.days", { count: Math.round(secs / 86_400) });
}

function CheckRow({
  check,
  report,
  onAction,
}: {
  check: Check;
  report: DiagnosticsReport;
  onAction: (a: Action) => void;
}) {
  const { t, i18n } = useTranslation("diagnostics");
  const devices = useDevices((s) => s.devices);
  const action = actionFor(check);
  const params: Record<string, string> = { ...check.params };
  if (params.uptimeSecs) params.uptime = uptime(Number(params.uptimeSecs), t);
  if (check.id === "server_running" || check.id === "server_conflict") {
    params.ours = report.facts.adbVersion?.split("-")[0] ?? "?";
  }
  // OS-specific wording (e.g. `ok_macos`) wins when it exists.
  const generic = `checks.${check.id}.${check.variant}`;
  const base =
    params.os && i18n.exists(`diagnostics:${generic}_${params.os}.title`)
      ? `${generic}_${params.os}`
      : generic;

  const retryAuth = () => {
    const pending = devices.filter(
      (d) => d.state.kind === "unauthorized" || d.state.kind === "authorizing",
    );
    Promise.all(pending.map((d) => reconnectDevice(d.serial)))
      .then(() => toast(t("retrying")))
      .catch((e: AppError) => toast.error(e.message));
  };

  return (
    <li
      className={cn(
        "grid grid-cols-[28px_minmax(0,1fr)_auto] items-start gap-3.5 border-b px-[18px] py-3.5 last:border-b-0",
        check.status === "fail" && "bg-error/13",
        check.status === "skip" && "opacity-60",
      )}
    >
      <StatusIcon status={check.status} />
      <div className="min-w-0">
        <div className="font-semibold">{t(`${base}.title`, params)}</div>
        <div className="text-small text-secondary-foreground mt-0.5 leading-[18px]">
          <Trans
            t={t}
            i18nKey={`${base}.desc`}
            values={params}
            components={TEXT}
          />
        </div>
        {check.details && (
          <details>
            <summary className="text-small text-muted-foreground mt-1.5 cursor-pointer">
              {t("showOutput")}
            </summary>
            <pre className="bg-sidebar text-caption selectable mt-1.5 overflow-auto rounded-[7px] border px-2.5 py-2 font-mono leading-[17px] whitespace-pre">
              {check.details}
            </pre>
          </details>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        {check.status === "skip" && !action && (
          <span className="text-small text-muted-foreground">
            {t("skipped")}
          </span>
        )}
        {action && (
          <Button
            size="sm"
            variant={check.status === "fail" ? "default" : "outline"}
            onClick={() => {
              if (action === "retryAuth") retryAuth();
              else if (action === "driver") void openUrl(WIN_DRIVER_URL);
              else onAction(action);
            }}
          >
            {t(`actions.${action}`)}
          </Button>
        )}
      </div>
    </li>
  );
}

function StatusIcon({ status }: { status: CheckStatus }) {
  const { t } = useTranslation("diagnostics");
  const Icon =
    status === "pass"
      ? CheckIcon
      : status === "warn"
        ? TriangleAlert
        : status === "fail"
          ? X
          : Minus;
  return (
    <span
      role="img"
      aria-label={t(`status.${status}`)}
      className={cn(
        "flex size-6 items-center justify-center rounded-full",
        status === "pass" && "bg-success/12 text-success",
        status === "warn" && "bg-warning/12 text-warning",
        status === "fail" && "bg-error/13 text-error",
        status === "skip" && "bg-selected text-muted-foreground",
      )}
    >
      <Icon className="size-3.5" strokeWidth={2.4} aria-hidden />
    </span>
  );
}

function ReportFooter({ report }: { report: DiagnosticsReport }) {
  const { t } = useTranslation("diagnostics");
  const adb = useAdb((s) => s.adb);
  const copy = async () => {
    const version = await getVersion().catch(() => null);
    await navigator.clipboard.writeText(
      formatReport(
        report,
        adb.status === "found" ? adb.install : null,
        version,
      ),
    );
    toast.success(t("reportCopied"));
  };
  return (
    <p className="text-small text-muted-foreground text-center">
      <Trans
        t={t}
        i18nKey="stillStuck"
        components={{
          a: (
            <button
              type="button"
              className="text-brand hover:underline"
              onClick={() => void copy()}
            />
          ),
        }}
      />
    </p>
  );
}

function RestartDialog({
  open,
  onClose,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation("diagnostics");
  const [busy, setBusy] = useState(false);
  const restart = () => {
    setBusy(true);
    restartServer()
      .then(() => {
        toast.success(t("restart.done"));
        onDone();
      })
      .catch((e: AppError) =>
        toast.error(t("restart.failed"), { description: e.message }),
      )
      .finally(() => {
        setBusy(false);
        onClose();
      });
  };
  return (
    <AlertDialog open={open} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("restart.title")}</AlertDialogTitle>
          <AlertDialogDescription>{t("restart.text")}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common:actions.cancel")}</AlertDialogCancel>
          <AlertDialogAction disabled={busy} onClick={restart}>
            {t("restart.confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function HowToDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation("diagnostics");
  const [brand, setBrand] = useState<Brand>("pixel");
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[min(1040px,calc(100%-4rem))]">
        <DialogHeader className="flex-row items-end justify-between gap-4 pr-8">
          <div>
            <DialogTitle>{t("howto.title")}</DialogTitle>
            <DialogDescription>{t("howto.text")}</DialogDescription>
          </div>
          <BrandSwitch value={brand} onChange={setBrand} />
        </DialogHeader>
        <PhoneSteps brand={brand} highlight={2} />
      </DialogContent>
    </Dialog>
  );
}
