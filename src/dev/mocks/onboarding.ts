import { channel, type MockHandlers, sleep } from "@/dev/mockBackend";
import { scenario } from "@/dev/mocks/devices";
import type { AdbScan, InstallProgress } from "@/features/onboarding/api";
import type { AdbInstall } from "@/lib/tauri";

/**
 * adb lookup, platform-tools download, server and Tauri plugin mocks.
 * `?mock=no-adb` makes the search find nothing (until a download).
 */
const FOUND: AdbInstall = {
  path: "/Users/me/Library/Android/sdk/platform-tools/adb",
  source: "known_location",
  version: "37.0.1-15733141",
};
const BUNDLED: AdbInstall = {
  path: "/Users/me/Library/Application Support/dev.kewldan.tether/platform-tools/adb",
  source: "bundled",
  version: "37.0.1-15733141",
};

let downloaded = false;
let cancelled = false;

function scan(): AdbScan {
  const missing = scenario === "no-adb" && !downloaded;
  return {
    checks: [
      {
        kind: "path",
        source: "path",
        paths: ["/usr/bin/adb", "/bin/adb"],
        found: null,
        status: "missing",
      },
      {
        kind: "android_home",
        source: "android_home",
        paths: [],
        found: null,
        status: "not_set",
      },
      {
        kind: "studio_sdk",
        source: "known_location",
        paths: ["/Users/me/Library/Android/sdk/platform-tools/adb"],
        found: missing ? null : FOUND.path,
        status: missing ? "missing" : "found",
      },
      {
        kind: "homebrew",
        source: "known_location",
        paths: ["/opt/homebrew/bin/adb", "/usr/local/bin/adb"],
        found: null,
        status: "missing",
      },
      {
        kind: "bundled",
        source: "bundled",
        paths: [BUNDLED.path],
        found: downloaded ? BUNDLED.path : null,
        status: downloaded ? "found" : "missing",
      },
    ],
    install: missing ? null : downloaded ? BUNDLED : FOUND,
  };
}

const handlers: MockHandlers = {
  adb_scan: async () => {
    await sleep(120);
    return scan();
  },
  locate_adb: () => scan().install,
  adb_use_path: ({ path }) => {
    if (!String(path).endsWith("adb")) {
      throw {
        kind: "invalid_input",
        message: `${path} is not a working adb`,
        hint: null,
      };
    }
    return { path, source: "settings", version: "36.0.0-13206524" };
  },
  adb_key_fingerprint: () => "5F:2A:9C:11:3B:7D:20:AA:41:C2:9E:08:6F:D3:E1:07",
  adb_server_status: () => ({
    running: true,
    version: 41,
    port: 5037,
    startedByUs: true,
    uptimeSecs: 372,
    binary: FOUND.path,
  }),
  adb_ensure_server: async () => {
    await sleep(500);
    return 41;
  },
  adb_restart_server: async () => {
    await sleep(1200);
    return 41;
  },
  install_platform_tools: async ({ onEvent }) => {
    const send = channel<InstallProgress>(onEvent);
    cancelled = false;
    const total = 10.4 * 1024 * 1024;
    for (let i = 0; i <= 20; i++) {
      if (cancelled)
        throw {
          kind: "cancelled",
          message: "operation was cancelled",
          hint: null,
        };
      send({ type: "downloading", downloaded: (total * i) / 20, total });
      await sleep(110);
    }
    send({ type: "extracting" });
    await sleep(900);
    downloaded = true;
    return BUNDLED;
  },
  cancel_platform_tools_install: () => {
    cancelled = true;
    return null;
  },
  // Tauri plugins used by these features.
  "plugin:path|resolve_directory": () =>
    "/Users/me/Library/Application Support/dev.kewldan.tether",
  "plugin:path|join": ({ paths }) => (paths as string[]).join("/"),
  "plugin:dialog|open": () => "/opt/android/platform-tools/adb",
  "plugin:opener|open_url": ({ url }) => {
    window.open(String(url), "_blank");
    return null;
  },
  "plugin:opener|reveal_item_in_dir": () => null,
  "plugin:app|version": () => "0.1.0",
};

export default handlers;
