import { type MockHandlers, sleep } from "@/dev/mockBackend";
import { MOCK_DEVICES } from "@/dev/mocks/core";
import { scenario } from "@/dev/mocks/devices";
import type { Check, DiagnosticsReport } from "@/features/diagnostics/api";

/**
 * Diagnostics mock: by default the board's state (phone on USB with
 * debugging off, another adb restarting the server); `?mock=empty` and
 * other scenarios get a mostly green list.
 */
function checks(): Check[] {
  const c = (
    id: string,
    variant: string,
    status: Check["status"],
    params: Record<string, string> = {},
    details: string | null = null,
  ): Check => ({ id, variant, status, params, details });
  const board = scenario === "" || scenario === "empty";
  return [
    c("server_running", "tether", "pass", {
      version: "41",
      address: "localhost:5037",
      uptimeSecs: "372",
    }),
    board
      ? c(
          "server_conflict",
          "restarts",
          "warn",
          {
            count: "3",
            serverVersion: "41",
            clientVersion: "41",
            serverBinary:
              "/Applications/Android Studio.app/…/platform-tools/adb",
          },
          "-42s  lost the adb server: adb server is not reachable: Connection refused\n-40s  adb server started by Tether\n-12s  lost the adb server: adb server is not reachable: Connection refused",
        )
      : c("server_conflict", "none", "pass", {
          serverVersion: "41",
          clientVersion: "41",
        }),
    c("usb_visible", "found", "pass", {
      vendor: "Google",
      product: "Pixel 8 Pro",
      id: "18d1:4ee7",
      location: "USB 3.1 Bus",
    }),
    c("usb_data", "ok", "pass"),
    ...(board
      ? [
          c("usb_debugging", "off", "fail", { product: "Pixel 8 Pro" }),
          c("usb_mode", "charging", "warn"),
        ]
      : [c("usb_debugging", "on", "pass")]),
    c("authorization", "pending", "warn", { devices: "a1b2c3d4" }),
    c("permissions", "ok", "pass", { os: "macos" }),
    c("drivers", "not_needed", "skip", { os: "macos" }),
    c("mdns", "ok", "pass", {
      version: "mdns daemon version [adb discovery 0.0.0]",
    }),
  ];
}

const handlers: MockHandlers = {
  diagnostics_run: async (): Promise<DiagnosticsReport> => {
    await sleep(450);
    return {
      checkedAt: Date.now(),
      checks: checks(),
      facts: {
        os: "macos",
        adbPath: "/Users/me/Library/Android/sdk/platform-tools/adb",
        adbVersion: "37.0.1-15733141",
        clientVersion: 41,
        serverVersion: 41,
        serverError: null,
        serverPort: 5037,
        process: {
          pid: 85118,
          binary: "/Users/me/Library/Android/sdk/platform-tools/adb",
          uptimeSecs: 372,
        },
        startedByUs: true,
        serverDrops: 3,
        serverLog: [],
        devices: scenario === "empty" ? [] : MOCK_DEVICES,
        usb: {
          supported: true,
          devices: [
            {
              vendorId: 0x18d1,
              productId: 0x4ee7,
              manufacturer: "Google",
              product: "Pixel 8 Pro",
              serial: "38121FDJH00A4B",
              location: "USB 3.1 Bus",
              speed: "480 Mb/s",
              androidVendor: "Google",
            },
          ],
        },
        mdns: "mdns daemon version [adb discovery 0.0.0]",
        udevRules: null,
      },
    };
  },
};

export default handlers;
