import { useQueryClient } from "@tanstack/react-query";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { create } from "zustand";

import {
  type Capture,
  startRecording as startRecordingCmd,
  stopRecording as stopRecordingCmd,
  takeScreenshot,
} from "@/features/overview/api";
import { fileStamp } from "@/features/overview/format";
import { recordHistory } from "@/features/overview/history";
import i18n from "@/lib/i18n";
import type { AppError } from "@/lib/tauri";

export const CAPTURES_QUERY = ["captures"] as const;

interface Recording {
  startedAt: number;
  deviceName: string;
  stopping: boolean;
}

interface RecordingState {
  recordings: Record<string, Recording>;
  set: (serial: string, recording: Recording | null) => void;
}

/** Screen recordings in progress, per device (survives navigation). */
export const useRecordings = create<RecordingState>()((set) => ({
  recordings: {},
  set: (serial, recording) =>
    set((s) => {
      const recordings = { ...s.recordings };
      if (recording) recordings[serial] = recording;
      else delete recordings[serial];
      return { recordings };
    }),
}));

const t = (key: string, options?: Record<string, unknown>) =>
  i18n.t(key, { ns: "overview", ...options });

function errorText(error: unknown): string {
  const e = error as Partial<AppError> | undefined;
  return e?.message ?? String(error);
}

function savedToast(capture: Capture, title: string) {
  toast.success(title, {
    description: capture.name,
    action: {
      label: t("toast.show"),
      onClick: () => void revealItemInDir(capture.path).catch(() => {}),
    },
  });
}

async function finishRecording(serial: string, onSaved: () => void) {
  const store = useRecordings.getState();
  const rec = store.recordings[serial];
  if (!rec || rec.stopping) return;
  store.set(serial, { ...rec, stopping: true });
  try {
    const capture = await stopRecordingCmd(serial, rec.deviceName, fileStamp());
    recordHistory({
      serial,
      kind: "recording",
      label: capture.name,
      path: capture.path,
    });
    savedToast(capture, t("toast.recordingSaved"));
    onSaved();
  } catch (error) {
    toast.error(t("toast.recordingFailed"), {
      description: errorText(error),
    });
  } finally {
    useRecordings.getState().set(serial, null);
  }
}

/**
 * Screenshot and screen-recording actions for one device, used by the
 * Overview quick actions and the Captures page. Results land in the
 * captures folder, the Recent history and a toast.
 */
export function useCaptureActions(serial: string | null, deviceName: string) {
  const queryClient = useQueryClient();
  const [shooting, setShooting] = useState(false);
  const recording = useRecordings((s) =>
    serial ? (s.recordings[serial] ?? null) : null,
  );

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: CAPTURES_QUERY });
  }, [queryClient]);

  const screenshot = useCallback(async () => {
    if (!serial) return;
    setShooting(true);
    try {
      const capture = await takeScreenshot(serial, deviceName, fileStamp());
      recordHistory({
        serial,
        kind: "screenshot",
        label: capture.name,
        path: capture.path,
      });
      savedToast(capture, t("toast.screenshotSaved"));
      refresh();
      return capture;
    } catch (error) {
      toast.error(t("toast.screenshotFailed"), {
        description: errorText(error),
      });
    } finally {
      setShooting(false);
    }
  }, [serial, deviceName, refresh]);

  const toggleRecording = useCallback(async () => {
    if (!serial) return;
    if (useRecordings.getState().recordings[serial]) {
      await finishRecording(serial, refresh);
      return;
    }
    try {
      await startRecordingCmd(serial, (event) => {
        // screenrecord stopped on its own (time limit or error).
        if (event.type === "ended") void finishRecording(serial, refresh);
      });
      useRecordings
        .getState()
        .set(serial, { startedAt: Date.now(), deviceName, stopping: false });
    } catch (error) {
      toast.error(t("toast.recordingFailed"), {
        description: errorText(error),
      });
    }
  }, [serial, deviceName, refresh]);

  return { screenshot, shooting, recording, toggleRecording };
}
