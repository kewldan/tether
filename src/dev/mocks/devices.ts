import { channel, type MockHandlers, sleep } from "@/dev/mockBackend";
import { MOCK_DEVICES } from "@/dev/mocks/core";
import type {
  AvdList,
  DeviceSummary,
  MdnsSnapshot,
  PairEvent,
  PairTarget,
  QrSession,
} from "@/features/devices/api";
import type { Device, DevicesEvent } from "@/lib/tauri";

/**
 * Devices, Wi-Fi and emulator mocks. Scenarios via `?mock=`:
 * `empty` (no devices), `states` (unauthorized/offline/no permissions/
 * recovery cards), `disconnect` (the Pixel drops after 5 s, returns after
 * 25 s). Overrides `watch_devices` from core.ts (files merge A→Z).
 */
export const scenario = new URLSearchParams(location.search).get("mock") ?? "";

const SPECIAL: Device[] = [
  {
    serial: "192.168.1.57:5555",
    state: { kind: "offline" },
    transport: "wifi",
    model: "Pixel 6a",
    product: null,
    device: null,
    transportId: 5,
  },
  {
    serial: "18d1:4ee7-1-4",
    state: { kind: "no_permissions" },
    transport: "usb",
    model: null,
    product: null,
    device: null,
    transportId: 6,
  },
  {
    serial: "38121FDJH00A4C",
    state: { kind: "recovery" },
    transport: "usb",
    model: "Pixel 8 Pro",
    product: "husky",
    device: "husky",
    transportId: 7,
  },
];

let current: Device[] =
  scenario === "empty"
    ? []
    : scenario === "states"
      ? [...MOCK_DEVICES, ...SPECIAL]
      : [...MOCK_DEVICES];
let push: ((e: DevicesEvent) => void) | null = null;

function publish(devices: Device[]) {
  current = devices;
  push?.({ type: "devices", devices });
}

const SUMMARY: Record<string, DeviceSummary> = {
  "38121FDJH00A4B": {
    battery: 82,
    charging: true,
    root: false,
    wifiIp: "192.168.1.33",
  },
  "192.168.1.42:37115": {
    battery: 57,
    charging: false,
    root: false,
    wifiIp: "192.168.1.42",
  },
  "emulator-5554": {
    battery: 100,
    charging: false,
    root: true,
    wifiIp: "10.0.2.16",
  },
};

const QR_MODULES = (() => {
  // A plausible-looking 29×29 pattern with finder squares.
  const n = 29;
  let seed = 7;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  let out = "";
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const finder = [
        [0, 0],
        [n - 7, 0],
        [0, n - 7],
      ].find(([fx, fy]) => x >= fx && x < fx + 7 && y >= fy && y < fy + 7);
      if (finder) {
        const dx = x - finder[0];
        const dy = y - finder[1];
        const ring = dx === 0 || dy === 0 || dx === 6 || dy === 6;
        const core = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
        out += ring || core ? "1" : "0";
      } else {
        out += rnd() > 0.52 ? "1" : "0";
      }
    }
  }
  return { n, out };
})();

const NEW_PHONE: Device = {
  serial: "192.168.1.61:38211",
  state: { kind: "device" },
  transport: "wifi",
  model: "Pixel Tablet",
  product: "tangorpro",
  device: "tangorpro",
  transportId: 9,
};

let pairCancelled = false;

