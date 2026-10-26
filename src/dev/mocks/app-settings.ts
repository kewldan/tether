import { type MockHandlers, sleep } from "@/dev/mockBackend";
import { scenario } from "@/dev/mocks/devices";

/**
 * Open at login (autostart plugin) and the platform-tools version check.
 * The mocked adb is 37.0.1; `?mock=adb-current` reports no update.
 */
let autostart = false;

const handlers: MockHandlers = {
  "plugin:autostart|is_enabled": () => autostart,
  "plugin:autostart|enable": () => {
    autostart = true;
    return null;
  },
  "plugin:autostart|disable": () => {
    autostart = false;
    return null;
  },
  login_launch_settle: () => false,
  platform_tools_latest: async () => {
    await sleep(300);
    const latest = scenario === "adb-current" ? "37.0.1" : "37.0.2";
    return {
      latest,
      current: "37.0.1-15733141",
      updateAvailable: latest !== "37.0.1",
    };
  },
};

export default handlers;
