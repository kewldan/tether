import { channel, type MockHandlers, sleep } from "@/dev/mockBackend";
import { addMockCapture } from "@/dev/mocks/gallery";
import type { DeviceSnapshot, RecordingEvent } from "@/features/overview/api";
import type { DeviceInfo } from "@/lib/tauri";

// Sample data matching the Overview board.
const GB = 1024 ** 3;

const PIXEL_INFO: DeviceInfo = {
  manufacturer: "Google",
  model: "Pixel 8 Pro",
  androidVersion: "15",
  sdk: 35,
  securityPatch: "2026-10-05",
  fingerprint:
    "google/husky/husky:15/AP4A.261005.002/12493156:user/release-keys",
  abi: "arm64-v8a",
};

let level = 78;
const bootedAt = Date.now() - (3 * 86400 + 4 * 3600) * 1000;
const jitter = (base: number, spread: number) =>
  Math.max(0, Math.min(1, base + (Math.random() - 0.5) * spread));

function pixel(): DeviceSnapshot {
  level = Math.min(100, level + 0.04);
  const now = Date.now();
  return {
    info: PIXEL_INFO,
    build: {
      brand: "google",
      device: "husky",
      buildId: "AP4A.261005.002",
      buildType: "user",
      incremental: "12493156",
      soc: "Google Tensor G3",
      locale: "en-US",
    },
    battery: {
      level: Math.floor(level),
      status: "charging",
      plugged: "usb",
      temperatureC: 31.4,
      health: "good",
      voltageV: 4.21,
      technology: "Li-ion",
    },
    storage: {
      totalBytes: 256 * GB,
      usedBytes: 168.4 * GB,
      availableBytes: 87.6 * GB,
      categories: {
        apps: 87.1 * GB,
        photosVideos: 46 * GB,
        audio: 1.1 * GB,
        downloads: 2.4 * GB,
        system: 23 * GB,
        other: 8.8 * GB,
      },
    },
    memory: {
      totalBytes: 12 * GB,
      availableBytes: (4.6 + (Math.random() - 0.5) * 0.3) * GB,
      freeBytes: 0.8 * GB,
      cachedBytes: 3.1 * GB,
      swapTotalBytes: 6 * GB,
      swapFreeBytes: 4.8 * GB,
    },
    cpu: {
      cores: 9,
      maxFreqMhz: 2910,
      load: jitter(0.23, 0.1),
      coreLoads: [0.3, 0.18, 0.52, 0.12, 0.4, 0.22, 0.1, 0.64, 0.08].map((v) =>
        jitter(v, 0.15),
      ),
      abi: "arm64-v8a",
    },
    thermal: { status: "none", cpuC: 38.2, skinC: 33.5 },
    display: {
      physicalSize: { width: 1344, height: 2992 },
      overrideSize: null,
      physicalDensity: 480,
      overrideDensity: null,
      refreshRate: 120,
      maxRefreshRate: 120,
      fontScale: 1,
    },
    network: {
      wifiEnabled: true,
      ssid: "HomeNet-5G",
      ip: "192.168.1.33",
      rssiDbm: -52,
      frequencyMhz: 5180,
      linkSpeedMbps: 866,
      mobileOperator: "Beeline",
      mobileType: "LTE",
    },
    uptimeSecs: (now - bootedAt) / 1000,
    root: "none",
    takenAt: now,
  };
}

function emulator(): DeviceSnapshot {
  const now = Date.now();
  return {
    info: {
      manufacturer: "Google",
      model: "sdk_gphone64_arm64",
      androidVersion: "16",
      sdk: 36,
      securityPatch: "2026-01-05",
      fingerprint:
        "google/sdk_gphone64_arm64/emu64a:16/BE4B.251210.005/14574095:userdebug/dev-keys",
      abi: "arm64-v8a",
    },
    build: {
      brand: "google",
      device: "emu64a",
      buildId: "BE4B.251210.005",
      buildType: "userdebug",
      incremental: "14574095",
      soc: "AOSP ranchu",
      locale: "en-US",
    },
    battery: {
      level: 100,
      status: "not_charging",
      plugged: null,
      temperatureC: 25,
      health: "good",
      voltageV: 5,
      technology: "Li-ion",
    },
    storage: {
      totalBytes: 6_228_115_456,
      usedBytes: 3_169_759_232,
      availableBytes: 2_912_731_136,
      categories: null,
    },
    memory: {
      totalBytes: 4_107_005_952,
      availableBytes: 1_776_332_800 + Math.random() * 50_000_000,
      freeBytes: 149_377_024,
      cachedBytes: 1_868_247_040,
      swapTotalBytes: 3_080_249_344,
      swapFreeBytes: 2_334_318_592,
    },
    cpu: {
      cores: 4,
      maxFreqMhz: null,
      load: jitter(0.07, 0.08),
      coreLoads: [0.08, 0.11, 0.08, 0.03].map((v) => jitter(v, 0.1)),
      abi: "arm64-v8a",
    },
    thermal: { status: "none", cpuC: null, skinC: 30.1 },
    display: {
      physicalSize: { width: 1280, height: 2856 },
      overrideSize: null,
      physicalDensity: 480,
      overrideDensity: null,
      refreshRate: 60,
      maxRefreshRate: 60,
      fontScale: 1,
    },
    network: {
      wifiEnabled: true,
      ssid: "AndroidWifi",
      ip: "10.0.2.16",
      rssiDbm: -50,
      frequencyMhz: 2437,
      linkSpeedMbps: 2,
      mobileOperator: "T-Mobile",
      mobileType: "NR_SA",
    },
    uptimeSecs: 1767 + (now % 100000) / 1000,
    root: "su",
    takenAt: now,
  };
}

const recordings = new Map<string, { started: number; end: () => void }>();

const handlers: MockHandlers = {
  device_snapshot: async ({ serial }) => {
    await sleep(120);
    if (serial === "emulator-5554") return emulator();
    if (serial === "38121FDJH00A4B") return pixel();
    const snap = pixel();
    return {
      ...snap,
      info: { ...snap.info, model: "Galaxy S23", manufacturer: "samsung" },
      build: { ...snap.build, device: "dm1q", soc: "Qualcomm SM8550" },
    };
  },
  reboot_device: async () => {
    await sleep(300);
    return null;
  },
  take_screenshot: async ({ deviceName, stamp }) => {
    await sleep(500);
    return addMockCapture(
      deviceName as string,
      `Screenshot_${stamp as string}.png`,
      "screenshot",
    );
  },
  start_recording: ({ serial, onEvent }) => {
    const send = channel<RecordingEvent>(onEvent);
    recordings.set(serial as string, {
      started: Date.now(),
      end: () => send({ type: "ended", message: null }),
    });
    return null;
  },
  stop_recording: async ({ serial, deviceName, stamp }) => {
    const rec = recordings.get(serial as string);
    recordings.delete(serial as string);
    await sleep(800);
    rec?.end();
    return addMockCapture(
      deviceName as string,
      `Recording_${stamp as string}.mp4`,
      "recording",
    );
  },
  recording_status: ({ serial }) => {
    const rec = recordings.get(serial as string);
    return rec ? { elapsedMs: Date.now() - rec.started, running: true } : null;
  },
};

export default handlers;