const handlers: MockHandlers = {
  watch_devices: ({ onEvent }) => {
    push = channel<DevicesEvent>(onEvent);
    setTimeout(() => publish(current), 150);
    if (scenario === "disconnect") {
      const pixel = current[0];
      setTimeout(() => publish(current.filter((d) => d !== pixel)), 5000);
      setTimeout(() => publish([pixel, ...current]), 25_000);
    }
    return null;
  },
  devices_summary: ({ serial }) => {
    const s = SUMMARY[serial as string];
    if (!s) throw { kind: "device", message: "device offline", hint: null };
    return s;
  },
  devices_reconnect: async () => {
    await sleep(500);
    return null;
  },
  devices_reconnect_offline: () => null,
  devices_exec: async ({ serial, command }) => {
    await sleep(300 + Math.random() * 400);
    if (String(serial).startsWith("192.168")) return "14\n";
    return command === "getprop ro.build.version.release" ? "15\n" : "";
  },
  devices_screenshot: async ({ serial }) => {
    await sleep(600);
    return `/Users/me/Pictures/Tether/Screenshot_${serial}.png`;
  },
  avd_list: (): AvdList => ({
    canLaunch: true,
    avds: [
      {
        name: "Pixel_7_API_34",
        displayName: "Pixel 7",
        api: "34",
        abi: "arm64-v8a",
        running: null,
      },
      {
        name: "Pixel_Tablet_API_35",
        displayName: "Pixel Tablet",
        api: "35",
        abi: "arm64-v8a",
        running: null,
      },
    ],
  }),
  avd_launch: async () => {
    await sleep(200);
    return null;
  },
  wifi_mdns_services: (): MdnsSnapshot => ({
    available: true,
    services: [
      {
        name: "adb-R5CW30ABCDE-xyzAbC",
        kind: "pairing",
        address: "192.168.1.42:41823",
      },
      {
        name: "adb-HT7A1B2C3D-q9WeRt",
        kind: "pairing",
        address: "192.168.1.61:38211",
      },
      {
        name: "adb-R5CW30ABCDE-xyzAbC",
        kind: "connect",
        address: "192.168.1.42:37115",
      },
    ],
  }),
  wifi_qr_session: (): QrSession => ({
    name: "tether-k3pQ9xYzAb",
    password: "mN4pQ7rS2tUv",
    payload: "WIFI:T:ADB;S:tether-k3pQ9xYzAb;P:mN4pQ7rS2tUv;;",
    width: QR_MODULES.n,
    modules: QR_MODULES.out,
  }),
  wifi_pair: async ({ target, onEvent }) => {
    const send = channel<PairEvent>(onEvent);
    const t = target as PairTarget;
    pairCancelled = false;
    if (t.type === "qr") {
      send({ type: "waiting" });
      // Stays waiting so the countdown is visible; `?mock=pair` completes.
      for (let i = 0; i < (scenario === "pair" ? 6 : 3000); i++) {
        await sleep(100);
        if (pairCancelled)
          throw {
            kind: "cancelled",
            message: "operation was cancelled",
            hint: null,
          };
      }
    }
    const address = t.type === "qr" ? "192.168.1.61:38211" : t.address;
    send({ type: "pairing", address });
    await sleep(900);
    if (t.type === "code" && t.code === "000000") {
      throw {
        kind: "device",
        message: "Wrong password or connection was dropped.",
        hint: null,
      };
    }
    send({ type: "paired", guid: "adb-HT7A1B2C3D-q9WeRt" });
    await sleep(700);
    send({ type: "connecting", address: NEW_PHONE.serial });
    await sleep(500);
    if (!current.some((d) => d.serial === NEW_PHONE.serial))
      publish([...current, NEW_PHONE]);
    return NEW_PHONE.serial;
  },
  wifi_cancel_pair: () => {
    pairCancelled = true;
    return null;
  },
  wifi_connect: async ({ address }) => {
    await sleep(700);
    const a = String(address).includes(":")
      ? String(address)
      : `${address}:5555`;
    if (a.startsWith("10.")) {
      throw {
        kind: "device",
        message: `failed to connect to '${a}': Connection refused`,
        hint: null,
      };
    }
    const existing = current.find((d) => d.serial === a);
    if (existing) {
      publish(
        current.map((d) =>
          d.serial === a ? { ...d, state: { kind: "device" } } : d,
        ),
      );
    } else {
      publish([...current, { ...NEW_PHONE, serial: a, model: "Galaxy S23" }]);
    }
    return a;
  },
  wifi_disconnect: async ({ serial }) => {
    await sleep(200);
    publish(current.filter((d) => d.serial !== serial));
    return null;
  },
  wifi_tcpip: async ({ serial, port }) => {
    await sleep(1500);
    const ip = SUMMARY[serial as string]?.wifiIp ?? "192.168.1.33";
    const address = `${ip}:${port}`;
    publish([
      ...current,
      { ...current[0], serial: address, transport: "wifi" },
    ]);
    return address;
  },
  device_wifi_ip: ({ serial }) => SUMMARY[serial as string]?.wifiIp ?? null,
};

export default handlers;
