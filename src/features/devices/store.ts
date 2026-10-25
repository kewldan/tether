import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { AppError, Device } from "@/lib/tauri";

interface DevicesState {
  devices: Device[];
  /** Set while the adb server is unreachable; cleared by the next list. */
  error: AppError | null;
  /** True until the first device list arrives. */
  loading: boolean;
  /**
   * The device the workspace shows. Kept when the device disconnects, so
   * pages can show the "disconnected" state and recover on reconnect.
   */
  selectedSerial: string | null;
  /**
   * Last known record of every device seen this session, keyed by serial;
   * lets the UI name a device after it disappeared.
   */
  snapshots: Record<string, Device>;
  /** When each serial was last online in the list (ms since epoch). */
  lastSeen: Record<string, number>;
  select: (serial: string | null) => void;
  setDevices: (devices: Device[]) => void;
  setError: (error: AppError) => void;
}

export const useDevices = create<DevicesState>()(
  persist(
    (set, get) => ({
      devices: [],
      error: null,
      loading: true,
      selectedSerial: null,
      snapshots: {},
      lastSeen: {},
      select: (selectedSerial) => set({ selectedSerial }),
      setDevices: (devices) => {
        const { selectedSerial, snapshots, lastSeen } = get();
        const now = Date.now();
        const nextSnapshots = { ...snapshots };
        const nextSeen = { ...lastSeen };
        for (const d of devices) {
          nextSnapshots[d.serial] = d;
          // An offline device keeps the time it was last usable.
          if (d.state.kind !== "offline") nextSeen[d.serial] = now;
        }
        // Keep a selection that is connected or was seen this session (it
        // is then "disconnected" and recovers on reconnect); otherwise
        // auto-select the first ready device.
        const keep =
          selectedSerial !== null &&
          (devices.some((d) => d.serial === selectedSerial) ||
            selectedSerial in snapshots);
        const fallback =
          devices.find((d) => d.state.kind === "device") ?? devices[0];
        set({
          devices,
          error: null,
          loading: false,
          snapshots: nextSnapshots,
          lastSeen: nextSeen,
          selectedSerial: keep ? selectedSerial : (fallback?.serial ?? null),
        });
      },
      setError: (error) => set({ error, loading: false }),
    }),
    {
      name: "tether.devices",
      partialize: (s) => ({ selectedSerial: s.selectedSerial }),
    },
  ),
);

/** The selected device, or null when none is selected or it is gone. */
export function useSelectedDevice(): Device | null {
  return useDevices(
    (s) => s.devices.find((d) => d.serial === s.selectedSerial) ?? null,
  );
}

/** Serial of the selected device if it is connected and authorized. */
export function useReadySerial(): string | null {
  const device = useSelectedDevice();
  return device?.state.kind === "device" ? device.serial : null;
}

/**
 * The selected device even after it disconnected: `device` is the live
 * record or the last known one, `gone` is true while it is missing from
 * the list or offline, `since` is when it was last seen.
 */
export function useSelectedSnapshot(): {
  device: Device | null;
  gone: boolean;
  since: number | null;
} {
  const live = useSelectedDevice();
  const snapshot = useDevices((s) =>
    s.selectedSerial ? (s.snapshots[s.selectedSerial] ?? null) : null,
  );
  const since = useDevices((s) =>
    s.selectedSerial ? (s.lastSeen[s.selectedSerial] ?? null) : null,
  );
  const device = live ?? snapshot;
  const gone =
    device !== null && (live === null || live.state.kind === "offline");
  return { device, gone, since: gone ? since : null };
}
