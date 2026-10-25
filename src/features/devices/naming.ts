import { useKnownDevices } from "@/features/devices/known";
import type { Device, DeviceInfo } from "@/lib/tauri";

/**
 * Human name of a device: the local alias from "Rename…", then getprop
 * model, then adb's model, then serial. Reads aliases without subscribing;
 * components that must re-render on rename use {@link useDeviceName}.
 */
export function deviceName(device: Device, info?: DeviceInfo | null): string {
  return (
    useKnownDevices.getState().aliases[device.serial] ??
    info?.model ??
    device.model ??
    device.serial
  );
}

/** {@link deviceName} that re-renders when the alias changes. */
export function useDeviceName(
  device: Device | null,
  info?: DeviceInfo | null,
): string | null {
  const alias = useKnownDevices((s) =>
    device ? s.aliases[device.serial] : undefined,
  );
  if (!device) return null;
  return alias ?? info?.model ?? device.model ?? device.serial;
}
