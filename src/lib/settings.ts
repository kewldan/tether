import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ThemePreference = "dark" | "light" | "system";
export type Language = "en" | "ru" | "system";
export type Density = "comfortable" | "compact";
/** Which adb to use: first found ("system"), Tether's copy, or a path. */
export type AdbMode = "system" | "bundled" | "custom";
export type ReduceMotion = "system" | "on" | "off";

interface SettingsState {
  theme: ThemePreference;
  language: Language;
  density: Density;
  sidebarCollapsed: boolean;
  setTheme: (theme: ThemePreference) => void;
  setLanguage: (language: Language) => void;
  setDensity: (density: Density) => void;
  toggleSidebar: () => void;
  /** Set once the user finished (or skipped) the onboarding flow. */
  onboardingDone: boolean;
  adbMode: AdbMode;
  /** adb picked with "Choose path…" / "Custom…". */
  adbCustomPath: string | null;
  reduceMotion: ReduceMotion;
  /** Retry known Wi-Fi addresses every 10 s after a drop. */
  autoReconnect: boolean;
  /** Where screenshots and recordings go; null = the OS pictures folder. */
  capturesDir: string | null;
  /** Where pulled files go; null = the OS downloads folder. */
  downloadsDir: string | null;
  /** Notify when a device connects or disconnects. */
  notifyDevices: boolean;
  /** Notify when the Logcat stream catches an app crash or ANR. */
  notifyCrashes: boolean;
  /** Use system notifications while the window is in the background. */
  systemNotifications: boolean;
  /** Menu bar (macOS) / tray icon with the device list. */
  trayIcon: boolean;
  /** Closing the window hides it to the tray instead of quitting. */
  closeToTray: boolean;
  /** Opened at login: stay hidden in the tray (needs `trayIcon`). */
  startHidden: boolean;
  /** platform-tools version whose "update available" dot was dismissed. */
  platformToolsDismissed: string | null;
  /** Patch any of the fields above. */
  update: (patch: Partial<SettingsValues>) => void;
}

export type SettingsValues = Omit<
  SettingsState,
  "setTheme" | "setLanguage" | "setDensity" | "toggleSidebar" | "update"
>;

/** Per-machine UI preferences, kept in localStorage. */
export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      theme: "dark",
      language: "system",
      density: "comfortable",
      sidebarCollapsed: false,
      setTheme: (theme) => set({ theme }),
      setLanguage: (language) => set({ language }),
      setDensity: (density) => set({ density }),
      toggleSidebar: () =>
        set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      onboardingDone: false,
      adbMode: "system",
      adbCustomPath: null,
      reduceMotion: "system",
      autoReconnect: true,
      capturesDir: null,
      downloadsDir: null,
      notifyDevices: true,
      notifyCrashes: true,
      systemNotifications: true,
      trayIcon: true,
      closeToTray: false,
      startHidden: false,
      platformToolsDismissed: null,
      update: (patch) => set(patch),
    }),
    { name: "tether.settings" },
  ),
);

/** Arguments for `locate_adb` / `adb_scan` from the adb settings. */
export function adbLookupArgs() {
  const { adbMode, adbCustomPath } = useSettings.getState();
  return {
    customPath: adbMode === "custom" ? adbCustomPath : null,
    preferBundled: adbMode === "bundled",
  };
}
