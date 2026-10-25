import { useQuery } from "@tanstack/react-query";

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
