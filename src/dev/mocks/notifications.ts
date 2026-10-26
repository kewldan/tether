import { channel, type MockHandlers } from "@/dev/mockBackend";
import type {
  CrashAlert,
  TrayConfig,
  TrayEvent,
} from "@/features/notifications/api";

/**
 * Tray and notification plugin mocks. There is no tray in the browser:
 * `tray_sync` logs the menu it would show, and `window.mockTray(event)`
 * fakes a menu click, e.g.
 * `mockTray({ type: "screenshot", serial: "38121FDJH00A4B" })`.
 * System notifications are logged instead of shown. Device toasts:
 * `?mock=disconnect`. Crash toasts: the background crash watcher reports a
 * Telegram crash on the first watched device every ~40 s (on any page),
 * and the mock shop app in an open Logcat stream crashes every ~25 s.
 */
let push: ((event: TrayEvent) => void) | null = null;
let lastMenu = "";
let watchTimer: ReturnType<typeof setInterval> | null = null;
let watchPid = 6100;

const TELEGRAM = "org.telegram.messenger";

function telegramCrash(serial: string): CrashAlert {
  const now = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const pid = watchPid;
  watchPid += 137;
  return {
    serial,
    entry: {
      seq: 0,
      date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
      time: `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`,
      uid: "10224",
      pid,
      tid: pid,
      level: "E",
      tag: "AndroidRuntime",
      message: [
        "FATAL EXCEPTION: main",
        `Process: ${TELEGRAM}, PID: ${pid}`,
        "java.lang.NullPointerException: Attempt to invoke virtual method on a null object reference",
        "\tat org.telegram.ui.ChatActivity.onResume(ChatActivity.java:4211)",
        "\tat android.app.Activity.performResume(Activity.java:8735)",
      ].join("\n"),
      crash: {
        kind: "java",
        title:
          "java.lang.NullPointerException: Attempt to invoke virtual method on a null object reference",
        process: TELEGRAM,
        pid,
      },
    },
  };
}

(window as unknown as { mockTray: (e: TrayEvent) => void }).mockTray = (e) =>
  push?.(e);

class MockNotification {
  static permission: NotificationPermission = "granted";
  static requestPermission = async () => "granted" as const;
  constructor(title: string, options?: NotificationOptions) {
    console.info("[mock notification]", title, options);
  }
}
(window as unknown as { Notification: unknown }).Notification =
  MockNotification;

export default {
  tray_sync: ({ config }) => {
    const c = config as TrayConfig;
    const menu = JSON.stringify(c);
    if (menu !== lastMenu) console.info("[mock tray]", c);
    lastMenu = menu;
    return null;
  },
  tray_watch: ({ onEvent }) => {
    push = channel<TrayEvent>(onEvent);
    return null;
  },
  crash_watch: ({ serials, onEvent }) => {
    if (watchTimer) clearInterval(watchTimer);
    watchTimer = null;
    const list = serials as string[];
    const first = list[0];
    if (first === undefined) return null;
    const send = channel<CrashAlert>(onEvent);
    watchTimer = setInterval(() => send(telegramCrash(first)), 40_000);
    return null;
  },
  "plugin:notification|is_permission_granted": () => true,
  "plugin:notification|request_permission": () => "granted",
  "plugin:notification|notify": ({ options }) => {
    console.info("[mock notification]", options);
    return null;
  },
  "plugin:notification|register_action_types": () => null,
  "plugin:notification|register_listener": () => null,
  "plugin:notification|remove_listener": () => null,
} satisfies MockHandlers;
