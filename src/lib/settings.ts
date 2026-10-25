import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ThemePreference = "dark" | "light" | "system";
export type Language = "en" | "ru" | "system";
export type Density = "comfortable" | "compact";

interface SettingsState {
  theme: ThemePreference;
  language: Language;
  density: Density;
  sidebarCollapsed: boolean;
  setTheme: (theme: ThemePreference) => void;
  setLanguage: (language: Language) => void;
  setDensity: (density: Density) => void;
  toggleSidebar: () => void;
}

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
    }),
    { name: "tether.settings" },
  ),
);
