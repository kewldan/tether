import { openUrl } from "@tauri-apps/plugin-opener";
import { cn } from "cn";
import {
  Cpu,
  Ellipsis,
  LifeBuoy,
  Pencil,
  Power,
  RefreshCw,
  ShieldAlert,
  Smartphone,
  Trash2,
  Unplug,
  WifiOff,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { useNavigation } from "@/app/navigation";
import type { SectionId } from "@/app/sections";
import {
  deviceTone,
  StatusDot,
  type Tone,
} from "@/components/status/StatusDot";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  connectWifi,
  disconnectWifi,
  type RebootMode,
  rebootDevice,
  reconnectDevice,
} from "@/features/devices/api";
import {
  DEVICE_SETUP_URL,
  RevokeDialog,
  UdevDialog,
} from "@/features/devices/dialogs";
import {
  isAddressSerial,
  useKnownDevices,
  type WifiEntry,
} from "@/features/devices/known";
import { useDeviceName } from "@/features/devices/naming";
import { useDeviceInfo, useDeviceSummary } from "@/features/devices/queries";
import { useDevices } from "@/features/devices/store";
import { stopReconnecting } from "@/features/devices/useAutoReconnect";
import type { AppError, Device } from "@/lib/tauri";

const TILE: Record<Tone, string> = {
  success: "bg-selected text-secondary-foreground",
  neutral: "bg-selected text-secondary-foreground",
  warning: "bg-warning/12 text-warning",
  error: "bg-error/13 text-error",
  info: "bg-info/13 text-info",
};

const BADGE: Record<
  Tone,
  "success" | "warning" | "error" | "info" | "default"
> = {
  success: "success",
  warning: "warning",
  error: "error",
  info: "info",
  neutral: "default",
};

export function stateLabel(device: Device): string {
  return device.state.kind === "unknown"
    ? device.state.raw
    : device.state.kind.replace("_", " ");
}

function fail(t: (k: string) => string) {
  return (e: AppError) =>
    toast.error(t("card.failed"), { description: e.message });
}

export function relativeAgo(
  ms: number,
  t: (k: string, o?: Record<string, unknown>) => string,
) {
  const mins = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  if (mins < 1) return t("card.justNow");
  if (mins < 60) return t("card.minAgo", { count: mins });
  const hours = Math.round(mins / 60);
  if (hours < 48) return t("card.hoursAgo", { count: hours });
  return t("card.daysAgo", { count: Math.round(hours / 24) });
}

/** Actions shared by the grid card and the list row. */
export function useDeviceActions(device: Device) {
  const { t } = useTranslation("devices");
  const navigate = useNavigation((s) => s.navigate);
  const open = (section: SectionId) => {
    useDevices.getState().select(device.serial);
    navigate(section);
  };
  const reboot = (mode: RebootMode) =>
    rebootDevice(device.serial, mode)
      .then(() => toast(t("card.rebooting", { mode: t(`reboot.${mode}`) })))
      .catch(fail(t));
  const disconnect = () => {
    stopReconnecting(device.serial);
    disconnectWifi(device.serial).catch(fail(t));
  };
  const forget = () => {
    const entry = useKnownDevices.getState().wifi[device.serial];
    stopReconnecting(device.serial);
    useKnownDevices.getState().forgetWifi(device.serial);
    useKnownDevices.getState().setAlias(device.serial, null);
    disconnectWifi(device.serial).catch(() => undefined);
    toast(t("card.forgotten"), {
      action: entry
        ? {
            label: t("card.undo"),
            onClick: () =>
              useKnownDevices
                .getState()
                .rememberWifi(entry.address, entry.name),
          }
        : undefined,
    });
  };
  return { open, reboot, disconnect, forget };
}

