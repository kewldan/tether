import { useQuery } from "@tanstack/react-query";

import { deviceSummary } from "@/features/devices/api";
import { deviceInfo } from "@/lib/tauri";

/** getprop summary of a device; cached per serial. */
export function useDeviceInfo(serial: string | null) {
  return useQuery({
    queryKey: ["device-info", serial],
    queryFn: () => (serial ? deviceInfo(serial) : Promise.reject()),
    enabled: serial !== null,
    staleTime: 5 * 60_000,
  });
}

/** Battery / root / Wi-Fi address for the All devices cards. */
export function useDeviceSummary(serial: string | null) {
  return useQuery({
    queryKey: ["device-summary", serial],
    queryFn: () => (serial ? deviceSummary(serial) : Promise.reject()),
    enabled: serial !== null,
    refetchInterval: 30_000,
    staleTime: 10_000,
  });
}
