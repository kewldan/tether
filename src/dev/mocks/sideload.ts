import { channel, type MockHandlers, sleep } from "@/dev/mockBackend";
import { MOCK_DEVICES } from "@/dev/mocks/core";
import devicesMocks, { scenario } from "@/dev/mocks/devices";
import type { OtaPackage, SideloadEvent } from "@/features/sideload/api";
import type { DevicesEvent } from "@/lib/tauri";

/**
 * Sideload mocks. `?mock=sideload` puts the Pixel 8 Pro into sideload
 * mode (overrides `watch_devices` from devices.ts, files merge A→Z).
 * File names steer `sideload_inspect`: `*-other*` targets another
 * device, `*plain*` is not an OTA, `*fail*` ends with FAILFAIL.
 */
const SIZE = 2_310_000_000;
let cancelled = false;

const handlers: MockHandlers = {
  watch_devices: (args) => {
    if (scenario !== "sideload") return devicesMocks.watch_devices?.(args);
    const send = channel<DevicesEvent>(args.onEvent);
    const devices = MOCK_DEVICES.map((d, i) =>
      i === 0 ? { ...d, state: { kind: "sideload" as const } } : d,
    );
    setTimeout(() => send({ type: "devices", devices }), 150);
    return null;
  },
  sideload_inspect: async ({ path }): Promise<OtaPackage> => {
    await sleep(400);
    const p = String(path);
    const name = p.split(/[\\/]/).pop() ?? p;
    if (!name.toLowerCase().endsWith(".zip"))
      throw {
        kind: "invalid_input",
        message: "invalid input: the file is not a zip archive",
        hint: null,
      };
    const plain = name.includes("plain");
    return {
      path: p,
      name,
      sizeBytes: SIZE,
      isOta: !plain,
      ab: !plain,
      otaType: plain ? null : "AB",
      devices: plain ? [] : [name.includes("other") ? "shiba" : "husky"],
      postBuild: plain
        ? null
        : "google/husky/husky:15/AP4A.261005.002/12493156:user/release-keys",
      postRelease: plain ? null : "15",
      postBuildId: plain ? null : "AP4A.261005.002",
      postSdk: plain ? null : 35,
      postSecurityPatch: plain ? null : "2026-10-05",
      preBuild: null,
      wipe: false,
      downgrade: false,
      signed: !plain,
    };
  },
  sideload_start: async ({ path, onEvent }) => {
    const send = channel<SideloadEvent>(onEvent);
    cancelled = false;
    const total = (SIZE * 100) / 47;
    const steps = 120;
    for (let i = 1; i <= steps; i++) {
      await sleep(150);
      if (cancelled)
        throw {
          kind: "cancelled",
          message: "operation was cancelled",
          hint: null,
        };
      if (String(path).includes("fail") && i === 60)
        throw {
          kind: "device",
          message:
            "recovery rejected the package; the phone's screen shows why",
          hint: null,
        };
      const transferred = Math.round((total * i) / steps);
      send({
        type: "progress",
        mode: "host",
        transferred,
        size: SIZE,
        percent: Math.min(100, Math.floor((transferred * 47) / SIZE)),
      });
    }
    return { mode: "host", elapsedMs: steps * 150 };
  },
  sideload_cancel: () => {
    cancelled = true;
    return null;
  },
};

export default handlers;
