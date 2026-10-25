import { useEffect, useState } from "react";
import { Cable, Monitor, Smartphone, Wifi } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { type Device, type DeviceInfo, deviceInfo } from "@/lib/tauri";

const STATE_LABELS: Record<string, string> = {
  device: "Online",
  unauthorized: "Unauthorized",
  authorizing: "Authorizing",
  offline: "Offline",
  connecting: "Connecting",
  no_permissions: "No permissions",
  recovery: "Recovery",
  rescue: "Rescue",
  sideload: "Sideload",
  bootloader: "Bootloader",
  host: "Host",
};

const STATE_HINTS: Partial<Record<string, string>> = {
  unauthorized: "Confirm the USB debugging prompt on the device.",
  offline: "Reconnect the cable or restart adb.",
  no_permissions: "udev rules are missing for this device.",
};

const TRANSPORT_ICONS = {
  usb: Cable,
  wifi: Wifi,
  emulator: Monitor,
} as const;

export function DeviceCard({ device }: { device: Device }) {
  const online = device.state.kind === "device";
  const [info, setInfo] = useState<DeviceInfo | null>(null);

  useEffect(() => {
    if (!online) return;
    let active = true;
    deviceInfo(device.serial)
      .then((i) => active && setInfo(i))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [device.serial, online]);

  const TransportIcon = TRANSPORT_ICONS[device.transport];
  const stateLabel =
    device.state.kind === "unknown"
      ? device.state.raw
      : STATE_LABELS[device.state.kind];
  const title = info?.model ?? device.model ?? device.serial;
  const subtitle = [
    info?.manufacturer,
    info?.androidVersion && `Android ${info.androidVersion}`,
    info?.sdk && `SDK ${info.sdk}`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Card size="sm">
      <CardHeader>
        <div className="flex items-start gap-3">
          <div className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-lg">
            <Smartphone className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <CardTitle className="truncate">{title}</CardTitle>
            <CardDescription className="truncate font-mono text-xs">
              {device.serial}
            </CardDescription>
          </div>
          <Badge variant={online ? "secondary" : "destructive"}>
            <span
              className={
                online
                  ? "size-1.5 rounded-full bg-success"
                  : "size-1.5 rounded-full bg-current"
              }
            />
            {stateLabel}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="text-muted-foreground flex items-center gap-2 text-sm">
        <TransportIcon className="size-4" />
        <span className="truncate">
          {STATE_HINTS[device.state.kind] ?? (subtitle || "Loading…")}
        </span>
      </CardContent>
    </Card>
  );
}
