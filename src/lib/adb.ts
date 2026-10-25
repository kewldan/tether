import { create } from "zustand";

import type { AdbInstall } from "@/lib/tauri";

type AdbStatus =
  | { status: "searching" }
  | { status: "missing" }
  | { status: "found"; install: AdbInstall };

interface AdbState {
  adb: AdbStatus;
  setAdb: (adb: AdbStatus) => void;
}

/** Which adb binary the app uses; drives onboarding vs. the workspace. */
export const useAdb = create<AdbState>()((set) => ({
  adb: { status: "searching" },
  setAdb: (adb) => set({ adb }),
}));
