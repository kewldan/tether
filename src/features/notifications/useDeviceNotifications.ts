import type { QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { toast } from "sonner";

import { connectWifi } from "@/features/devices/api";
import { isAddressSerial } from "@/features/devices/known";
import { deviceName } from "@/features/devices/naming";
import { useDevices } from "@/features/devices/store";
import i18n from "@/lib/i18n";
import { useSettings } from "@/lib/settings";
import type { DeviceInfo } from "@/lib/tauri";

import {
  type ConnectionChange,
  ConnectionTracker,
  onlineSerials,
} from "./connections";
import { deliver } from "./notify";
import { showStatusToast } from "./toasts";

/** A drop and return within this window is not announced. */
const SETTLE_MS = 3000;
/** More changes than this at once become one grouped notice. */
const GROUP_OVER = 2;

const t = (key: string, options?: Record<string, unknown>) =>
  i18n.t(key, { ns: "notifications", ...options });

function nameOf(serial: string, queryClient: QueryClient): string {
  const device = useDevices.getState().snapshots[serial];
  if (!device) return serial;
  const info = queryClient.getQueryData<DeviceInfo>(["device-info", serial]);
  return deviceName(device, info);
}

function announce(changes: ConnectionChange[], queryClient: QueryClient) {
  const connected = changes.filter((c) => c.online).map((c) => c.serial);
  const dropped = changes.filter((c) => !c.online).map((c) => c.serial);
  const names = (serials: string[]) =>
    serials.map((s) => nameOf(s, queryClient)).join(", ");

  if (connected.length > GROUP_OVER) {
    const text = t("device.manyConnected", { count: connected.length });
    deliver({
      toast: () => showStatusToast("success", text),
      system: { title: text, body: names(connected) },
    });
  } else {
    for (const serial of connected) {
      const name = nameOf(serial, queryClient);
      const transport = useDevices.getState().snapshots[serial]?.transport;
      const text =
        transport === "usb" || transport === "wifi"
          ? t("device.connectedOver", {
              name,
              transport: i18n.t(`transport.${transport}`, { ns: "common" }),
            })
          : t("device.connected", { name });
      deliver({
        toast: () => showStatusToast("success", text),
        system: { title: text, route: { kind: "device", serial } },
      });
    }
  }

  if (dropped.length > GROUP_OVER) {
    const text = t("device.manyDisconnected", { count: dropped.length });
    deliver({
      toast: () => showStatusToast("error", text),
      system: { title: text, body: names(dropped) },
    });
  } else {
    for (const serial of dropped) {
      const name = nameOf(serial, queryClient);
      const text = t("device.disconnected", { name });
      const reconnect = isAddressSerial(serial)
        ? {
            label: t("device.reconnect"),
            onClick: () =>
              void connectWifi(serial).catch(() =>
                toast.error(t("device.reconnectFailed", { name })),
              ),
          }
        : undefined;
      deliver({
        toast: () => showStatusToast("error", text, reconnect),
        system: { title: text, route: { kind: "device", serial } },
      });
    }
  }
}

/**
 * "Pixel 8 connected over USB" / "Pixel 6a disconnected" from the device
 * stream, debounced so flapping connections stay quiet.
 */
export function useDeviceNotifications(queryClient: QueryClient) {
  useEffect(() => {
    const tracker = new ConnectionTracker();
    let timer: ReturnType<typeof setTimeout> | null = null;

    const settle = () => {
      timer = null;
      const changes = tracker.settle(
        onlineSerials(useDevices.getState().devices),
      );
      if (changes.length > 0 && useSettings.getState().notifyDevices)
        announce(changes, queryClient);
    };

    const initial = useDevices.getState();
    if (!initial.loading && !initial.error)
      tracker.observe(onlineSerials(initial.devices));

    const unsubscribe = useDevices.subscribe((state, prev) => {
      // The server went away: every device "drops" and "returns" with it,
      // which is not news. Start over from the next list.
      if (state.error && !prev.error) {
        tracker.reset();
        return;
      }
      if (state.devices === prev.devices) return;
      if (tracker.observe(onlineSerials(state.devices)) && timer === null)
        timer = setTimeout(settle, SETTLE_MS);
    });

    return () => {
      unsubscribe();
      if (timer !== null) clearTimeout(timer);
    };
  }, [queryClient]);
}
