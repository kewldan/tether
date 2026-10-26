import { channel, type MockHandlers } from "@/dev/mockBackend";
import type { TrayConfig, TrayEvent } from "@/features/notifications/api";

/**
 * Tray and notification plugin mocks. There is no tray in the browser:
 * `tray_sync` logs the menu it would show, and `window.mockTray(event)`
 * fakes a menu click, e.g.
 * `mockTray({ type: "screenshot", serial: "38121FDJH00A4B" })`.
 * System notifications are logged instead of shown. Device toasts:
 * `?mock=disconnect`; crash toasts: open Logcat once, the mock shop app
 * crashes every ~25 s.
 */
let push: ((event: TrayEvent) => void) | null = null;
let lastMenu = "";

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
