import { ChevronsUpDown, Plus, Smartphone, Stethoscope } from "lucide-react";
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
import { deviceName } from "@/features/devices/naming";
import { useDeviceInfo } from "@/features/devices/queries";
import { useDevices, useSelectedDevice } from "@/features/devices/store";
import type { Device } from "@/lib/tauri";

export function DeviceSwitcher({ collapsed }: { collapsed: boolean }) {
  const { t } = useTranslation();
  const device = useSelectedDevice();
  const devices = useDevices((s) => s.devices);
  const select = useDevices((s) => s.select);
  const navigate = useNavigation((s) => s.navigate);
  const { data: info } = useDeviceInfo(
    device?.state.kind === "device" ? device.serial : null,
  );

  const subtitle = device
    ? [
        t(`transport.${device.transport}`),
        info?.androidVersion && t("android", { version: info.androidVersion }),
      ]
        .filter(Boolean)
        .join(" · ")
    : t("sidebar.connectToStart");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t("sidebar.switchDevice")}
        className="bg-card hover:bg-accent focus-visible:outline-ring flex w-full items-center gap-2.5 rounded-md border px-2 py-1.5 text-left outline-none focus-visible:outline-2 focus-visible:outline-offset-2"
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
                {device ? deviceName(device, info) : t("sidebar.noDevice")}
              </span>
              <span className="text-caption text-muted-foreground flex items-center gap-1.5">
                {device && <StatusDot tone={deviceTone(device.state)} />}
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
      <DropdownMenuContent className="w-64" align="start">
        {devices.length > 0 && (
          <DropdownMenuGroup>
            <DropdownMenuLabel>{t("nav.devices")}</DropdownMenuLabel>
            {devices.map((d) => (
              <DeviceItem
                key={d.serial}
                device={d}
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
        {devices.length > 0 && <DropdownMenuSeparator />}
        <DropdownMenuItem onClick={() => navigate("devices")}>
          <Smartphone />
          {t("sidebar.allDevices")}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => navigate("devices", { connect: "wifi" })}
        >
          <Plus />
          {t("sidebar.connectDevice")}
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
  onSelect,
}: {
  device: Device;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  return (
    <DropdownMenuItem onClick={onSelect} className="gap-2.5">
      <StatusDot tone={deviceTone(device.state)} />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{deviceName(device)}</span>
        <span className="text-caption text-muted-foreground block truncate font-mono">
          {device.serial}
        </span>
      </span>
      <span className="text-caption text-muted-foreground">
        {t(`transport.${device.transport}`)}
      </span>
    </DropdownMenuItem>
  );
}
