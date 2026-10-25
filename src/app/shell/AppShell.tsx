import { Suspense, useEffect, useState } from "react";

import { useNavigation } from "@/app/navigation";
import { SECTIONS } from "@/app/sections";
import { CommandPalette } from "@/app/shell/CommandPalette";
import { Sidebar } from "@/app/shell/Sidebar";
import { StatusBar } from "@/app/shell/StatusBar";
import { Titlebar } from "@/app/shell/Titlebar";
import { ApkInstallHost } from "@/features/apps";
import { ConnectSheet } from "@/features/devices/ConnectSheet";
import { DeviceGate } from "@/features/devices/DeviceGate";
import { useDeviceShortcuts } from "@/features/devices/useDeviceShortcuts";
import { usePortRulesAutoRestore } from "@/features/ports/queries";
import { hasMod } from "@/lib/platform";
import { useSettings } from "@/lib/settings";

/** Titlebar, sidebar, the active page and the status bar. */
export function AppShell() {
  const section = useNavigation((s) => s.section);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const Page = SECTIONS[section].page;
  useDeviceShortcuts();
  // Re-applies saved port rules whenever a device (re)connects.
  usePortRulesAutoRestore();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!hasMod(e)) return;
      const key = e.key.toLowerCase();
      if (key === "k") {
        e.preventDefault();
        setPaletteOpen((open) => !open);
      } else if (key === "b") {
        e.preventDefault();
        useSettings.getState().toggleSidebar();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
    </div>
  );
}
