import { useEffect, useState } from "react";

import { type AppError, type Device, watchDevices } from "@/lib/tauri";

export interface DevicesSnapshot {
  devices: Device[];
  /** Set while the adb server is unreachable; cleared on the next list. */
  error: AppError | null;
  loading: boolean;
}

export function useDevices(enabled: boolean): DevicesSnapshot {
  const [snapshot, setSnapshot] = useState<DevicesSnapshot>({
    devices: [],
    error: null,
    loading: true,
  });

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    // The backend keeps a single watcher and replaces it on resubscribe, so
    // a StrictMode double mount is harmless; `active` drops stale events.
    watchDevices((event) => {
      if (!active) return;
      if (event.type === "devices") {
        setSnapshot({ devices: event.devices, error: null, loading: false });
      } else {
        setSnapshot((s) => ({ ...s, error: event.error, loading: false }));
      }
    }).catch((error: AppError) => {
      if (active) setSnapshot((s) => ({ ...s, error, loading: false }));
    });
    return () => {
      active = false;
    };
  }, [enabled]);

  return snapshot;
}
