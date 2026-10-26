import { Check, Loader, MonitorSmartphone } from "lucide-react";
import { type PointerEvent, useRef } from "react";
import { useTranslation } from "react-i18next";

import { useNavigation } from "@/app/navigation";
import { deviceTone, StatusDot } from "@/components/status/StatusDot";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useInstall } from "@/features/apps/install/installStore";
import { useDeviceName } from "@/features/devices/naming";
import { useDeviceInfo } from "@/features/devices/queries";
import { useDevices } from "@/features/devices/store";
import { sendGesture } from "@/features/multi-device/input";
import { type TileStatus, useMulti } from "@/features/multi-device/store";
import { useThumbnail } from "@/features/multi-device/useThumbnail";
import type { Device } from "@/lib/tauri";
import { cn } from "@/lib/utils";

/** Moves shorter than this (fraction of the screen) are taps. */
const SWIPE_MIN = 0.03;

const TONE_TEXT: Record<TileStatus["tone"], string> = {
  success: "text-success",
  warning: "text-warning",
  error: "text-error",
  info: "text-secondary-foreground",
};

/** One device in the grid: live screen, name, and the last action's result. */
export function DeviceTile({ device }: { device: Device }) {
  const { t } = useTranslation("multi-device");
  const ready = device.state.kind === "device";
  const serial = ready ? device.serial : null;
  const { data: info } = useDeviceInfo(serial);
  const name = useDeviceName(device, info) ?? device.serial;
  const included = useMulti((s) => !s.excluded.includes(device.serial));
  const setIncluded = useMulti((s) => s.setIncluded);
  const screen = useMulti((s) => s.screens[device.serial]);
  const status = useMulti((s) => s.status[device.serial]);
  const frame = useRef<HTMLDivElement>(null);
  const { src, error } = useThumbnail(serial, frame);
  const navigate = useNavigation((s) => s.navigate);
  const down = useRef<{ fx: number; fy: number } | null>(null);

  const point = (e: PointerEvent<HTMLElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return {
      fx: (e.clientX - rect.left) / rect.width,
      fy: (e.clientY - rect.top) / rect.height,
    };
  };
  const onUp = (e: PointerEvent<HTMLButtonElement>) => {
    const from = down.current;
    down.current = null;
    if (!from || !serial) return;
    const to = point(e);
    const moved = Math.hypot(to.fx - from.fx, to.fy - from.fy) > SWIPE_MIN;
    void sendGesture(serial, from, moved ? to : undefined);
  };

  const aspect = screen ? `${screen.width} / ${screen.height}` : "9 / 19.5";

  return (
    <div
      className={cn(
        "bg-card flex min-w-0 flex-col gap-2 rounded-xl border p-2.5 transition-[opacity,border-color]",
        !ready && "opacity-55",
        ready && !included && "opacity-70",
        ready && included && "border-input",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 font-semibold">
          {ready && (
            <Checkbox
              aria-label={t("tile.include", { name })}
              checked={included}
              onCheckedChange={(on) => setIncluded(device.serial, on)}
            />
          )}
          <StatusDot tone={deviceTone(device.state)} />
          <span className="truncate" title={device.serial}>
            {name}
          </span>
        </span>
        {screen && (
          <span className="text-caption text-muted-foreground flex-none font-mono tabular-nums">
            {screen.width}×{screen.height}
          </span>
        )}
      </div>

      <div
        ref={frame}
        className="relative mx-auto w-full rounded-[14px] bg-black p-1"
        style={{ aspectRatio: aspect }}
      >
        {ready && src ? (
          <button
            type="button"
            aria-label={t("tile.tap", { name })}
            className="focus-visible:outline-ring block h-full w-full cursor-crosshair touch-none overflow-hidden rounded-[10px] outline-offset-2 focus-visible:outline-2"
            onPointerDown={(e) => {
              if (e.button === 0) down.current = point(e);
            }}
            onPointerUp={onUp}
            onPointerLeave={() => {
              down.current = null;
            }}
            onDoubleClick={() => {
              useDevices.getState().select(device.serial);
              navigate("screen");
            }}
          >
            <img
              src={src}
              alt={t("tile.screen", { name })}
              draggable={false}
              className="h-full w-full object-cover select-none"
            />
          </button>
        ) : (
          <div className="bg-popover text-muted-foreground text-caption flex h-full w-full flex-col items-center justify-center gap-2 rounded-[10px] p-2.5 text-center">
            {ready ? (
              error ? (
                <span className="text-error line-clamp-4">{error}</span>
              ) : (
                <Loader className="size-4 animate-spin" />
              )
            ) : (
              t(`state.${device.state.kind}`, { ns: "common" })
            )}
          </div>
        )}
      </div>

      <div className="text-small text-muted-foreground flex min-h-5 items-center justify-between gap-2">
        <span className="truncate">
          {ready
            ? info?.androidVersion
              ? t("android", { version: info.androidVersion, ns: "common" })
              : "—"
            : t("tile.skipped")}
        </span>
        {ready && <TileResult serial={device.serial} status={status} />}
        {ready && !status && (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={t("tile.mirror", { name })}
            title={t("tile.mirror", { name })}
            onClick={() => {
              useDevices.getState().select(device.serial);
              navigate("screen");
            }}
          >
            <MonitorSmartphone />
          </Button>
        )}
      </div>
      {status?.detail && (
        <pre className="bg-sidebar text-caption selectable max-h-24 overflow-auto rounded-md border px-2 py-1.5 font-mono whitespace-pre-wrap">
          {status.detail}
        </pre>
      )}
    </div>
  );
}

/** Install progress wins over other statuses while it runs. */
function TileResult({
  serial,
  status,
}: {
  serial: string;
  status: TileStatus | undefined;
}) {
  const { t } = useTranslation("multi-device");
  const row = useInstall((s) => s.rows[serial]);
  const version = useInstall((s) => s.file?.versionName);
  if (row && row.status !== "idle") {
    if (row.status === "waiting" || row.status === "installing") {
      const pct = row.total > 0 ? (row.sent / row.total) * 100 : 0;
      return (
        <span
          role="progressbar"
          aria-label={t("tile.installing")}
          aria-valuenow={Math.round(pct)}
          className="bg-selected block h-1 w-[70px] flex-none overflow-hidden rounded-full"
        >
          <span
            className="bg-primary block h-full rounded-full transition-[width]"
            style={{ width: `${pct}%` }}
          />
        </span>
      );
    }
    if (row.status === "done")
      return (
        <span className="text-success flex min-w-0 items-center gap-1">
          <Check className="size-3 flex-none" aria-hidden />
          <span className="truncate">{version ?? t("tile.installed")}</span>
        </span>
      );
    return (
      <span
        className="text-warning truncate"
        title={row.error?.message ?? undefined}
      >
        {row.status === "cancelled"
          ? t("tile.cancelled")
          : (row.error?.code ?? t("tile.failed"))}
      </span>
    );
  }
  if (!status) return null;
  return (
    <span
      className={cn("flex min-w-0 items-center gap-1", TONE_TEXT[status.tone])}
      title={status.text}
    >
      {status.busy && <Loader className="size-3 flex-none animate-spin" />}
      <span className="truncate">{status.text}</span>
    </span>
  );
}
