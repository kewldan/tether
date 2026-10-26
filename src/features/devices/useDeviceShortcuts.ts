import { useNavigation } from "@/app/navigation";
import { useConnectSheet } from "@/features/devices/sheetStore";
import { useDevices } from "@/features/devices/store";
import { useShortcut } from "@/lib/shortcuts";

/**
 * Device shortcuts (defaults ⌘1…⌘9 switch to the n-th device, ⌘D opens All
 * devices, ⌘⇧W opens the Wi-Fi sheet; rebindable in Settings). Mounted
 * once by the shell.
 */
export function useDeviceShortcuts() {
  useShortcut("wifi", () => useConnectSheet.getState().show());
  useShortcut("devices", () => useNavigation.getState().navigate("devices"));
  useShortcut("switch", (_e, n) => {
    const device = n === null ? null : useDevices.getState().devices[n - 1];
    if (!device) return false;
    useDevices.getState().select(device.serial);
    if (useNavigation.getState().section === "devices") {
      useNavigation.getState().navigate("overview");
    }
  });
}
