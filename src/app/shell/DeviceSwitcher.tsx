import {
  Check,
  ChevronsUpDown,
  LayoutGrid,
  Plus,
  Search,
  Smartphone,
  Stethoscope,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useNavigation } from "@/app/navigation";
import { deviceTone, StatusDot } from "@/components/status/StatusDot";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";
import { useKnownDevices } from "@/features/devices/known";
import { deviceName, useDeviceName } from "@/features/devices/naming";
import { useDeviceInfo } from "@/features/devices/queries";
import { useConnectSheet } from "@/features/devices/sheetStore";
import { useDevices, useSelectedSnapshot } from "@/features/devices/store";
import { modKey } from "@/lib/platform";
import type { Device } from "@/lib/tauri";

export function DeviceSwitcher({ collapsed }: { collapsed: boolean }) {
  const { t } = useTranslation();
  const { device, gone } = useSelectedSnapshot();
  const devices = useDevices((s) => s.devices);
  const selected = useDevices((s) => s.selectedSerial);
  const select = useDevices((s) => s.select);
  const navigate = useNavigation((s) => s.navigate);
  // Re-render on rename.
  useKnownDevices((s) => s.aliases);
  const [query, setQuery] = useState("");
  const { data: info } = useDeviceInfo(
    device?.state.kind === "device" && !gone ? device.serial : null,
  );
  const name = useDeviceName(device, info);

  const subtitle = gone
    ? t("sidebar.disconnected")
    : device
      ? [
          t(`transport.${device.transport}`),
          info?.androidVersion &&
            t("android", { version: info.androidVersion }),
        ]
          .filter(Boolean)
          .join(" · ")
      : t("sidebar.connectToStart");

  const q = query.trim().toLowerCase();
  const shown = devices
    .map((d, index) => ({ d, index }))
    .filter(
      ({ d }) =>
        !q ||
        deviceName(d).toLowerCase().includes(q) ||
        d.serial.toLowerCase().includes(q),
    );

  return (
    <DropdownMenu onOpenChange={(open) => !open && setQuery("")}>
      <DropdownMenuTrigger
        aria-label={t("sidebar.switchDevice")}
        className="bg-card hover:bg-accent focus-visible:outline-ring aria-expanded:border-ring aria-expanded:ring-brand/15 flex w-full items-center gap-2.5 rounded-md border px-2 py-1.5 text-left outline-none focus-visible:outline-2 focus-visible:outline-offset-2 aria-expanded:ring-[3px]"
      >
        <span
          className={
            device
              ? "bg-selected text-secondary-foreground flex size-[30px] flex-none items-center justify-center rounded-[7px]"
              : "border-input text-secondary-foreground flex size-[30px] flex-none items-center justify-center rounded-[7px] border border-dashed"
          }
        >
          {device ? (
            <Smartphone className="size-4" aria-hidden />
          ) : (
            <Plus className="size-4" aria-hidden />
          )}
        </span>
        {!collapsed && (
          <>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-semibold">
                {name ?? t("sidebar.noDevice")}
              </span>
              <span
                className={
                  gone
                    ? "text-caption text-error flex items-center gap-1.5"
                    : "text-caption text-muted-foreground flex items-center gap-1.5"
                }
              >
                {device && (
                  <StatusDot tone={gone ? "error" : deviceTone(device.state)} />
                )}
                <span className="truncate">{subtitle}</span>
              </span>
            </span>
            <ChevronsUpDown
              className="text-muted-foreground size-4 flex-none"
              aria-hidden
            />
          </>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-80" align="start">
        {devices.length > 3 && (
          <div className="border-input bg-background text-muted-foreground mb-1 flex h-7 items-center gap-2 rounded-[7px] border px-2.5">
            <Search className="size-3.5" aria-hidden />
            <input
              aria-label={t("sidebar.findDevice")}
              placeholder={t("sidebar.findDevice")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              className="text-foreground placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent outline-none"
            />
          </div>
        )}
        {shown.length > 0 && (
          <DropdownMenuGroup>
            <DropdownMenuLabel>{t("nav.devices")}</DropdownMenuLabel>
            {shown.map(({ d, index }) => (
              <DeviceItem
                key={d.serial}
                device={d}
                index={index}
                selected={d.serial === selected}
                onSelect={() => {
                  select(d.serial);
                  if (useNavigation.getState().section === "devices") {
                    navigate("overview");
                  }
                }}
              />
            ))}
          </DropdownMenuGroup>
        )}
        {shown.length > 0 && <DropdownMenuSeparator />}
        <DropdownMenuItem onClick={() => useConnectSheet.getState().show()}>
          <Plus />
          {t("sidebar.connectDevice")}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => navigate("devices")}>
          <Smartphone />
          {t("sidebar.allDevices")}
          <Kbd className="ml-auto">{modKey}D</Kbd>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => navigate("multi-device")}>
          <LayoutGrid />
          {t("nav.multi-device")}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => navigate("diagnostics")}>
          <Stethoscope />
          {t("sidebar.cantSee")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DeviceItem({
  device,
  index,
  selected,
  onSelect,
}: {
  device: Device;
  index: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const ready = device.state.kind === "device";
  return (
    <DropdownMenuItem onClick={onSelect} className="gap-2.5">
      <Smartphone className="text-secondary-foreground" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{deviceName(device)}</span>
        {ready ? (
          <span className="text-caption text-muted-foreground block truncate font-mono">
            {device.serial}
            {device.transport !== "emulator" &&
              ` · ${t(`transport.${device.transport}`)}`}
          </span>
        ) : (
          <span className="text-caption text-warning block truncate">
            {t(`sidebar.stateHint.${device.state.kind}`, {
              defaultValue: t(`state.${device.state.kind}`),
            })}
          </span>
        )}
      </span>
      {selected ? (
        <Check className="text-brand" aria-hidden />
      ) : (
        <StatusDot tone={deviceTone(device.state)} />
      )}
      {index < 9 && (
        <Kbd>
          {modKey}
          {index + 1}
        </Kbd>
      )}
    </DropdownMenuItem>
  );
}
