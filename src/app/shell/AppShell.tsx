import { Suspense, useEffect, useState } from "react";

import { useNavigation } from "@/app/navigation";
import { SECTIONS } from "@/app/sections";
import { CommandPalette } from "@/app/shell/CommandPalette";
import { Sidebar } from "@/app/shell/Sidebar";
import { StatusBar } from "@/app/shell/StatusBar";
import { Titlebar } from "@/app/shell/Titlebar";
import { hasMod } from "@/lib/platform";
import { useSettings } from "@/lib/settings";

/** Titlebar, sidebar, the active page and the status bar. */
export function AppShell() {
  const section = useNavigation((s) => s.section);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const Page = SECTIONS[section].page;

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
            <Page />
          </Suspense>
        </main>
      </div>
      <StatusBar />
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}
