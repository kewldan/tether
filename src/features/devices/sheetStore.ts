import { create } from "zustand";

export type ConnectTab = "qr" | "code" | "ip" | "legacy";

interface ConnectSheetState {
  open: boolean;
  tab: ConnectTab;
  /** Opens the "Connect over Wi-Fi" sheet, optionally on a given tab. */
  show: (tab?: ConnectTab) => void;
  setTab: (tab: ConnectTab) => void;
  close: () => void;
}

/** The Wi-Fi sheet is mounted once in the shell and opened from anywhere. */
export const useConnectSheet = create<ConnectSheetState>()((set) => ({
  open: false,
  tab: "qr",
  show: (tab) => set((s) => ({ open: true, tab: tab ?? s.tab })),
  setTab: (tab) => set({ tab }),
  close: () => set({ open: false }),
}));
