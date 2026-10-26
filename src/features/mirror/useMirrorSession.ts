import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import {
  attachMirror,
  type ControlMessage,
  type MirrorEvent,
  type MirrorInfo,
  type MirrorOptions,
  sendControl,
  startMirror,
  stopMirror,
} from "@/features/mirror/api";
import { PcmPlayer } from "@/features/mirror/audio";
import { hasWebCodecs, VideoPipeline } from "@/features/mirror/decoder";
import { streamOptions, useMirrorSettings } from "@/features/mirror/store";
import type { AppError } from "@/lib/tauri";

export type MirrorStatus =
  | { kind: "idle" }
  | { kind: "noWebCodecs" }
  | { kind: "connecting" }
  | { kind: "streaming" }
  | { kind: "error"; reason: "start" | "codec" | "decode"; error: AppError }
  | { kind: "stopped"; error: AppError | null }
  /** Another window took the session over. */
  | { kind: "detached" };

export interface VideoSize {
  width: number;
  height: number;
}

/** Restarting on every slider tick would be wasteful. */
const START_DELAY = 250;

function asAppError(e: unknown): AppError {
  if (e && typeof e === "object" && "message" in e) {
    const err = e as Partial<AppError>;
    return {
      kind: err.kind ?? "unknown",
      message: String(err.message),
      hint: err.hint ?? null,
    };
  }
  return { kind: "unknown", message: String(e), hint: null };
}

/**
 * How this view gets its stream: `start` runs a session with the current
 * settings (taking over a running one with the same settings), `attach`
 * shows the running session as is (the pop-out), `off` shows nothing.
 */
export type SessionMode = "start" | "attach" | "off";

/**
 * Shows one mirroring session for `serial`: starts or attaches to it
 * (again when stream settings change), feeds the decoder, tracks
 * fps/bitrate and lets the session go on unmount or device change.
 */
export function useMirrorSession(
  serial: string | null,
  canvas: RefObject<HTMLCanvasElement | null>,
  mode: SessionMode = "start",
) {
  const { t } = useTranslation("mirror");
  const settingsKey = useMirrorSettings((s) =>
    JSON.stringify(streamOptions(s)),
  );
  // Attached views show the stream as it is; settings belong to its owner.
  const optionsKey = mode === "attach" ? "" : settingsKey;
  const screenOff = useMirrorSettings((s) => s.screenOff);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<MirrorStatus>({ kind: "idle" });
  const [info, setInfo] = useState<MirrorInfo | null>(null);
  const [size, setSize] = useState<VideoSize | null>(null);
  const [stats, setStats] = useState({ fps: 0, mbps: 0 });
  const audioRef = useRef<PcmPlayer | null>(null);
  const lastClipboard = useRef<string | null>(null);

  const control = useCallback(
    (message: ControlMessage) => {
      if (!serial) return;
      sendControl(serial, message).catch(() => {});
    },
    [serial],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` restarts the session on retry
  useEffect(() => {
    const target = canvas.current;
    setInfo(null);
    setSize(null);
    setStats({ fps: 0, mbps: 0 });
    if (!serial || !target || mode === "off") {
      setStatus({ kind: "idle" });
      return;
    }
    if (!hasWebCodecs()) {
      setStatus({ kind: "noWebCodecs" });
      return;
    }

    // Attached views only need to know whether the stream carries audio.
    const options: MirrorOptions = optionsKey
      ? JSON.parse(optionsKey)
      : streamOptions(useMirrorSettings.getState());
    let cancelled = false;
    let sessionId: number | undefined;
    setStatus({ kind: "connecting" });

    const audio = options.audio ? new PcmPlayer() : null;
    audioRef.current = audio;
    const fail = (reason: "codec" | "decode", message: string) => {
      if (cancelled) return;
      setStatus({
        kind: "error",
        reason,
        error: { kind: reason, message, hint: null },
      });
      if (sessionId !== undefined) void stopMirror(serial, sessionId);
    };
    const pipeline = new VideoPipeline(target, {
      onSession: (width, height) => {
        if (!cancelled) setSize({ width, height });
      },
      onFirstFrame: () => {
        if (cancelled) return;
        setStatus({ kind: "streaming" });
        if (mode === "start" && useMirrorSettings.getState().screenOff) {
          sendControl(serial, { type: "setDisplayPower", on: false }).catch(
            () => {},
          );
        }
      },
      onError: (e) =>
        e.kind === "unsupported"
          ? fail("codec", e.codec)
          : fail("decode", e.message),
      onAudio: (pcm) => audio?.push(pcm),
      requestKeyFrame: () => {
        sendControl(serial, { type: "resetVideo" }).catch(() => {});
      },
    });

    const meter = setInterval(() => {
      setStats({ fps: pipeline.frames, mbps: (pipeline.bytes * 8) / 1e6 });
      pipeline.frames = 0;
      pipeline.bytes = 0;
    }, 1000);

    const timer = setTimeout(
      () => {
        const onVideo = (batch: ArrayBuffer) => pipeline.push(batch);
        const open =
          mode === "attach"
            ? (onEvent: (e: MirrorEvent) => void) =>
                attachMirror(serial, onVideo, onEvent)
            : (onEvent: (e: MirrorEvent) => void) =>
                startMirror(serial, options, onVideo, onEvent);
        open((event) => {
          if (cancelled) return;
          switch (event.type) {
            case "clipboard":
              if (
                useMirrorSettings.getState().clipboardSync &&
                event.text !== lastClipboard.current
              ) {
                lastClipboard.current = event.text;
                copyToHost(event.text);
              }
              break;
            case "audioDisabled":
              toast(t("audioUnavailable"));
              break;
            case "stopped":
              sessionId = undefined;
              setStatus({ kind: "stopped", error: event.error });
              break;
            case "detached":
              sessionId = undefined;
              setStatus({ kind: "detached" });
              break;
          }
        })
          .then((started) => {
            if (cancelled) {
              void stopMirror(serial, started.sessionId);
              return;
            }
            sessionId = started.sessionId;
            setInfo(started);
          })
          .catch((e: unknown) => {
            if (!cancelled)
              setStatus({
                kind: "error",
                reason: "start",
                error: asAppError(e),
              });
          });
      },
      mode === "attach" ? 0 : START_DELAY,
    );

    const copyToHost = (text: string) => {
      navigator.clipboard.writeText(text).catch(() => {
        // WebKit only allows clipboard writes during a user gesture.
        toast(t("clipboard.fromDevice"), {
          action: {
            label: t("clipboard.copy"),
            onClick: () => void navigator.clipboard.writeText(text),
          },
        });
      });
    };

    return () => {
      cancelled = true;
      clearTimeout(timer);
      clearInterval(meter);
      pipeline.close();
      audio?.close();
      audioRef.current = null;
      if (sessionId !== undefined) void stopMirror(serial, sessionId);
    };
  }, [serial, optionsKey, mode, attempt, canvas, t]);

  // Screen power follows the switch while streaming.
  const streaming = status.kind === "streaming";
  const firstPower = useRef(true);
  useEffect(() => {
    if (!streaming) {
      firstPower.current = true;
      return;
    }
    // The first frame handler already applied the initial state.
    if (firstPower.current) {
      firstPower.current = false;
      return;
    }
    control({ type: "setDisplayPower", on: !screenOff });
  }, [screenOff, streaming, control]);

  const restart = useCallback(() => setAttempt((n) => n + 1), []);
  const resumeAudio = useCallback(() => audioRef.current?.resume(), []);

  return { status, info, size, stats, control, restart, resumeAudio };
}
