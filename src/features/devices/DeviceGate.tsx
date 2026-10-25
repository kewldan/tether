import { RefreshCw } from "lucide-react";
import { motion } from "motion/react";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { useNavigation } from "@/app/navigation";
import { SECTIONS, type SectionId } from "@/app/sections";
import { PageStatusContext } from "@/components/layout/pageStatus";
import { Button } from "@/components/ui/button";
import {
  connectWifi,
  reconnectDevice,
  reconnectOffline,
} from "@/features/devices/api";
import { isAddressSerial } from "@/features/devices/known";
import { NoDevices } from "@/features/devices/NoDevices";
import { useDeviceName } from "@/features/devices/naming";
import { useDevices, useSelectedSnapshot } from "@/features/devices/store";
import { spring } from "@/lib/motion";
import type { AppError, Device } from "@/lib/tauri";

/**
 * Wraps device pages: the "No devices" state when nothing is connected,
 * and the disconnected banner (page dimmed, still readable) while the
 * selected device is gone. Recovers by itself when it comes back.
 */
export function DeviceGate({
  section,
  children,
}: {
  section: SectionId;
  children: ReactNode;
}) {
  const loading = useDevices((s) => s.loading);
  const { device, gone, since } = useSelectedSnapshot();
  if (SECTIONS[section].group === "app") return children;
  if (!device) return loading ? null : <NoDevices />;
  if (!gone) return children;
  return (
    <PageStatusContext.Provider
      value={{
        banner: <DisconnectedBanner device={device} since={since} />,
        dimmed: true,
      }}
    >
      {children}
    </PageStatusContext.Provider>
  );
}

function clock(ms: number) {
  return new Date(ms).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function useElapsed(since: number | null) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  if (since === null) return null;
  const secs = Math.max(0, Math.floor((now - since) / 1000));
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
}

/** Tries the fitting reconnect for a vanished or offline device. */
export async function reconnectNow(device: Device) {
  if (isAddressSerial(device.serial)) {
    await connectWifi(device.serial);
  } else if (device.state.kind === "offline") {
    await reconnectDevice(device.serial);
  } else {
    await reconnectOffline();
  }
}

function DisconnectedBanner({
  device,
  since,
}: {
  device: Device;
  since: number | null;
}) {
  const { t } = useTranslation("devices");
  const name = useDeviceName(device) ?? device.serial;
  const elapsed = useElapsed(since);
  const navigate = useNavigation((s) => s.navigate);
  const [busy, setBusy] = useState(false);

  const reconnect = () => {
    setBusy(true);
    reconnectNow(device)
      .catch((e: AppError) =>
        toast.error(t("disconnected.failed"), { description: e.message }),
      )
      .finally(() => setBusy(false));
  };

  return (
    <motion.div
      role="status"
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      transition={spring.smooth}
      className="bg-error/13 flex-none overflow-hidden border-b"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 py-2.5">
        <span
          aria-hidden
          className="bg-error size-2.5 flex-none rounded-full"
        />
        <p className="min-w-0 flex-[1_1_320px]">
          <span className="font-semibold">
            {t("disconnected.title", { name })}
          </span>
          <span className="text-secondary-foreground">
            {" — "}
            {since
              ? t("disconnected.since", { time: clock(since) })
              : t("disconnected.waiting")}
          </span>
        </p>
        {elapsed && (
          <span className="text-small text-muted-foreground flex items-center gap-1.5 tabular-nums">
            <RefreshCw className="size-3.5 animate-spin [animation-duration:2s]" />
            {t("disconnected.retrying", { elapsed })}
          </span>
        )}
        <Button size="sm" variant="outline" disabled={busy} onClick={reconnect}>
          {t("disconnected.reconnect")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => navigate("diagnostics")}
        >
          {t("disconnected.cantReconnect")}
        </Button>
      </div>
    </motion.div>
  );
}
