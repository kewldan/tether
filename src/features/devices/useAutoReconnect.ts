import { useEffect } from "react";

import { connectWifi } from "@/features/devices/api";
import { isAddressSerial, useKnownDevices } from "@/features/devices/known";
import { deviceName } from "@/features/devices/naming";
import { useDevices } from "@/features/devices/store";
import { useSettings } from "@/lib/settings";

const INTERVAL = 10_000;

/** Addresses that dropped this session and are being retried. */
const dropped = new Set<string>();

/** Stops retrying an address (after Disconnect / Forget). */
export function stopReconnecting(address: string) {
  dropped.delete(address);
}

/**
 * Remembers every Wi-Fi device that connects and, with "Auto-reconnect
 * Wi-Fi devices" on, retries the ones that dropped every 10 s.
 */
export function useAutoReconnect(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    let previous = new Set<string>();

    const unsubscribe = useDevices.subscribe((state) => {
      const online = new Set(
        state.devices
          .filter((d) => isAddressSerial(d.serial) && d.state.kind === "device")
          .map((d) => d.serial),
      );
      const { wifi, rememberWifi } = useKnownDevices.getState();
      for (const serial of online) {
        dropped.delete(serial);
        if (!previous.has(serial) || !wifi[serial]) {
          const device = state.devices.find((d) => d.serial === serial);
          rememberWifi(serial, device ? deviceName(device) : null);
        }
      }
      for (const serial of previous) {
        if (!online.has(serial)) dropped.add(serial);
      }
      previous = online;
    });

    const timer = setInterval(() => {
      if (!useSettings.getState().autoReconnect) return;
      const known = useKnownDevices.getState().wifi;
      for (const address of dropped) {
        if (!known[address]) {
          dropped.delete(address);
          continue;
        }
        connectWifi(address).catch(() => undefined);
      }
    }, INTERVAL);

    return () => {
      unsubscribe();
      clearInterval(timer);
    };
  }, [enabled]);
}
