import { useNavigation } from "@/app/navigation";
import type { SectionId } from "@/app/sections";
import { useDevices } from "@/features/devices/store";
import { useFilesPrefs } from "@/features/files/store";
import { type ThemePreference, useSettings } from "@/lib/settings";

/**
 * Dev-only remote control for shooting README screenshots and GIFs.
 * Enabled with `VITE_DEMO=1` in `tauri dev` or the browser preview: the app
 * polls `/.demo/command.json` from the Vite dev server and applies every new
 * command. A script outside the app writes that file and captures the
 * window between commands.
 *
 * Command shape: { "id": 3, "section": "logcat", "params": {…},
 *   "device": "38121FDJH00A4B", "theme": "light", "sidebar": true,
 *   "keys": [{ "key": "k", "meta": true }] }
 */
interface DemoCommand {
  id: number;
  section?: SectionId;
  params?: Record<string, string>;
  device?: string;
  theme?: ThemePreference;
  sidebarCollapsed?: boolean;
  keys?: { key: string; meta?: boolean; ctrl?: boolean; shift?: boolean }[];
  text?: string;
  click?: string;
  filesLayout?: "single" | "split";
  /** Clicks the first button whose text contains this string. */
  clickText?: string;
}

export function startDemoDriver() {
  let last = -1;
  const apply = (cmd: DemoCommand) => {
    if (cmd.theme) useSettings.getState().setTheme(cmd.theme);
    if (cmd.sidebarCollapsed !== undefined) {
      const { sidebarCollapsed, toggleSidebar } = useSettings.getState();
      if (sidebarCollapsed !== cmd.sidebarCollapsed) toggleSidebar();
    }
    if (cmd.device) useDevices.getState().select(cmd.device);
    if (cmd.filesLayout) useFilesPrefs.getState().setLayout(cmd.filesLayout);
    if (cmd.section) {
      useNavigation.getState().navigate(cmd.section, cmd.params ?? {});
    }
    for (const k of cmd.keys ?? []) {
      (document.activeElement ?? window).dispatchEvent(
        new KeyboardEvent("keydown", {
          key: k.key,
          code: `Key${k.key.toUpperCase()}`,
          metaKey: k.meta,
          ctrlKey: k.ctrl,
          shiftKey: k.shift,
          bubbles: true,
        }),
      );
    }
    if (cmd.click) {
      document.querySelector<HTMLElement>(cmd.click)?.click();
    }
    if (cmd.clickText) {
      const match = [...document.querySelectorAll<HTMLElement>("button")].find(
        (b) => b.textContent?.includes(cmd.clickText ?? ""),
      );
      match?.click();
    }
    if (cmd.text !== undefined) {
      const input = document.activeElement;
      if (input instanceof HTMLInputElement) {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )?.set;
        setter?.call(input, cmd.text);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }
  };

  setInterval(async () => {
    try {
      const res = await fetch(`/.demo/command.json?t=${Date.now()}`);
      if (!res.ok) return;
      const cmd = (await res.json()) as DemoCommand;
      if (cmd.id === last) return;
      last = cmd.id;
      apply(cmd);
    } catch {
      // No command file yet.
    }
  }, 150);
}
