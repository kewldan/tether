import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { create } from "zustand";

import { type DeviceSnapshot, deviceSnapshot } from "@/features/overview/api";

/** How often the snapshot refreshes while the window is visible. */
export const SNAPSHOT_INTERVAL = 3000;
/** Samples kept per device for sparklines and charge rate (~1 hour). */
const MAX_SAMPLES = 1200;

export interface Sample {
  at: number;
  battery: number | null;
  memoryUsed: number | null;
}

interface SamplesState {
  samples: Record<string, Sample[]>;
  push: (serial: string, sample: Sample) => void;
}

/** In-memory history of snapshot samples, per device. */
export const useSnapshotSamples = create<SamplesState>()((set) => ({
  samples: {},
  push: (serial, sample) =>
    set((s) => {
      const list = s.samples[serial] ?? [];
      if (list.at(-1)?.at === sample.at) return s;
      const next = [...list, sample];
      if (next.length > MAX_SAMPLES) next.splice(0, next.length - MAX_SAMPLES);
      return { samples: { ...s.samples, [serial]: next } };
    }),
}));

/**
 * Live device snapshot (battery, storage, memory, CPU, display, network…),
 * refreshed every few seconds while the window is visible. Shared by the
 * Overview page and anything else that wants device vitals (e.g. battery
 * in the status bar): all callers share one query per serial.
 */
export function useDeviceSnapshot(
  serial: string | null,
  {
    live = true,
  }: {
    /** false keeps the last snapshot without polling (device offline). */
    live?: boolean;
  } = {},
) {
  const query = useQuery({
    queryKey: ["device-snapshot", serial],
    queryFn: () =>
      serial ? deviceSnapshot(serial) : Promise.reject(new Error("no device")),
    enabled: serial !== null && live,
    refetchInterval: SNAPSHOT_INTERVAL,
    refetchIntervalInBackground: false,
    staleTime: SNAPSHOT_INTERVAL - 500,
    retry: false,
  });

  const data = query.data;
  useEffect(() => {
    if (!serial || !data) return;
    useSnapshotSamples.getState().push(serial, toSample(data));
  }, [serial, data]);

  return query;
}

function toSample(s: DeviceSnapshot): Sample {
  return {
    at: s.takenAt,
    battery: s.battery?.level ?? null,
    memoryUsed: s.memory
      ? (s.memory.totalBytes - s.memory.availableBytes) / s.memory.totalBytes
      : null,
  };
}

/**
 * Battery change in %/min over the last ~10 minutes of samples, or null
 * when there is not enough history yet.
 */
export function chargeRate(samples: Sample[]): number | null {
  const withLevel = samples.filter((s) => s.battery !== null);
  const last = withLevel.at(-1);
  if (!last || last.battery === null) return null;
  const from = withLevel.find((s) => last.at - s.at <= 10 * 60_000);
  if (!from || from.battery === null) return null;
  const minutes = (last.at - from.at) / 60_000;
  if (minutes < 2) return null;
  return (last.battery - from.battery) / minutes;
}