export function MoreMenu({
  device,
  onRename,
}: {
  device: Device;
  onRename: () => void;
}) {
  const { t } = useTranslation("devices");
  const { reboot, disconnect, forget } = useDeviceActions(device);
  const wifi = device.transport === "wifi";
  const ready = device.state.kind === "device";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="icon-sm" aria-label={t("card.more")} />
        }
      >
        <Ellipsis />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[200px]">
        {ready && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Power />
              {t("card.reboot")}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {(["system", "recovery", "bootloader"] as const).map((m) => (
                <DropdownMenuItem key={m} onClick={() => void reboot(m)}>
                  {t(`reboot.${m}`)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
        <DropdownMenuItem onClick={onRename}>
          <Pencil />
          {t("card.rename")}
        </DropdownMenuItem>
        {wifi && (
          <DropdownMenuItem onClick={disconnect}>
            <Unplug />
            {t("card.disconnect")}
          </DropdownMenuItem>
        )}
        {wifi && <DropdownMenuSeparator />}
        {wifi && (
          <DropdownMenuItem variant="destructive" onClick={forget}>
            <Trash2 />
            {t("card.forget")}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function KeyValue({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <span className="text-caption text-muted-foreground block">{label}</span>
      <span className="block truncate">{children}</span>
    </div>
  );
}

function Shell({
  tone,
  icon,
  title,
  subtitle,
  badge,
  selection,
  highlighted,
  children,
}: {
  tone: Tone;
  icon: ReactNode;
  title: ReactNode;
  subtitle: ReactNode;
  badge: ReactNode;
  selection?: ReactNode;
  highlighted?: "brand" | "warning";
  children: ReactNode;
}) {
  return (
    <article
      className={cn(
        "bg-card flex min-w-0 flex-col gap-3.5 rounded-[10px] border p-4 transition-[border-color,box-shadow]",
        highlighted === "brand" && "border-brand ring-brand ring-1",
        highlighted === "warning" && "border-warning",
      )}
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex w-4 flex-none">{selection}</span>
        <span
          aria-hidden
          className={cn(
            "flex size-10 flex-none items-center justify-center rounded-[9px]",
            TILE[tone],
          )}
        >
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-semibold">{title}</div>
          <div className="text-small text-muted-foreground truncate">
            {subtitle}
          </div>
        </div>
        {badge}
      </div>
      {children}
    </article>
  );
}

export function StateBadge({ device, tone }: { device: Device; tone?: Tone }) {
  const tn = tone ?? deviceTone(device.state);
  return (
    <Badge variant={BADGE[tn]}>
      <StatusDot tone={tn} />
      {stateLabel(device)}
    </Badge>
  );
}

/** One card of the All devices grid, by device state. */
export function DeviceCard({
  device,
  selected,
  onToggle,
  onRename,
}: {
  device: Device;
  selected: boolean;
  onToggle: (on: boolean) => void;
  onRename: () => void;
}) {
  const { t } = useTranslation("devices");
  const kind = device.state.kind;
  const ready = kind === "device";
  const { data: info } = useDeviceInfo(ready ? device.serial : null);
  const { data: summary } = useDeviceSummary(ready ? device.serial : null);
  const name = useDeviceName(device, info) ?? device.serial;
  const alias = useKnownDevices((s) => s.aliases[device.serial]);
  const { open, reboot } = useDeviceActions(device);
  const [dialog, setDialog] = useState<"udev" | "revoke" | null>(null);
  const tone = deviceTone(device.state);
  const maker =
    device.transport === "emulator"
      ? t("transport.emulator", { ns: "common" })
      : info?.manufacturer
        ? info.manufacturer.charAt(0).toUpperCase() + info.manufacturer.slice(1)
        : null;
  const title = (
    <>
      {name}
      {alias && info?.model && alias !== info.model && (
        <span className="text-muted-foreground font-normal">
          {" "}
          ({info.model})
        </span>
      )}
    </>
  );
  const subtitle = (
    <>
      {maker && `${maker} · `}
      <span className="font-mono">{device.serial}</span>
    </>
  );
  const icon =
    device.transport === "emulator" ? (
      <Cpu className="size-5" />
    ) : kind === "no_permissions" || kind === "unauthorized" ? (
      <ShieldAlert className="size-5" />
    ) : kind === "offline" ? (
      <WifiOff className="size-5" />
    ) : ["recovery", "rescue", "sideload", "bootloader"].includes(kind) ? (
      <LifeBuoy className="size-5" />
    ) : (
      <Smartphone className="size-5" />
    );
  const checkbox = (
    <Checkbox
      aria-label={t("card.select", { name })}
      checked={selected}
      disabled={!ready}
      onCheckedChange={onToggle}
    />
  );

  if (ready) {
    return (
      <Shell
        tone={tone}
        icon={icon}
        title={title}
        subtitle={subtitle}
        badge={<StateBadge device={device} />}
        selection={checkbox}
        highlighted={selected ? "brand" : undefined}
      >
        <div className="text-small grid grid-cols-3 gap-2">
          <KeyValue label={t("card.android")}>
            {info?.androidVersion
              ? `${info.androidVersion}${info.sdk ? ` · SDK ${info.sdk}` : ""}`
              : "—"}
          </KeyValue>
          <KeyValue label={t("card.transport")}>
            {device.transport === "wifi" ? (
              <span className="text-caption font-mono">{device.serial}</span>
            ) : (
              t(`transport.${device.transport}`, { ns: "common" })
            )}
          </KeyValue>
          {summary?.root ? (
            <KeyValue label={t("card.root")}>
              <Badge variant="brand" className="h-[18px]">
                root
              </Badge>
            </KeyValue>
          ) : (
            <KeyValue label={t("card.battery")}>
              <span className="tabular-nums">
                {summary?.battery != null
                  ? `${summary.battery}%${summary.charging ? ` ⚡ ${t("card.charging")}` : ""}`
                  : "—"}
              </span>
            </KeyValue>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => open("screen")}>
            {t("card.screen")}
          </Button>
          <Button size="sm" variant="outline" onClick={() => open("shell")}>
            {t("card.shell")}
          </Button>
          <Button size="sm" variant="outline" onClick={() => open("files")}>
            {t("card.files")}
          </Button>
          <span className="ml-auto">
            <MoreMenu device={device} onRename={onRename} />
          </span>
        </div>
      </Shell>
    );
  }

  if (kind === "unauthorized" || kind === "authorizing") {
    return (
      <Shell
        tone={tone}
        icon={icon}
        title={title}
        subtitle={subtitle}
        badge={<StateBadge device={device} />}
        selection={checkbox}
        highlighted="warning"
      >
        <div className="bg-sidebar flex items-center gap-3.5 rounded-md p-2.5">
          <PromptArt />
          <div className="text-small leading-[18px]">
            <div className="text-body font-semibold">
              {t("card.confirm.title")}
            </div>
            <div className="text-secondary-foreground">
              {t("card.confirm.text")}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => reconnectDevice(device.serial).catch(fail(t))}
          >
            <RefreshCw />
            {t("card.retry")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setDialog("revoke")}>
            {t("card.revoke")}
          </Button>
        </div>
        <RevokeDialog
          open={dialog === "revoke"}
          onClose={() => setDialog(null)}
          onRetry={() => reconnectDevice(device.serial).catch(fail(t))}
        />
      </Shell>
    );
  }

  if (kind === "no_permissions") {
    return (
      <Shell
        tone={tone}
        icon={icon}
        title={t("card.unknown")}
        subtitle={<span className="font-mono">{device.serial}</span>}
        badge={<StateBadge device={device} />}
      >
        <div className="text-small text-secondary-foreground">
          {t("card.noPermissions")}
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setDialog("udev")}>
            {t("card.udev")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void openUrl(DEVICE_SETUP_URL)}
          >
            {t("learnMore")}
          </Button>
        </div>
        <UdevDialog open={dialog === "udev"} onClose={() => setDialog(null)} />
      </Shell>
    );
  }

  if (["recovery", "rescue", "sideload", "bootloader"].includes(kind)) {
    return (
      <Shell
        tone={tone}
        icon={icon}
        title={title}
        subtitle={<span className="font-mono">{device.serial}</span>}
        badge={<StateBadge device={device} />}
      >
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => void reboot("system")}
          >
            {t("card.rebootSystem")}
          </Button>
          {kind !== "recovery" && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void reboot("recovery")}
            >
              {t("reboot.recovery")}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void reboot("bootloader")}
          >
            {t("reboot.bootloader")}
          </Button>
        </div>
      </Shell>
    );
  }

  // offline, connecting, host, unknown
  return (
    <OfflineCard
      serial={device.serial}
      name={name}
      device={device}
      since={useDevices.getState().lastSeen[device.serial] ?? null}
    />
  );
}

/** Offline device or a remembered Wi-Fi address that is not connected. */
export function OfflineCard({
  serial,
  name,
  device,
  since,
}: {
  serial: string;
  name: string;
  device: Device | null;
  since: number | null;
}) {
  const { t } = useTranslation("devices");
  const navigate = useNavigation((s) => s.navigate);
  const [busy, setBusy] = useState(false);
  const fake: Device = device ?? {
    serial,
    state: { kind: "offline" },
    transport: "wifi",
    model: null,
    product: null,
    device: null,
    transportId: null,
  };
  const { forget } = useDeviceActions(fake);
  const connecting = fake.state.kind === "connecting";
  const reconnect = () => {
    setBusy(true);
    const run = isAddressSerial(serial)
      ? connectWifi(serial)
      : reconnectDevice(serial);
    run.catch(fail(t)).finally(() => setBusy(false));
  };
  return (
    <Shell
      tone={connecting ? "info" : "error"}
      icon={<WifiOff className="size-5" />}
      title={
        <>
          {name}
          {since && (
            <span className="text-muted-foreground font-normal">
              {" "}
              · {t("card.lastSeen", { ago: relativeAgo(since, t) })}
            </span>
          )}
        </>
      }
      subtitle={<span className="text-caption font-mono">{serial}</span>}
      badge={<StateBadge device={fake} />}
    >
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy || connecting}
          onClick={reconnect}
        >
          <RefreshCw className={cn(busy && "animate-spin")} />
          {t("card.reconnect")}
        </Button>
        {isAddressSerial(serial) || fake.transport === "wifi" ? (
          <Button size="sm" variant="ghost" onClick={forget}>
            {t("card.forgetShort")}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => navigate("diagnostics")}
          >
            {t("card.diagnose")}
          </Button>
        )}
      </div>
    </Shell>
  );
}

export function rememberedOffline(
  wifi: Record<string, WifiEntry>,
  devices: Device[],
): WifiEntry[] {
  const present = new Set(devices.map((d) => d.serial));
  return Object.values(wifi)
    .filter((w) => !present.has(w.address))
    .sort((a, b) => b.lastConnected - a.lastConnected);
}

function PromptArt() {
  return (
    <div
      aria-hidden
      className="bg-selected h-[74px] w-[46px] flex-none rounded-[9px] p-1"
    >
      <div className="bg-background/35 flex h-full items-center rounded-md p-[3px]">
        <div className="bg-card w-full rounded-xs px-[3px] py-1">
          <div className="bg-muted-foreground h-[3px] w-[70%] rounded-full" />
          <div className="bg-input mt-[3px] h-[3px] w-1/2 rounded-full" />
          <div className="bg-brand mt-1 ml-auto h-1 w-[40%] rounded-full" />
        </div>
      </div>
    </div>
  );
}
