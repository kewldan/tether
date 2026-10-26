import { useQueryClient } from "@tanstack/react-query";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { create } from "zustand";

import {
  type RecordEvent,
  startMirrorRecording,
  stopMirrorRecording,
} from "@/features/mirror/api";
import type { Capture } from "@/features/overview/api";
import { CAPTURES_QUERY } from "@/features/overview/captureActions";
import { fileStamp } from "@/features/overview/format";
import { recordHistory } from "@/features/overview/history";
import i18n from "@/lib/i18n";
import { os } from "@/lib/platform";
import type { AppError } from "@/lib/tauri";

export interface MirrorRecording {
  name: string;
  path: string;
  /** Folder for display, e.g. `~/Pictures/Tether/Pixel 8/`. */
  dir: string;
  startedAt: number;
  /** File size so far (updated about once a second while frames come). */
  bytes: number;
  stopping: boolean;
}

interface RecordingsState {
  recordings: Record<string, MirrorRecording>;
  patch: (serial: string, patch: Partial<MirrorRecording> | null) => void;
}

/** Recordings of mirrored screens, per device (survive navigation). */
export const useMirrorRecordings = create<RecordingsState>()((set) => ({
  recordings: {},
  patch: (serial, patch) =>
    set((s) => {
      const recordings = { ...s.recordings };
      const current = recordings[serial];
      if (!patch) delete recordings[serial];
      else if (current) recordings[serial] = { ...current, ...patch };
      return { recordings };
    }),
}));

const t = (key: string, options?: Record<string, unknown>) =>
  i18n.t(key, { ns: "mirror", ...options });

/** Refreshes the Captures gallery; set by the mounted hook. */
let onSaved: () => void = () => {};

function saved(serial: string, capture: Capture) {
  recordHistory({
    serial,
    kind: "recording",
    label: capture.name,
    path: capture.path,
  });
  toast.success(t("recording.saved"), {
    description: capture.name,
    action: {
      label: t(`recording.reveal.${os}`),
      onClick: () => void revealItemInDir(capture.path).catch(() => {}),
    },
  });
  onSaved();
}

function failed(error: unknown) {
  const e = error as Partial<AppError> | undefined;
  toast.error(t("recording.failed"), {
    description: e?.message ?? String(error),
  });
}

function onEvent(serial: string, event: RecordEvent) {
  const store = useMirrorRecordings.getState();
  if (!store.recordings[serial]) return;
  if (event.type === "progress") {
    store.patch(serial, { bytes: event.bytes });
    return;
  }
  // Mirroring ended under the recording; the file is finished.
  store.patch(serial, null);
  if (event.capture) saved(serial, event.capture);
  else failed(event.error);
}

export async function startRecording(serial: string, deviceName: string) {
  const store = useMirrorRecordings.getState();
  if (store.recordings[serial]) return;
  try {
    const started = await startMirrorRecording(
      serial,
      deviceName,
      fileStamp(),
      (event) => onEvent(serial, event),
    );
    useMirrorRecordings.setState((s) => ({
      recordings: {
        ...s.recordings,
        [serial]: {
          ...started,
          startedAt: Date.now(),
          bytes: 0,
          stopping: false,
        },
      },
    }));
  } catch (error) {
    failed(error);
  }
}

export async function stopRecording(serial: string) {
  const store = useMirrorRecordings.getState();
  const current = store.recordings[serial];
  if (!current || current.stopping) return;
  store.patch(serial, { stopping: true });
  try {
    const capture = await stopMirrorRecording(serial);
    saved(serial, capture);
  } catch (error) {
    // Already reported if mirroring ended under the recording.
    if (useMirrorRecordings.getState().recordings[serial]) failed(error);
  } finally {
    useMirrorRecordings.getState().patch(serial, null);
  }
}

/** The recording of `serial` and a start/stop toggle for it. */
export function useMirrorRecording(serial: string | null, deviceName: string) {
  const queryClient = useQueryClient();
  const recording = useMirrorRecordings((s) =>
    serial ? (s.recordings[serial] ?? null) : null,
  );

  useEffect(() => {
    onSaved = () =>
      void queryClient.invalidateQueries({ queryKey: CAPTURES_QUERY });
  }, [queryClient]);

  const toggle = useCallback(() => {
    if (!serial) return;
    if (useMirrorRecordings.getState().recordings[serial]) {
      void stopRecording(serial);
    } else {
      void startRecording(serial, deviceName);
    }
  }, [serial, deviceName]);

  return { recording, toggle };
}

/** Current time, re-rendering every second while `active`. */
export function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

const pad = (n: number) => n.toString().padStart(2, "0");

/** `01:24`, `1:02:03` for the REC badge. */
export function formatTimer(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
