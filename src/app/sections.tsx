import {
  Bug,
  FolderClosed,
  Gauge,
  HardDriveDownload,
  Images,
  LayoutDashboard,
  LayoutGrid,
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

type PageModule = { default: ComponentType };
type LazyPage = ComponentType & {
  preload: () => Promise<PageModule>;
};

/**
 * A lazily loaded page that can be preloaded. Once its module has loaded,
 * it renders synchronously; plain `React.lazy` would still suspend once on
 * first render and flash an empty page when switching sections.
 */
function lazyPage(load: () => Promise<PageModule>): LazyPage {
  let loaded: ComponentType | null = null;
  let pending: Promise<PageModule> | null = null;
  const preload = () => {
    pending ??= load().then((module) => {
      loaded = module.default;
      return module;
    });
    return pending;
  };
  const Lazy = lazy(preload);
  // biome-ignore lint/correctness/noComponentHookFactories: called once per section at module load, never during render
  function Page() {
    const Loaded = loaded;
    return Loaded ? <Loaded /> : <Lazy />;
  }
  return Object.assign(Page, { preload });
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
  "multi-device": {
    icon: LayoutGrid,
    group: "app",
    page: lazyPage(() => import("@/features/multi-device/MultiDevicePage")),
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
