import {
  Bug,
  FolderClosed,
  Gauge,
  HardDriveDownload,
  Images,
  LayoutDashboard,
  type LucideIcon,
  MonitorSmartphone,
  Package,
  Plug,
  ScrollText,
  Send,
  Settings,
  SlidersHorizontal,
  Smartphone,
  SquareTerminal,
  Stethoscope,
} from "lucide-react";
import { type ComponentType, type LazyExoticComponent, lazy } from "react";

type PageModule = { default: ComponentType };
type LazyPage = LazyExoticComponent<ComponentType> & {
  preload: () => Promise<PageModule>;
};

/** `lazy()` that can also be preloaded, so switching sections never flashes. */
function lazyPage(load: () => Promise<PageModule>): LazyPage {
  return Object.assign(lazy(load), { preload: load });
}

/**
 * Every page of the app. Each feature owns its page component under
 * `src/features/<feature>/`; this registry only wires ids, labels (keys in
 * the `common` namespace, `nav.<id>`) and sidebar placement.
 */
export const SECTIONS = {
  // Device workspace (sidebar, needs a selected device)
  overview: {
    icon: LayoutDashboard,
    group: "device",
    page: lazyPage(() => import("@/features/overview/OverviewPage")),
  },
  screen: {
    icon: MonitorSmartphone,
    group: "device",
    page: lazyPage(() => import("@/features/mirror/MirrorPage")),
  },
  files: {
    icon: FolderClosed,
    group: "device",
    page: lazyPage(() => import("@/features/files/FilesPage")),
  },
  apps: {
    icon: Package,
    group: "device",
    page: lazyPage(() => import("@/features/apps/AppsPage")),
  },
  logcat: {
    icon: ScrollText,
    group: "device",
    page: lazyPage(() => import("@/features/logcat/LogcatPage")),
  },
  shell: {
    icon: SquareTerminal,
    group: "device",
    page: lazyPage(() => import("@/features/shell/ShellPage")),
  },
  performance: {
    icon: Gauge,
    group: "device",
    page: lazyPage(() => import("@/features/performance/PerformancePage")),
  },
  "device-settings": {
    icon: SlidersHorizontal,
    group: "device",
    page: lazyPage(
      () => import("@/features/device-settings/DeviceSettingsPage"),
    ),
  },
  // Tools (sidebar, needs a selected device)
  ports: {
    icon: Plug,
    group: "tools",
    page: lazyPage(() => import("@/features/ports/PortsPage")),
  },
  intents: {
    icon: Send,
    group: "tools",
    page: lazyPage(() => import("@/features/intents/IntentsPage")),
  },
  bugreport: {
    icon: Bug,
    group: "tools",
    page: lazyPage(() => import("@/features/bugreport/BugreportPage")),
  },
  // App-level pages (reached from the device switcher, palette, footer)
  devices: {
    icon: Smartphone,
    group: "app",
    page: lazyPage(() => import("@/features/devices/DevicesPage")),
  },
  diagnostics: {
    icon: Stethoscope,
    group: "app",
    page: lazyPage(() => import("@/features/diagnostics/DiagnosticsPage")),
  },
  gallery: {
    icon: Images,
    group: "app",
    page: lazyPage(() => import("@/features/gallery/GalleryPage")),
  },
  sideload: {
    icon: HardDriveDownload,
    group: "app",
    page: lazyPage(() => import("@/features/sideload/SideloadPage")),
  },
  settings: {
    icon: Settings,
    group: "app",
    page: lazyPage(() => import("@/features/settings/SettingsPage")),
  },
} satisfies Record<
  string,
  {
    icon: LucideIcon;
    group: "device" | "tools" | "app";
    page: LazyPage;
  }
>;

export type SectionId = keyof typeof SECTIONS;

export const SECTION_IDS = Object.keys(SECTIONS) as SectionId[];

/** Loads every page's code in the background after startup. */
export function preloadSections() {
  for (const id of SECTION_IDS) void SECTIONS[id].page.preload();
}
