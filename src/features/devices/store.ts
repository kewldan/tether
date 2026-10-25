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
      select: (selectedSerial) => set({ selectedSerial }),
      setDevices: (devices) => {
        const { selectedSerial } = get();
        // Auto-select the first ready device when nothing usable is chosen.
        const keep =
          selectedSerial !== null &&
          (devices.some((d) => d.serial === selectedSerial) ||
            get().devices.some((d) => d.serial === selectedSerial));
        const fallback =
          devices.find((d) => d.state.kind === "device") ?? devices[0];
        set({
          devices,
          error: null,
          loading: false,
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
