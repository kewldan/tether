import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  CircleCheck,
  CircleX,
  FileArchive,
  Loader,
  TriangleAlert,
  Upload,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { toast } from "sonner";

import { useNavigation } from "@/app/navigation";
import { Page } from "@/components/layout/Page";
import { deviceTone, StatusDot } from "@/components/status/StatusDot";
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
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { rebootDevice } from "@/features/devices/api";
import { useDeviceName } from "@/features/devices/naming";
import { useDeviceSummary } from "@/features/devices/queries";
import { useDevices } from "@/features/devices/store";
import { formatBytes, formatEta } from "@/features/files/format";
import { inspectOta, type OtaPackage } from "@/features/sideload/api";
import {
  BATTERY_OK,
  type Check,
  codename,
  sideloadChecks,
} from "@/features/sideload/checks";
import { type SideloadJob, useSideload } from "@/features/sideload/store";
import { useZipDrop } from "@/features/sideload/useZipDrop";
import type { AppError, Device } from "@/lib/tauri";
import { cn } from "@/lib/utils";

const errorText = (e: unknown) =>
  (e as Partial<AppError>)?.message ?? String(e);

/** P2 · Sideload OTA: flash an OTA zip through recovery's adb sideload. */
export default function SideloadPage() {
  const { t } = useTranslation("sideload");
  const params = useNavigation((s) => s.params);
  const selected = useDevices((s) => s.selectedSerial);
  const serial = params.serial ?? selected;
  const device = useDevices(
    (s) =>
      s.devices.find((d) => d.serial === serial) ??
      (serial ? (s.snapshots[serial] ?? null) : null),
  );
  const live = useDevices((s) => s.devices.some((d) => d.serial === serial));
  const name = useDeviceName(device) ?? serial ?? "";
  const job = useSideload((s) => (serial ? s.jobs[serial] : undefined));
  const battery = useSideload((s) =>
    serial ? (s.batteries[serial] ?? null) : null,
  );
  const noteBattery = useSideload((s) => s.noteBattery);
  const [pkg, setPkg] = useState<OtaPackage | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [ack, setAck] = useState(false);
  const [confirming, setConfirming] = useState(false);

  // Battery can only be read while Android runs; remember the last value.
  const booted = device?.state.kind === "device" && live;
  const { data: summary } = useDeviceSummary(booted ? device.serial : null);
  useEffect(() => {
    if (serial && summary?.battery != null)
      noteBattery(serial, summary.battery, summary.charging);
  }, [serial, summary, noteBattery]);

  const choose = async (path: string) => {
    setInspecting(true);
    try {
      setPkg(await inspectOta(path));
      setAck(false);
    } catch (error) {
      toast.error(t("file.failed"), { description: errorText(error) });
    } finally {
      setInspecting(false);
    }
  };

  const pick = async () => {
    try {
      const picked = await openDialog({
        multiple: false,
        directory: false,
        title: t("file.pickTitle"),
        filters: [{ name: t("file.filter"), extensions: ["zip"] }],
      });
      if (typeof picked === "string") await choose(picked);
    } catch (error) {
      toast.error(errorText(error));
    }
  };

  const running = job?.status === "running";
  const dragging = useZipDrop(!running, (path) => void choose(path));

  if (!device || !serial) {
    return (
      <Page title={t("title")}>
        <p className="text-muted-foreground py-16 text-center">
          {t("noDevice")}
        </p>
      </Page>
    );
  }

  const checks = live
    ? sideloadChecks(device, pkg, battery)
    : [
        {
          id: "state",
          tone: "error" as const,
          blocking: true,
          key: "checks.gone",
        },
      ];
  const blocked = checks.some((c) => c.blocking);
  const needsAck = checks.some((c) => c.id === "battery" && !battery);
  const canStart =
    pkg !== null && !blocked && (!needsAck || ack) && !running && live;
  const phrase = codename(device) ?? device.serial;

  return (
    <Page
      title={
        <span className="flex items-center gap-2">
          {t("title")}
          <Badge variant={live ? toneVariant(device) : "error"}>
            <StatusDot tone={live ? deviceTone(device.state) : "error"} />
            {live
              ? t(`state.${device.state.kind}`, { ns: "common" })
              : t("disconnected")}
          </Badge>
        </span>
      }
      parent={{ label: name }}
      className="flex justify-center px-8 py-8"
    >
      <div className="flex w-full max-w-[680px] flex-col gap-4">
        <div className="bg-warning/12 flex items-start gap-3 rounded-[10px] px-3.5 py-3">
          <TriangleAlert
            className="text-warning mt-0.5 size-4 flex-none"
            aria-hidden
          />
          <p className="leading-[19px]">
            <b>{t("warning.title")}</b> {t("warning.body")}{" "}
            {battery ? (
              <Trans
                t={t}
                i18nKey={
                  battery.level >= BATTERY_OK
                    ? "warning.batteryOk"
                    : "warning.batteryLow"
                }
                values={{ level: battery.level }}
                components={{ b: <b className="tabular-nums" /> }}
              />
            ) : (
              t("warning.batteryUnknown")
            )}
          </p>
        </div>

        <div
          className={cn(
            "bg-card flex flex-col gap-3.5 rounded-[10px] border p-[18px] transition-colors",
            dragging && "border-brand bg-brand/15",
          )}
        >
          {pkg ? (
            <PackageRow
              pkg={pkg}
              disabled={running || inspecting}
              onChange={() => void pick()}
            />
          ) : (
            <DropZone busy={inspecting} onPick={() => void pick()} />
          )}

          {job && job.path === pkg?.path ? (
            <JobProgress job={job} />
          ) : (
            <ChecksList checks={checks} />
          )}

          {needsAck && pkg && !job && (
            // biome-ignore lint/a11y/noLabelWithoutControl: Checkbox renders the control
            <label className="text-small flex items-center gap-2">
              <Checkbox checked={ack} onCheckedChange={setAck} />
              {t("checks.batteryAck", { min: BATTERY_OK })}
            </label>
          )}

          <Actions
            job={job?.path === pkg?.path ? job : undefined}
            canStart={canStart}
            onStart={() => setConfirming(true)}
          />
        </div>

        <HowTo device={device} live={live} name={name} />
      </div>

      <ConfirmDialog
        open={confirming}
        name={name}
        phrase={phrase}
        pkg={pkg}
        onClose={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          if (pkg) useSideload.getState().start(serial, pkg);
        }}
      />
    </Page>
  );
}

