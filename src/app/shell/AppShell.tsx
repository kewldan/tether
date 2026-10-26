import { Suspense, useEffect, useState } from "react";

import { useNavigation } from "@/app/navigation";
import { preloadSections, SECTIONS } from "@/app/sections";
import { CommandPalette } from "@/app/shell/CommandPalette";
import { Sidebar } from "@/app/shell/Sidebar";
import { StatusBar } from "@/app/shell/StatusBar";
import { Titlebar } from "@/app/shell/Titlebar";
import { ApkInstallHost } from "@/features/apps";
import { ConnectSheet } from "@/features/devices/ConnectSheet";
import { DeviceGate } from "@/features/devices/DeviceGate";
import { useDeviceShortcuts } from "@/features/devices/useDeviceShortcuts";
import { NotificationsHost } from "@/features/notifications/NotificationsHost";
import { usePortRulesAutoRestore } from "@/features/ports/queries";
import { useSettings } from "@/lib/settings";
import { useShortcut } from "@/lib/shortcuts";

/** Titlebar, sidebar, the active page and the status bar. */
export function AppShell() {
  const section = useNavigation((s) => s.section);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const Page = SECTIONS[section].page;
  useDeviceShortcuts();
  // Re-applies saved port rules whenever a device (re)connects.
  usePortRulesAutoRestore();

  useEffect(() => {
    const timer = setTimeout(preloadSections, 300);
    return () => clearTimeout(timer);
  }, []);

  useShortcut("palette", () => setPaletteOpen((open) => !open));
  useShortcut("sidebar", () => useSettings.getState().toggleSidebar());
  useShortcut("settings", () => useNavigation.getState().navigate("settings"));
  useShortcut("theme", () => {
    const dark = document.documentElement.classList.contains("dark");
    useSettings.getState().setTheme(dark ? "light" : "dark");
  });

  return (
    <div className="flex h-full flex-col">
      <Titlebar onOpenPalette={() => setPaletteOpen(true)} />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="bg-background min-w-0 flex-1">
          <Suspense fallback={null}>
            <DeviceGate section={section}>
              <Page />
            </DeviceGate>
          </Suspense>
        </main>
      </div>
      <StatusBar />
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      <ConnectSheet />
      <ApkInstallHost />
      <NotificationsHost />
    </div>
  );
}
