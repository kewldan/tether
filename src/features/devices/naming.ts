import type { Device, DeviceInfo } from "@/lib/tauri";

/** Human name of a device: getprop model, then adb's model, then serial. */
export function deviceName(device: Device, info?: DeviceInfo | null): string {
  return info?.model ?? device.model ?? device.serial;
}
