import {
  isPermissionGranted,
  onAction,
  registerActionTypes,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

import { useNavigation } from "@/app/navigation";
import { useDevices } from "@/features/devices/store";
import i18n from "@/lib/i18n";
import { useSettings } from "@/lib/settings";

import { isWindowFocused, onWindowFocusChange } from "./focus";

/** Where a click on a system notification leads. */
export type Route =
  | { kind: "device"; serial: string }
  | { kind: "logcat"; serial: string; package: string | null }
  | { kind: "file"; path: string };

export interface Notice {
  /** Shows the in-app toast. */
  toast: () => void;
  /** The system notification used while Tether is in the background. */
  system: { title: string; body?: string; route?: Route; crash?: boolean };
  /**
   * Shows the toast again when the user comes back to the window, so its
   * actions ("Open in Logcat") are still at hand.
   */
  replayOnFocus?: boolean;
}

const CRASH_ACTIONS = "tether-crash";
const OPEN_LOGCAT = "open-logcat";
/** Toasts replayed on focus: only recent ones, at most a few. */
const REPLAY_MAX_AGE = 15 * 60_000;
const REPLAY_MAX = 3;

let nextId = 1;
let permission: Promise<boolean> | null = null;
const replay: { at: number; toast: () => void }[] = [];

/**
 * Asks for notification permission once (desktop platforms grant it
 * without a prompt; the OS may still block Tether in its settings).
 */
export function ensurePermission(force = false): Promise<boolean> {
  if (!permission || force) {
    permission = (async () => {
      try {
        if (await isPermissionGranted()) return true;
        return (await requestPermission()) === "granted";
      } catch {
        return false;
      }
    })();
  }
  return permission;
}

/** Sends a system notification; resolves false when it couldn't be sent. */
export async function sendSystem(system: Notice["system"]): Promise<boolean> {
  if (!(await ensurePermission())) return false;
  try {
    sendNotification({
      id: nextId++,
      title: system.title,
      body: system.body,
      actionTypeId: system.crash ? CRASH_ACTIONS : undefined,
      // `focus: false`: the Rust click handler leaves the window alone.
      extra: { route: system.route, focus: system.route?.kind !== "file" },
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Shows a notice where the user will see it: a toast while the window is
 * focused (or system notifications are off), otherwise a system
 * notification.
 */
export function deliver(notice: Notice) {
  if (isWindowFocused() || !useSettings.getState().systemNotifications) {
    notice.toast();
    return;
  }
  void sendSystem(notice.system).then((sent) => {
    if (!sent) notice.toast();
    else if (notice.replayOnFocus) {
      replay.push({ at: Date.now(), toast: notice.toast });
      if (replay.length > REPLAY_MAX) replay.shift();
    }
  });
}

/** Acts on a click on a system notification (or its "Open in Logcat"). */
export function follow(route: Route) {
  const devices = useDevices.getState();
  switch (route.kind) {
    case "device":
      devices.select(route.serial);
      return;
    case "logcat":
      if (devices.selectedSerial !== route.serial) devices.select(route.serial);
      useNavigation
        .getState()
        .navigate("logcat", route.package ? { package: route.package } : {});
      return;
    case "file":
      void revealItemInDir(route.path).catch(() => {});
      return;
  }
}

function isRoute(value: unknown): value is Route {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    typeof value.kind === "string"
  );
}

async function registerActions() {
  await registerActionTypes([
    {
      id: CRASH_ACTIONS,
      actions: [
        {
          id: OPEN_LOGCAT,
          title: i18n.t("crash.openLogcat", { ns: "notifications" }),
        },
      ],
    },
  ]);
}

/**
 * Routes clicks on system notifications, registers their action buttons
 * and replays pending toasts on focus. Returns the cleanup.
 */
export function startSystemNotifications(): () => void {
  let unlisten: (() => void) | null = null;
  let disposed = false;

  void registerActions().catch(() => {});
  const onLanguage = () => void registerActions().catch(() => {});
  i18n.on("languageChanged", onLanguage);

  void onAction((event) => {
    const route = event.notification?.extra?.route;
    if (isRoute(route)) follow(route);
  })
    .then((listener) => {
      if (disposed) void listener.unregister();
      else unlisten = () => void listener.unregister();
    })
    .catch(() => {});

  const stopFocus = onWindowFocusChange((focused) => {
    if (!focused) return;
    const now = Date.now();
    const pending = replay.splice(0).filter((r) => now - r.at < REPLAY_MAX_AGE);
    // Let the window settle before the toasts slide in.
    setTimeout(() => {
      for (const r of pending) r.toast();
    }, 300);
  });

  return () => {
    disposed = true;
    unlisten?.();
    stopFocus();
    i18n.off("languageChanged", onLanguage);
  };
}
