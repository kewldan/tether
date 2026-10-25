import { Fragment, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { deviceTone, StatusDot } from "@/components/status/StatusDot";
import { deviceName } from "@/features/devices/naming";
import { useDeviceInfo } from "@/features/devices/queries";
import { useSelectedDevice } from "@/features/devices/store";
import { useDeviceSnapshot } from "@/features/overview/useDeviceSnapshot";
import { useActiveForwards } from "@/features/ports/queries";

/** 24 px status bar with facts about the selected device. */
export function StatusBar() {
  const { t } = useTranslation();
  const device = useSelectedDevice();
  const readySerial = device?.state.kind === "device" ? device.serial : null;
  const { data: info } = useDeviceInfo(readySerial);
  const { data: snapshot } = useDeviceSnapshot(readySerial);
  const forwards = useActiveForwards();
  const battery = snapshot?.battery;
  const portRules = [
    ...forwards.forward.map((r) => `${r.local} → ${stripTcp(r.remote)}`),
    ...forwards.reverse.map((r) => `${r.local} ← ${stripTcp(r.remote)}`),
  ];

  const items: ReactNode[] = device
    ? [
        <span key="name" className="flex items-center gap-1.5">
          <StatusDot tone={deviceTone(device.state)} />
          {deviceName(device, info)}
        </span>,
        <span key="serial" className="font-mono">
          {device.serial}
        </span>,
        t(`transport.${device.transport}`),
        battery?.level != null && (
          <span key="battery" className="tabular-nums">
            {battery.level}%{battery.status === "charging" ? " ⚡" : ""}
          </span>
        ),
        info?.androidVersion &&
          (info.sdk
            ? t("androidSdk", { version: info.androidVersion, sdk: info.sdk })
            : t("android", { version: info.androidVersion })),
      ].filter(Boolean)
    : [
        <span key="none" className="flex items-center gap-1.5">
          <StatusDot tone="neutral" />
          {t("sidebar.noDevice")}
        </span>,
        "adb server :5037",
      ];

  return (
    <footer className="bg-sidebar text-caption text-muted-foreground flex h-6 flex-none items-center gap-3.5 overflow-hidden border-t px-3 whitespace-nowrap">
      {items.map((item, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static positional list
        <Fragment key={i}>
          {i > 0 && <span aria-hidden className="bg-input h-3 w-px" />}
          {item}
        </Fragment>
      ))}
      {device && portRules.length > 0 && (
        <span className="ml-auto truncate font-mono">
          {portRules.join(" · ")}
        </span>
      )}
    </footer>
  );
}

function stripTcp(spec: string) {
  return spec.startsWith("tcp:") ? spec.slice(4) : spec;
}