function toneVariant(device: Device) {
  const tone = deviceTone(device.state);
  return tone === "neutral" ? "default" : tone;
}

function PackageRow({
  pkg,
  disabled,
  onChange,
}: {
  pkg: OtaPackage;
  disabled: boolean;
  onChange: () => void;
}) {
  const { t } = useTranslation("sideload");
  const meta = [
    formatBytes(pkg.sizeBytes),
    pkg.postRelease &&
      t("file.android", {
        version: pkg.postRelease,
        build: pkg.postBuildId ?? "?",
      }),
    pkg.isOta && t(pkg.signed ? "file.signed" : "file.unsigned"),
  ].filter(Boolean);
  return (
    <div className="flex items-center gap-3">
      <span className="bg-selected text-secondary-foreground flex size-10 flex-none items-center justify-center rounded-[9px]">
        <FileArchive className="size-5" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono font-semibold" title={pkg.path}>
          {pkg.name}
        </div>
        <div className="text-small text-muted-foreground truncate">
          {meta.join(" · ")}
        </div>
      </div>
      <Button size="sm" variant="ghost" disabled={disabled} onClick={onChange}>
        {t("file.change")}
      </Button>
    </div>
  );
}

function DropZone({ busy, onPick }: { busy: boolean; onPick: () => void }) {
  const { t } = useTranslation("sideload");
  return (
    <div className="border-input flex flex-col items-center gap-2.5 rounded-lg border border-dashed px-4 py-7 text-center">
      {busy ? (
        <Loader className="text-muted-foreground size-5 animate-spin" />
      ) : (
        <Upload className="text-muted-foreground size-5" aria-hidden />
      )}
      <div className="font-medium">{t("file.drop")}</div>
      <div className="text-small text-muted-foreground">{t("file.hint")}</div>
      <Button size="sm" variant="outline" disabled={busy} onClick={onPick}>
        {t("file.pick")}
      </Button>
    </div>
  );
}

