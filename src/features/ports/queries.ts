import {
  type QueryClient,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { useDevices, useReadySerial } from "@/features/devices/store";
import { errorMessage } from "@/features/performance/common";
import {
  addPort,
  hostPortUsage,
  listPorts,
  type PortRule,
} from "@/features/ports/api";
import { usePortsStore } from "@/features/ports/store";

export const portsKey = (serial: string | null) => ["ports", serial] as const;

/** Forward and reverse rules active on a device; polled every 5 s. */
export function usePortRules(serial: string | null) {
  return useQuery({
    queryKey: portsKey(serial),
    queryFn: () => (serial ? listPorts(serial) : Promise.reject()),
    enabled: serial !== null,
    refetchInterval: 5000,
  });
}

/**
 * Connections and listening process of host ports, by port. Polled every
 * 3 s while the Ports page shows them.
 */
export function useHostPortUsage(ports: number[]) {
  const sorted = [...new Set(ports)].sort((a, b) => a - b);
  const { data } = useQuery({
    queryKey: ["ports-host-usage", sorted.join(",")],
    queryFn: () => hostPortUsage(sorted),
    enabled: sorted.length > 0,
    refetchInterval: 3000,
  });
  return new Map((data ?? []).map((u) => [u.port, u] as const));
}

/**
 * Active rules of the selected device, for the status bar: forward rules
 * (this computer → device) and reverse rules (device → this computer).
 */
export function useActiveForwards(): {
  forward: PortRule[];
  reverse: PortRule[];
} {
  const serial = useReadySerial();
  const { data } = usePortRules(serial);
  return {
    forward: data?.forward ?? [],
    reverse: data?.reverse ?? [],
  };
}

const restoring = new Set<string>();

/** Re-applies saved rules that are missing on the device. */
export async function restoreRules(serial: string, queryClient: QueryClient) {
  const saved = usePortsStore.getState().saved[serial] ?? [];
  if (saved.length === 0 || restoring.has(serial)) return;
  restoring.add(serial);
  try {
    const current = await listPorts(serial);
    const active = [...current.forward, ...current.reverse];
    const { setError } = usePortsStore.getState();
    for (const rule of saved) {
      const present = active.some(
        (r) => r.direction === rule.direction && r.local === rule.local,
      );
      if (present) continue;
      try {
        await addPort(serial, rule.direction, rule.local, rule.remote);
        setError(serial, rule.direction, rule.local, null);
      } catch (e) {
        setError(serial, rule.direction, rule.local, errorMessage(e));
      }
    }
    await queryClient.invalidateQueries({ queryKey: portsKey(serial) });
  } catch {
    // Device went away again; the next reconnect retries.
  } finally {
    restoring.delete(serial);
  }
}

/**
 * Re-applies each device's saved rules whenever it becomes ready (adb drops
 * forwards on disconnect). Mount once, e.g. in the app shell; the Ports
 * page mounts it too.
 */
export function usePortRulesAutoRestore() {
  const queryClient = useQueryClient();
  const devices = useDevices((s) => s.devices);
  const ready = useRef(new Set<string>());
  useEffect(() => {
    const now = new Set(
      devices.filter((d) => d.state.kind === "device").map((d) => d.serial),
    );
    for (const serial of now) {
      if (!ready.current.has(serial)) void restoreRules(serial, queryClient);
    }
    ready.current = now;
  }, [devices, queryClient]);
}
