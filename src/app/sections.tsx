import {
  Bug,
  FolderClosed,
  Gauge,
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
import { type ComponentType, lazy } from "react";

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
    page: lazy(() => import("@/features/overview/OverviewPage")),
  },
  screen: {
    icon: MonitorSmartphone,
    group: "device",
    page: lazy(() => import("@/features/mirror/MirrorPage")),
  },
  files: {
    icon: FolderClosed,
    group: "device",
    page: lazy(() => import("@/features/files/FilesPage")),
  },
  apps: {
    icon: Package,
    group: "device",
    page: lazy(() => import("@/features/apps/AppsPage")),
  },
  logcat: {
    icon: ScrollText,
    group: "device",
    page: lazy(() => import("@/features/logcat/LogcatPage")),
  },
  shell: {
    icon: SquareTerminal,
    group: "device",
    page: lazy(() => import("@/features/shell/ShellPage")),
  },
  performance: {
    icon: Gauge,
    group: "device",
    page: lazy(() => import("@/features/performance/PerformancePage")),
  },
  "device-settings": {
    icon: SlidersHorizontal,
    group: "device",
    page: lazy(() => import("@/features/device-settings/DeviceSettingsPage")),
  },
  // Tools (sidebar, needs a selected device)
  ports: {
    icon: Plug,
    group: "tools",
    page: lazy(() => import("@/features/ports/PortsPage")),
  },
  intents: {
    icon: Send,
    group: "tools",
    page: lazy(() => import("@/features/intents/IntentsPage")),
  },
  bugreport: {
    icon: Bug,
    group: "tools",
    page: lazy(() => import("@/features/bugreport/BugreportPage")),
  },
  // App-level pages (reached from the device switcher, palette, footer)
  devices: {
    icon: Smartphone,
    group: "app",
    page: lazy(() => import("@/features/devices/DevicesPage")),
  },
  diagnostics: {
    icon: Stethoscope,
    group: "app",
    page: lazy(() => import("@/features/diagnostics/DiagnosticsPage")),
  },
  gallery: {
    icon: Images,
    group: "app",
    page: lazy(() => import("@/features/gallery/GalleryPage")),
  },
  settings: {
    icon: Settings,
    group: "app",
    page: lazy(() => import("@/features/settings/SettingsPage")),
  },
} satisfies Record<
  string,
  {
    icon: LucideIcon;
    group: "device" | "tools" | "app";
    page: ComponentType;
  }
>;

export type SectionId = keyof typeof SECTIONS;

export const SECTION_IDS = Object.keys(SECTIONS) as SectionId[];