function ChecksList({ checks }: { checks: Check[] }) {
  const { t } = useTranslation("sideload");
  return (
    <ul className="flex flex-col gap-1.5" aria-label={t("checks.label")}>
      {checks.map((c) => (
        <li key={c.id} className="text-small flex items-start gap-2">
          <StatusDot tone={c.tone} className="mt-[5px]" />
          <span
            className={cn(
              c.tone === "error" ? "text-error" : "text-secondary-foreground",
            )}
          >
            {t(c.key, {
              ...c.values,
              state:
                c.values?.state !== undefined &&
                t(`state.${c.values.state}`, { ns: "common" }),
            })}
          </span>
        </li>
      ))}
    </ul>
  );
}

function JobProgress({ job }: { job: SideloadJob }) {
  const { t } = useTranslation("sideload");
  const pct = Math.min(100, Math.round(job.percent));
  const elapsed = (Date.now() - job.startedAt) / 1000;
  // `sideload-host` sends the package about 100/47 times.
  const expected = job.mode === "legacy" ? job.size : (job.size * 100) / 47;
  const rate = elapsed > 2 ? job.transferred / elapsed : 0;
  const eta =
    job.status === "running" && rate > 0
      ? formatEta(Math.max(0, expected - job.transferred) / rate, t)
      : "";
  const label =
    job.status === "running"
      ? t("progress.sending")
      : job.status === "done"
        ? t("progress.done")
        : job.status === "cancelled"
          ? t("progress.cancelled")
          : t("progress.failed");
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <div className="text-small flex items-center justify-between gap-3">
          <span className="flex items-center gap-1.5">
            {job.status === "done" && (
              <CircleCheck className="text-success size-3.5" aria-hidden />
            )}
            {(job.status === "failed" || job.status === "cancelled") && (
              <CircleX className="text-error size-3.5" aria-hidden />
            )}
            {label}{" "}
            {job.status === "running" && (
              <span className="text-muted-foreground tabular-nums">
                (~{pct}%)
              </span>
            )}
          </span>
          <span className="text-muted-foreground tabular-nums">
            {formatBytes(job.transferred)} / {formatBytes(job.size)}
            {eta && ` · ${t("progress.left", { eta })}`}
          </span>
        </div>
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          className="bg-selected h-1.5 overflow-hidden rounded-full"
        >
          <div
            className={cn(
              "h-full rounded-full transition-[width] duration-300",
              job.status === "failed" || job.status === "cancelled"
                ? "bg-error"
                : job.status === "done"
                  ? "bg-success"
                  : "bg-primary",
            )}
            style={{ width: `${job.status === "done" ? 100 : pct}%` }}
          />
        </div>
      </div>
      <div className="bg-sidebar text-caption text-muted-foreground selectable rounded-[7px] border px-2.5 py-2 font-mono leading-[17px] whitespace-pre-wrap">
        {job.status === "running"
          ? `serving: '${job.name}'  (~${pct}%)`
          : job.status === "done"
            ? t("progress.doneLog", {
                ratio: (job.transferred / Math.max(1, job.size)).toFixed(2),
              })
            : job.error}
      </div>
      {job.status === "done" && (
        <p className="text-small text-secondary-foreground">
          {t("progress.doneHint")}
        </p>
      )}
    </div>
  );
}

