import { useEffect } from "react";

import { useDevices } from "@/features/devices/store";
import { type AppError, watchDevices } from "@/lib/tauri";

/** Subscribes to the backend device stream; mount once at the app root. */
export function useDeviceTracking(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const { setDevices, setError } = useDevices.getState();
    // The backend keeps a single watcher and replaces it on resubscribe, so
    // a StrictMode double mount is harmless; `active` drops stale events.
    watchDevices((event) => {
      if (!active) return;
      if (event.type === "devices") setDevices(event.devices);
      else setError(event.error);
    }).catch((error: AppError) => active && setError(error));
    return () => {
      active = false;
    };
  }, [enabled]);
}
