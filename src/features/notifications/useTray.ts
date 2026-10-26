import { type QueryClient, useQueries } from "@tanstack/react-query";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { useKnownDevices } from "@/features/devices/known";
import { deviceName } from "@/features/devices/naming";
import { useDevices } from "@/features/devices/store";
import { takeScreenshot } from "@/features/overview/api";
import { CAPTURES_QUERY } from "@/features/overview/captureActions";
import { fileStamp } from "@/features/overview/format";
import { recordHistory } from "@/features/overview/history";
import i18n from "@/lib/i18n";
import { useSettings } from "@/lib/settings";
import { type AppError, type DeviceInfo, deviceInfo } from "@/lib/tauri";

import { type TrayConfig, traySync, trayWatch } from "./api";
import { deliver } from "./notify";

const STATE_KINDS = [
  "device",
  "unauthorized",
  "authorizing",
  "offline",
  "connecting",
  "no_permissions",
  "recovery",
  "rescue",
  "sideload",
  "bootloader",
  "host",
  "unknown",
] as const;

const t = (key: string, options?: Record<string, unknown>) =>
  i18n.t(key, { ns: "notifications", ...options });

/** "Screenshot of …" from the tray: same file, history and toast as Overview. */
async function trayScreenshot(serial: string, queryClient: QueryClient) {
  const device = useDevices.getState().devices.find((d) => d.serial === serial);
  const info = queryClient.getQueryData<DeviceInfo>(["device-info", serial]);
  const name = device ? deviceName(device, info) : serial;
  try {
    const capture = await takeScreenshot(serial, name, fileStamp());
    recordHistory({
      serial,
      kind: "screenshot",
      label: capture.name,
      path: capture.path,
    });
    void queryClient.invalidateQueries({ queryKey: CAPTURES_QUERY });
    deliver({
      toast: () =>
        toast.success(t("screenshot.saved"), {
          description: capture.name,
          action: {
            label: t("screenshot.show"),
            onClick: () => void revealItemInDir(capture.path).catch(() => {}),
          },
        }),
      system: {
        title: t("screenshot.saved"),
        body: capture.name,
        route: { kind: "file", path: capture.path },
      },
    });
  } catch (error) {
    const message = (error as Partial<AppError>)?.message ?? String(error);
    deliver({
      toast: () =>
        toast.error(t("screenshot.failed"), { description: message }),
      system: { title: t("screenshot.failed"), body: message },
    });
  }
}

/**
 * Keeps the tray menu in step with what only the webview knows (names,
 * the selected device, labels, preferences) and handles its clicks. The
 * device list itself reaches the tray straight from the Rust tracker.
 */
export function useTray(queryClient: QueryClient) {
  const { t: tn } = useTranslation("notifications");
  const { t: tc } = useTranslation("common");
  const devices = useDevices((s) => s.devices);
  const snapshots = useDevices((s) => s.snapshots);
  const selected = useDevices((s) => s.selectedSerial);
  const aliases = useKnownDevices((s) => s.aliases);
  const visible = useSettings((s) => s.trayIcon);
  const closeToTray = useSettings((s) => s.closeToTray);
  const infos = useQueries({
    queries: devices.map((d) => ({
      queryKey: ["device-info", d.serial],
      queryFn: () => deviceInfo(d.serial),
      enabled: d.state.kind === "device",
      staleTime: 5 * 60_000,
    })),
  });

  // Every device seen this session, so one that comes back offline after
  // a drop keeps its name before its info is fetched again.
  const live = new Map(devices.map((d, i) => [d.serial, infos[i]?.data]));
  const names: Record<string, string> = {};
  for (const d of Object.values(snapshots)) {
    const info =
      live.get(d.serial) ??
      queryClient.getQueryData<DeviceInfo>(["device-info", d.serial]);
    names[d.serial] =
      aliases[d.serial] ?? info?.avdName ?? info?.model ?? d.model ?? d.serial;
  }
  const config: TrayConfig = {
    visible,
    closeToTray,
    selected,
    names,
    labels: {
      open: tn("tray.open"),
      quit: tn("tray.quit"),
      screenshot: tn("tray.screenshot"),
      // The backend fills in the name.
      screenshotOf: tn("tray.screenshotOf", { name: "{name}" }),
      noDevices: tn("tray.noDevices"),
      states: Object.fromEntries(STATE_KINDS.map((k) => [k, tc(`state.${k}`)])),
    },
  };
  const key = JSON.stringify(config);

  useEffect(() => {
    void traySync(JSON.parse(key) as TrayConfig).catch(() => {});
  }, [key]);

  useEffect(() => {
    void trayWatch((event) => {
      if (event.type === "selectDevice")
        useDevices.getState().select(event.serial);
      else void trayScreenshot(event.serial, queryClient);
    }).catch(() => {});
  }, [queryClient]);
}