function Actions({
  job,
  canStart,
  onStart,
}: {
  job: SideloadJob | undefined;
  canStart: boolean;
  onStart: () => void;
}) {
  const { t } = useTranslation("sideload");
  const [confirmCancel, setConfirmCancel] = useState(false);
  const store = useSideload.getState();
  if (job?.status === "running") {
    return (
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={() => setConfirmCancel(true)}>
          {t("cancel.button")}
        </Button>
        <AlertDialog open={confirmCancel} onOpenChange={setConfirmCancel}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("cancel.title")}</AlertDialogTitle>
              <AlertDialogDescription>
                {t("cancel.body")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("cancel.keep")}</AlertDialogCancel>
              <Button
                variant="destructive"
                onClick={() => {
                  setConfirmCancel(false);
                  store.cancel(job.serial);
                }}
              >
                {t("cancel.confirm")}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    );
  }
  return (
    <div className="flex justify-end gap-2">
      {job && (
        <Button variant="ghost" onClick={() => store.dismiss(job.serial)}>
          {t("again")}
        </Button>
      )}
      {!job && (
        <Button disabled={!canStart} onClick={onStart}>
          {t("install")}
        </Button>
      )}
    </div>
  );
}

function HowTo({
  device,
  live,
  name,
}: {
  device: Device;
  live: boolean;
  name: string;
}) {
  const { t } = useTranslation("sideload");
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const kind = device.state.kind;
  const reboot = async () => {
    setBusy(true);
    try {
      await rebootDevice(device.serial, "sideload");
      toast.info(t("howto.rebooting", { name }));
      setConfirm(false);
    } catch (error) {
      toast.error(t("howto.rebootFailed"), { description: errorText(error) });
    } finally {
      setBusy(false);
    }
  };
  const step = (n: number, content: ReactNode, done: boolean) => (
    <li className={cn(done && "text-muted-foreground line-through")}>
      <span className="sr-only">{n}. </span>
      {content}
    </li>
  );
  return (
    <div className="bg-card flex flex-col gap-1.5 rounded-[10px] border px-[18px] py-3.5">
      <div className="font-semibold">{t("howto.title")}</div>
      <ol className="text-small text-secondary-foreground list-decimal pl-[18px] leading-5">
        {step(
          1,
          <>
            {t("howto.step1")}
            {live && kind === "device" && (
              <Button
                size="xs"
                variant="outline"
                className="ml-2 align-middle"
                onClick={() => setConfirm(true)}
              >
                {t("howto.reboot")}
              </Button>
            )}
          </>,
          live && (kind === "recovery" || kind === "sideload"),
        )}
        {step(
          2,
          <Trans t={t} i18nKey="howto.step2" components={{ b: <b /> }} />,
          live && kind === "sideload",
        )}
        {step(3, t("howto.step3"), false)}
      </ol>
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("howto.confirmTitle", { name })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("howto.confirmBody")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:actions.cancel")}</AlertDialogCancel>
            <Button disabled={busy} onClick={() => void reboot()}>
              {t("howto.reboot")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** "Type the codename to continue" before flashing. */
function ConfirmDialog({
  open,
  name,
  phrase,
  pkg,
  onClose,
  onConfirm,
}: {
  open: boolean;
  name: string;
  phrase: string;
  pkg: OtaPackage | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation("sideload");
  const [typed, setTyped] = useState("");
  useEffect(() => {
    if (open) setTyped("");
  }, [open]);
  const ok = typed.trim() === phrase;
  return (
    <AlertDialog open={open} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("confirm.title", { name })}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("confirm.body", { file: pkg?.name ?? "" })}
            {pkg?.wipe && ` ${t("confirm.wipe")}`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <form
          className="flex flex-col gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (ok) onConfirm();
          }}
        >
          <label htmlFor="sideload-confirm" className="text-small">
            <Trans
              t={t}
              i18nKey="confirm.type"
              values={{ phrase }}
              components={{
                code: <code className="font-mono font-semibold" />,
              }}
            />
          </label>
          <Input
            id="sideload-confirm"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
        </form>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common:actions.cancel")}</AlertDialogCancel>
          <Button variant="destructive" disabled={!ok} onClick={onConfirm}>
            {t("confirm.button")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
