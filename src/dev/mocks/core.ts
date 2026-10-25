import { channel, type MockHandlers } from "@/dev/mockBackend";
import type { Device, DeviceInfo, DevicesEvent } from "@/lib/tauri";

// Sample data matching the design boards.
export const MOCK_DEVICES: Device[] = [
  {
    serial: "38121FDJH00A4B",
    state: { kind: "device" },
    transport: "usb",
    model: "Pixel 8 Pro",
    product: "husky",
    device: "husky",
    transportId: 1,
  },
  {
    serial: "192.168.1.42:37115",
    state: { kind: "device" },
    transport: "wifi",
    model: "SM S911B",
    product: "dm1qxeea",
    device: "dm1q",
    transportId: 2,
  },
  {
    serial: "emulator-5554",
    state: { kind: "device" },
    transport: "emulator",
    model: "sdk gphone64 arm64",
    product: "sdk_gphone64_arm64",
    device: "emu64a",
    transportId: 3,
  },
  {
    serial: "a1b2c3d4",
    state: { kind: "unauthorized" },
    transport: "usb",
    model: null,
    product: null,
    device: null,
    transportId: 4,
  },
];

const INFO: Record<string, DeviceInfo> = {
  "38121FDJH00A4B": {
    manufacturer: "Google",
    model: "Pixel 8 Pro",
    androidVersion: "15",
    sdk: 35,
    securityPatch: "2026-10-05",
    fingerprint:
      "google/husky/husky:15/AP4A.261005.002/12493156:user/release-keys",
    abi: "arm64-v8a",
  },
  "192.168.1.42:37115": {
    manufacturer: "samsung",
    model: "Galaxy S23",
    androidVersion: "14",
    sdk: 34,
    securityPatch: "2026-09-01",
    fingerprint:
      "samsung/dm1qxeea/dm1q:14/UP1A.231005.007/S911BXXS3BWK5:user/release-keys",
    abi: "arm64-v8a",
  },
  "emulator-5554": {
    manufacturer: "Google",
    model: "Pixel 7 API 34",
    androidVersion: "14",
    sdk: 34,
    securityPatch: "2026-08-05",
    fingerprint:
      "google/sdk_gphone64_arm64/emu64a:14/UE1A.230829.036/10763863:userdebug/dev-keys",
    abi: "arm64-v8a",
  },
};

const handlers: MockHandlers = {
  locate_adb: () => ({
    path: "/Users/me/Library/Android/sdk/platform-tools/adb",
    source: "known_location",
    version: "37.0.1-15733141",
  }),
  watch_devices: ({ onEvent }) => {
    const send = channel<DevicesEvent>(onEvent);
    setTimeout(() => send({ type: "devices", devices: MOCK_DEVICES }), 150);
    return null;
  },
  device_info: ({ serial }) => {
    const info = INFO[serial as string];
    if (!info)
      throw { kind: "device", message: "device unauthorized", hint: null };
    return info;
  },
};

export default handlers;
