import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useQuery } from "@tanstack/react-query";
import { cn } from "cn";
import {
  AlertTriangle,
  Check,
  Cpu,
  FileWarning,
  Smartphone,
  Wifi,
  X,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { deviceName } from "@/features/devices/naming";
import { useDeviceInfo } from "@/features/devices/queries";
import { useDevices } from "@/features/devices/store";
import type { Device } from "@/lib/tauri";
import {
  type InstallOptions,
  installedVersion,
  type PackageFile,
  uninstallApp,
} from "../api";
import { AppIcon } from "../components/AppIcon";
import { formatBytes, formatDuration } from "../format";
import { derivedName } from "../naming";
import { errorMessage } from "../queries";
import { describeFailure } from "./errors";
import { type DeviceRow, rowOf, summarize, useInstall } from "./installStore";

/** Install APK dialog (docs/design/project/Apps-Install.dc.html). */
export function InstallDialog() {
  const { t } = useTranslation("apps");
  const open = useInstall((s) => s.open);
  const close = useInstall((s) => s.close);
  const file = useInstall((s) => s.file);
  const fileError = useInstall((s) => s.fileError);
  const path = useInstall((s) => s.path);
  const devices = useDevices((s) => s.devices);
  const selected = useInstall((s) => s.selected);
  const rows = useInstall((s) => s.rows);
  const start = useInstall((s) => s.start);

  const summary = summarize(rows, selected);
  const started = Object.values(rows).some((r) => r.status !== "idle");
  const busy = summary.running + summary.waiting > 0;
  const finished = started && !busy;
  const pending = selected.filter((s) => rowOf(rows, s).status === "idle");

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => !o && close()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 fixed inset-0 z-50 bg-black/55 duration-150" />
        <DialogPrimitive.Popup className="bg-popover text-popover-foreground ring-input data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 fixed top-1/2 left-1/2 z-50 flex max-h-[min(820px,calc(100vh-48px))] w-[600px] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl shadow-lg ring-1 duration-200 outline-none">
          <Header file={file} error={fileError} path={path} />
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="px-5">
              <div className="text-caption text-muted-foreground mb-2 font-semibold tracking-[.05em] uppercase">
                {t("install.installOn")}
              </div>
            </div>
            <div className="mx-5 overflow-hidden rounded-[10px] border">
              {devices.length === 0 && (
                <div className="text-muted-foreground px-3.5 py-3">
                  {t("install.noDevices")}
                </div>
              )}
              {devices.map((device, i) => (
                <DeviceLine
                  key={device.serial}
                  device={device}
                  file={file}
                  first={i === 0}
                  locked={busy}
                />
              ))}
            </div>
            <Options file={file} locked={busy} />
          </div>
          <div className="mt-[18px] flex flex-none items-center justify-between gap-3 border-t px-5 py-[18px]">
            <span className="text-small text-muted-foreground tabular-nums">
              {started
                ? t("install.summary", {
                    done: summary.done,
                    total: summary.total,
                    running: summary.running,
                    waiting: summary.waiting,
                  })
                : t("install.selectedCount", { count: selected.length })}
            </span>
            <span className="flex items-center gap-2">
              {busy ? (
                <>
                  <Button variant="ghost" onClick={close}>
                    {t("install.runInBackground")}
                  </Button>
                  <Button disabled>{t("install.installing")}</Button>
                </>
              ) : finished && pending.length === 0 ? (
                <Button onClick={close}>{t("install.done")}</Button>
              ) : (
                <>
                  <Button variant="ghost" onClick={close}>
                    {t("common:actions.cancel")}
                  </Button>
                  <Button
                    disabled={!file || pending.length === 0}
                    onClick={() => start(pending)}
                  >
                    {t("install.installOnCount", { count: pending.length })}
                  </Button>
                </>
              )}
            </span>
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function signingLabel(file: PackageFile, t: (k: string) => string) {
  const s = file.signing;
  const schemes = [s.v1 && "v1", s.v2 && "v2", (s.v3 || s.v31) && "v3"].filter(
    Boolean,
  );
  if (schemes.length === 0) return null;
  return `${t("install.signed")} · ${schemes.join("+")}`;
}

function Header({
  file,
  error,
  path,
}: {
  file: PackageFile | null;
  error: string | null;
  path: string | null;
}) {
  const { t } = useTranslation("apps");
  const fileName = path?.split(/[\\/]/).pop() ?? "";
  const name = file ? (file.label ?? derivedName(file.package)) : fileName;
  const signed = file ? signingLabel(file, t) : null;

  return (
    <div className="flex items-start gap-3.5 px-5 pt-5 pb-3.5">
      {file ? (
        <AppIcon pkg={file.package} name={name} icon={file.icon} size="md" />
      ) : error ? (
        <span className="bg-error/13 text-error flex size-11 flex-none items-center justify-center rounded-[10px]">
          <FileWarning className="size-5" aria-hidden />
        </span>
      ) : (
        <Skeleton className="size-11 rounded-[10px]" />
      )}
      <div className="min-w-0 flex-1">
        <DialogPrimitive.Title className="truncate text-[16px] leading-6 font-semibold">
          {file
            ? t("install.title", { name, version: file.versionName ?? "" })
            : error
              ? t("install.unreadable")
              : t("install.reading")}
        </DialogPrimitive.Title>
        <div className="text-muted-foreground mt-0.5 truncate font-mono text-[12px]">
          {fileName}
          {file && ` · ${formatBytes(file.fileSize)}`}
        </div>
        {error && <div className="text-error text-small mt-2">{error}</div>}
        {file && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Badge className="font-mono">{file.package}</Badge>
            <Badge className="font-mono">versionCode {file.versionCode}</Badge>
            {file.minSdk !== null && (
              <Badge>
                {t("install.sdk", {
                  min: file.minSdk,
                  target: file.targetSdk ?? "—",
                })}
              </Badge>
            )}
            {signed ? (
              <Badge variant="success">{signed}</Badge>
            ) : (
              <Badge variant="error">{t("install.unsigned")}</Badge>
            )}
            {file.parts.length > 1 && (
              <Badge>
                {t("install.apkCount", { count: file.parts.length })}
              </Badge>
            )}
            {file.obbs.length > 0 && (
              <Badge>
                {t("install.obbCount", { count: file.obbs.length })}
              </Badge>
            )}
            {file.debuggable && <Badge variant="info">debuggable</Badge>}
            {file.testOnly && <Badge variant="warning">test-only</Badge>}
          </div>
        )}
      </div>
      <DialogPrimitive.Close
        render={<Button variant="ghost" size="icon-sm" />}
        aria-label={t("common:actions.close")}
      >
        <X />
      </DialogPrimitive.Close>
    </div>
  );
}

function DeviceGlyph({ device }: { device: Device }) {
  const Icon =
    device.transport === "emulator"
      ? Cpu
      : device.transport === "wifi"
        ? Wifi
        : Smartphone;
  return <Icon className="text-secondary-foreground size-4" aria-hidden />;
}

function DeviceLine({
  device,
  file,
  first,
  locked,
}: {
  device: Device;
  file: PackageFile | null;
  first: boolean;
  locked: boolean;
}) {
  const { t } = useTranslation("apps");
  const { t: tc } = useTranslation();
  const ready = device.state.kind === "device";
  const info = useDeviceInfo(ready ? device.serial : null);
  const name = deviceName(device, info.data);
  const selected = useInstall((s) => s.selected.includes(device.serial));
  const toggle = useInstall((s) => s.toggle);
  const row = useInstall((s) => rowOf(s.rows, device.serial));

  const installed = useQuery({
    queryKey: [
      "installed",
      device.serial,
      file?.package,
      row.status === "done",
    ],
    queryFn: () =>
      installedVersion({ serial: device.serial, package: file?.package ?? "" }),
    enabled: ready && file !== null,
  });

  let sub: string;
  if (!ready) {
    sub = tc(`state.${device.state.kind}`);
  } else if (!file || installed.isPending) {
    sub = t("install.checking");
  } else if (!installed.data) {
    sub = t("install.notInstalled");
  } else {
    const v = installed.data;
    const verb =
      v.versionCode < file.versionCode
        ? "upgrade"
        : v.versionCode > file.versionCode
          ? "downgrade"
          : "reinstall";
    sub = t(`install.installed.${verb}`, {
      version: v.versionName ?? v.versionCode,
    });
  }

  const failure =
    row.status === "failed" && row.error ? describeFailure(row.error) : null;

  if (failure && row.error) {
    return (
      <div
        className={cn(
          "grid grid-cols-[16px_20px_minmax(0,1fr)] items-start gap-2.5 px-3.5 py-2.5",
          !first && "border-t",
          failure.decision ? "bg-warning/12" : "bg-error/13",
        )}
      >
        <Checkbox checked disabled className="mt-0.5" aria-label={name} />
        <span className="mt-0.5">
          <DeviceGlyph device={device} />
        </span>
        <FailureBody
          serial={device.serial}
          name={name}
          pkg={file?.package ?? ""}
          row={row}
          installed={installed.data ?? null}
        />
      </div>
    );
  }

  return (
    <div
      className={cn(
        "grid grid-cols-[16px_20px_minmax(0,1fr)_170px] items-center gap-2.5 px-3.5 py-2.5",
        !first && "border-t",
        !ready && "opacity-55",
      )}
    >
      <Checkbox
        checked={ready && selected}
        disabled={!ready || locked}
        onCheckedChange={(v) => toggle(device.serial, v)}
        aria-label={name}
      />
      <DeviceGlyph device={device} />
      <div className="min-w-0">
        <div className="truncate font-medium">{name}</div>
        <div className="text-caption text-muted-foreground truncate">{sub}</div>
      </div>
      <RowStatus row={row} />
    </div>
  );
}

function RowStatus({ row }: { row: DeviceRow }) {
  const { t } = useTranslation("apps");
  switch (row.status) {
    case "idle":
      return <span />;
    case "waiting":
      return (
        <span className="text-small text-muted-foreground text-right">
          {t("install.waiting")}
        </span>
      );
    case "installing": {
      const pct = row.total > 0 ? Math.round((row.sent / row.total) * 100) : 0;
      const label =
        row.stage === "committing"
          ? t("install.stage.committing")
          : row.stage === "launching"
            ? t("install.stage.launching")
            : row.stage === "preparing"
              ? t("install.stage.preparing")
              : t("install.stage.uploading");
      return (
        <span className="flex flex-col gap-1">
          <span className="text-caption text-muted-foreground flex justify-between tabular-nums">
            <span>{label}</span>
            {row.stage === "uploading" && <span>{pct}%</span>}
          </span>
          <span className="bg-selected block h-1 overflow-hidden rounded-full">
            <span
              className={cn(
                "bg-primary block h-full rounded-full transition-[width] duration-200",
                row.stage !== "uploading" && "animate-pulse",
              )}
              style={{ width: `${row.stage === "uploading" ? pct : 100}%` }}
            />
          </span>
        </span>
      );
    }
    case "done":
      return (
        <span className="text-success text-small flex items-center justify-end gap-1.5">
          <Check className="size-3.5" aria-hidden />
          {t("install.installedIn", {
            time: formatDuration(row.elapsedMs ?? 0),
          })}
        </span>
      );
    case "cancelled":
      return (
        <span className="text-small text-muted-foreground text-right">
          {t("install.skipped")}
        </span>
      );
    case "failed":
      return null;
  }
}

function FailureBody({
  serial,
  name,
  pkg,
  row,
  installed,
}: {
  serial: string;
  name: string;
  pkg: string;
  row: DeviceRow;
  installed: { versionName: string | null; versionCode: number } | null;
}) {
  const { t } = useTranslation("apps");
  const start = useInstall((s) => s.start);
  const skip = useInstall((s) => s.skip);
  const file = useInstall((s) => s.file);
  const [confirmUninstall, setConfirmUninstall] = useState(false);
  const [busy, setBusy] = useState(false);
  const [extraError, setExtraError] = useState<string | null>(null);
  const error = row.error;
  if (!error) return null;
  const info = describeFailure(error);

  const message = info.key
    ? t(`installErrors.${info.key}`, {
        version: installed?.versionName ?? "?",
        code: installed?.versionCode ?? "?",
        detail: error.message,
      })
    : error.message;

  const act = async () => {
    const action = info.action;
    if (!action) return;
    if (action.kind === "retry") {
      start([serial], action.overrides);
      return;
    }
    if (!confirmUninstall) {
      setConfirmUninstall(true);
      return;
    }
    setBusy(true);
    try {
      await uninstallApp({
        serial,
        package: pkg,
        keepData: false,
        system: false,
      });
      start([serial]);
    } catch (e) {
      setExtraError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-medium">{name}</span>
        <span
          className={cn(
            "text-small flex flex-none items-center gap-1.5",
            info.decision ? "text-warning" : "text-error",
          )}
        >
          <AlertTriangle className="size-3.5" aria-hidden />
          {info.decision ? t("install.needsDecision") : t("install.failed")}
        </span>
      </div>
      <div className="text-small mt-1 leading-[18px]">{message}</div>
      {extraError && (
        <div className="text-error text-small mt-1">{extraError}</div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {info.action && (
          <Button
            size="sm"
            variant={
              info.action.kind === "uninstallFirst" && confirmUninstall
                ? "destructive"
                : "outline"
            }
            disabled={busy || !file}
            onClick={() => void act()}
          >
            {confirmUninstall
              ? t("install.actions.confirmUninstallFirst")
              : t(`install.actions.${info.action.label}`)}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => skip(serial)}>
          {t("install.skip")}
        </Button>
      </div>
      {error.raw && (
        <details className="mt-1.5">
          <summary className="text-small text-muted-foreground cursor-pointer">
            {t("install.details")}
          </summary>
          <pre className="selectable text-muted-foreground mt-1 font-mono text-[11px] leading-4 whitespace-pre-wrap">
            {error.raw}
          </pre>
        </details>
      )}
    </div>
  );
}

function Options({
  file,
  locked,
}: {
  file: PackageFile | null;
  locked: boolean;
}) {
  const { t } = useTranslation("apps");
  const options = useInstall((s) => s.options);
  const setOption = useInstall((s) => s.setOption);
  const items: { key: keyof InstallOptions; flag?: string; show: boolean }[] = [
    { key: "reinstall", flag: "-r", show: true },
    { key: "downgrade", flag: "-d", show: true },
    { key: "grantAll", flag: "-g", show: true },
    { key: "testOnly", flag: "-t", show: file?.testOnly ?? false },
    { key: "launch", show: true },
  ];
  return (
    <div className="flex flex-col gap-2.5 px-5 pt-4">
      <div className="text-caption text-muted-foreground font-semibold tracking-[.05em] uppercase">
        {t("install.options")}
      </div>
      {items
        .filter((i) => i.show)
        .map((item) => (
          // biome-ignore lint/a11y/noLabelWithoutControl: Checkbox renders the control
          <label
            key={item.key}
            className="flex cursor-pointer items-start gap-2.5"
          >
            <Checkbox
              className="mt-0.5"
              checked={options[item.key]}
              disabled={locked}
              onCheckedChange={(v) => setOption(item.key, v)}
            />
            <span>
              {t(`install.option.${item.key}`)}
              {item.flag && (
                <span className="text-muted-foreground ml-1 font-mono">
                  {item.flag}
                </span>
              )}
            </span>
          </label>
        ))}
    </div>
  );
}
