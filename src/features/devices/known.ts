import { create } from "zustand";
import { persist } from "zustand/middleware";

/** A Wi-Fi address the user connected to; powers "Recent" and reconnects. */
export interface WifiEntry {
  address: string;
  /** Device name at the time it was connected. */
  name: string | null;
  lastConnected: number;
}

interface KnownState {
  /** Local names from "Rename…", keyed by serial. Never sent to devices. */
  aliases: Record<string, string>;
  /** Keyed by `ip:port`. */
  wifi: Record<string, WifiEntry>;
  setAlias: (serial: string, name: string | null) => void;
  rememberWifi: (address: string, name: string | null) => void;
  forgetWifi: (address: string) => void;
}

export const useKnownDevices = create<KnownState>()(
  persist(
    (set) => ({
      aliases: {},
      wifi: {},
      setAlias: (serial, name) =>
        set((s) => {
          const aliases = { ...s.aliases };
          const trimmed = name?.trim();
          if (trimmed) aliases[serial] = trimmed;
          else delete aliases[serial];
          return { aliases };
        }),
      rememberWifi: (address, name) =>
        set((s) => ({
          wifi: {
            ...s.wifi,
            [address]: {
              address,
              name: name ?? s.wifi[address]?.name ?? null,
              lastConnected: Date.now(),
            },
          },
        })),
      forgetWifi: (address) =>
        set((s) => {
          const wifi = { ...s.wifi };
          delete wifi[address];
          return { wifi };
        }),
    }),
    { name: "tether.known-devices" },
  ),
);

/** `192.168.1.42:5555`-style serials can be reconnected by address. */
export function isAddressSerial(serial: string): boolean {
  return /^[\d.]+:\d+$/.test(serial) || /^\[[\da-f:]+\]:\d+$/i.test(serial);
}

/** Wi-Fi history, most recent first. */
export function recentWifi(wifi: Record<string, WifiEntry>): WifiEntry[] {
  return Object.values(wifi).sort((a, b) => b.lastConnected - a.lastConnected);
}
