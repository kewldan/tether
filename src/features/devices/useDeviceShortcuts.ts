import { useEffect } from "react";

import { useNavigation } from "@/app/navigation";
import { useConnectSheet } from "@/features/devices/sheetStore";
import { useDevices } from "@/features/devices/store";
import { hasMod } from "@/lib/platform";

/**
 * ⌘1…⌘9 switch to the n-th device, ⌘D opens All devices, ⌘⇧W opens the
 * Wi-Fi sheet. Mounted once by the shell.
 */
export function useDeviceShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!hasMod(e) || e.altKey) return;
      const key = e.key.toLowerCase();
      if (e.shiftKey && key === "w") {
        e.preventDefault();
        useConnectSheet.getState().show();
        return;
      }
      if (e.shiftKey) return;
      if (key === "d") {
        e.preventDefault();
        useNavigation.getState().navigate("devices");
        return;
      }
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= 9) {
        const device = useDevices.getState().devices[n - 1];
        if (!device) return;
        e.preventDefault();
        useDevices.getState().select(device.serial);
        if (useNavigation.getState().section === "devices") {
          useNavigation.getState().navigate("overview");
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
