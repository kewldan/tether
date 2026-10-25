import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { SectionId } from "@/app/sections";

interface NavigationState {
  section: SectionId;
  /** Optional per-navigation payload, e.g. a package to focus in Logcat. */
  params: Record<string, string>;
  navigate: (section: SectionId, params?: Record<string, string>) => void;
}

export const useNavigation = create<NavigationState>()(
  persist(
    (set) => ({
      section: "overview",
      params: {},
      navigate: (section, params = {}) => set({ section, params }),
    }),
    { name: "tether.navigation", partialize: (s) => ({ section: s.section }) },
  ),
);
