import { cn } from "cn";
import { PanelRight } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Page } from "@/components/layout/Page";
import { StatusDot } from "@/components/status/StatusDot";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { deviceName } from "@/features/devices/naming";
import { useDeviceInfo } from "@/features/devices/queries";
import { useReadySerial, useSelectedDevice } from "@/features/devices/store";
import type { VideoCodec } from "@/features/mirror/api";
import { DeviceToolbar } from "@/features/mirror/DeviceToolbar";
import { ConnectingScreen, MirrorScreen } from "@/features/mirror/MirrorScreen";
import { SettingsPanel } from "@/features/mirror/SettingsPanel";
import { useMirrorSettings } from "@/features/mirror/store";
import {
  type MirrorStatus,
  useMirrorSession,
} from "@/features/mirror/useMirrorSession";

/** Raw audio forwarding needs Android 11 (SDK 30). */
const AUDIO_MIN_SDK = 30;

const PROBE_CODECS: Record<VideoCodec, string> = {
  h264: "avc1.42E01F",
  h265: "hvc1.1.6.L93.B0",
  av1: "av01.0.08M.08",
};

/** Which codecs this engine's WebCodecs can decode. */
function useCodecSupport() {
  const [support, setSupport] = useState<Partial<Record<VideoCodec, boolean>>>(
    {},
  );
  useEffect(() => {
    if (typeof VideoDecoder === "undefined") return;
    let alive = true;
    for (const [codec, probe] of Object.entries(PROBE_CODECS)) {
      VideoDecoder.isConfigSupported({ codec: probe })
        .then(
          (r) => alive && setSupport((s) => ({ ...s, [codec]: !!r.supported })),
        )
        .catch(() => alive && setSupport((s) => ({ ...s, [codec]: false })));
    }
    return () => {
      alive = false;
    };
  }, []);
  return support;
}

/** The device has no encoder for the chosen codec (server's own words). */
function isEncoderError(status: MirrorStatus) {
  return (
    status.kind === "error" &&
    status.reason === "start" &&
    /encoder/i.test(status.error.message)
  );
}

async function currentWindow() {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
}

function StateMessage({
  tone,
  title,
  children,
  action,
  details,
}: {
  tone: "error" | "warning" | "neutral";
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  details?: string;
}) {
  const { t } = useTranslation("mirror");
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className="flex h-full flex-col items-center justify-center gap-3 p-5 text-center"
    >
      <div className="flex items-center gap-2 font-semibold">
        <StatusDot tone={tone} />
        {title}
      </div>
      {children && (
        <div className="text-muted-foreground text-small">{children}</div>
      )}
      {action}
      {details && (
        <Collapsible className="w-full">
          <CollapsibleTrigger className="text-muted-foreground text-caption hover:text-foreground">
            {t("state.details")}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <pre className="bg-background text-caption mt-2 max-h-40 overflow-auto rounded-md border p-2 text-left font-mono break-words whitespace-pre-wrap">
              {details}
            </pre>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}

function LiveBadge({
  status,
  stats,
}: {
  status: MirrorStatus;
  stats: { fps: number; mbps: number };
}) {
  const { t } = useTranslation("mirror");
  switch (status.kind) {
    case "streaming":
      return (
        <Badge variant="success" className="tabular-nums">
          <StatusDot tone="success" />
          {t("badge.live", {
            fps: stats.fps,
            mbps: stats.mbps.toFixed(stats.mbps < 10 ? 1 : 0),
          })}
        </Badge>
      );
    case "connecting":
      return (
        <Badge variant="info">
          <StatusDot tone="info" />
          {t("badge.connecting")}
        </Badge>
      );
    case "error":
    case "noWebCodecs":
      return (
        <Badge variant="error">
          <StatusDot tone="error" />
          {t("badge.error")}
        </Badge>
      );
    case "stopped":
      return (
        <Badge>
          <StatusDot tone="neutral" />
          {t("badge.stopped")}
        </Badge>
      );
    default:
      return null;
  }
}

export default function MirrorPage() {
  const { t } = useTranslation("mirror");
  const { t: tc } = useTranslation();
  const device = useSelectedDevice();
  const serial = useReadySerial();
  const { data: info } = useDeviceInfo(serial);
  const canvas = useRef<HTMLCanvasElement>(null);
  const session = useMirrorSession(serial, canvas);
  const { status, size, control } = session;
  const panelOpen = useMirrorSettings((s) => s.panelOpen);
  const setSettings = useMirrorSettings((s) => s.set);
  const codecSupport = useCodecSupport();
  const [onTop, setOnTop] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const live = status.kind === "streaming";
  const audioAvailable = (info?.sdk ?? AUDIO_MIN_SDK) >= AUDIO_MIN_SDK;
  const name = device ? deviceName(device, info) : tc("sidebar.noDevice");

  const toggleOnTop = async () => {
    const next = !onTop;
    try {
      await (await currentWindow()).setAlwaysOnTop(next);
      setOnTop(next);
    } catch {
      toast.error(t("window.failed"));
    }
  };

  const toggleFullscreen = async (next = !fullscreen) => {
    setFullscreen(next);
    try {
      await (await currentWindow()).setFullscreen(next);
    } catch {
      // The in-app immersive view still works without OS fullscreen.
    }
  };

  // Leave the window as we found it.
  const windowState = useRef({ onTop, fullscreen });
  windowState.current = { onTop, fullscreen };
  useEffect(
    () => () => {
      const { onTop, fullscreen } = windowState.current;
      if (!onTop && !fullscreen) return;
      void currentWindow()
        .then(async (w) => {
          if (onTop) await w.setAlwaysOnTop(false);
          if (fullscreen) await w.setFullscreen(false);
        })
        .catch(() => {});
    },
    [],
  );

  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      const inScreen =
        e.target instanceof Element && e.target.closest("[role=application]");
      if (e.key === "Escape" && !inScreen) void toggleFullscreen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const screenshot = () => {
    const el = canvas.current;
    if (!el) return;
    const png = new Promise<Blob>((resolve, reject) =>
      el.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("empty"))),
        "image/png",
      ),
    );
    navigator.clipboard
      .write([new ClipboardItem({ "image/png": png })])
      .then(() => toast.success(t("screenshot.copied")))
      .catch(() => toast.error(t("screenshot.failed")));
  };

  const overlay = (() => {
    if (!serial) {
      return (
        <StateMessage
          tone={device ? "warning" : "neutral"}
          title={device ? t("state.notReadyTitle") : t("state.noDeviceTitle")}
        >
          {device
            ? t("state.notReady", {
                name,
                state: tc(`state.${device.state.kind}`),
              })
            : t("state.noDevice")}
        </StateMessage>
      );
    }
    switch (status.kind) {
      case "noWebCodecs":
        return (
          <StateMessage tone="error" title={t("state.noWebCodecsTitle")}>
            {t("state.noWebCodecs")}
          </StateMessage>
        );
      case "error":
        if (status.reason === "codec" || isEncoderError(status)) {
          return (
            <StateMessage
              tone="error"
              title={
                status.reason === "codec"
                  ? t("state.codecTitle")
                  : t("state.encoderTitle")
              }
              details={status.error.message}
              action={
                <Button
                  size="sm"
                  onClick={() => setSettings({ codec: "h264" })}
                >
                  {t("state.useH264")}
                </Button>
              }
            >
              {status.reason === "codec"
                ? t("state.codec")
                : t("state.encoder")}
            </StateMessage>
          );
        }
        return (
          <StateMessage
            tone="error"
            title={
              status.reason === "decode"
                ? t("state.decodeTitle")
                : t("state.startTitle")
            }
            details={status.error.message}
            action={
              <Button size="sm" variant="outline" onClick={session.restart}>
                {tc("actions.retry")}
              </Button>
            }
          >
            {status.error.hint ?? t("state.startHint")}
          </StateMessage>
        );
      case "stopped":
        return (
          <StateMessage
            tone={status.error ? "warning" : "neutral"}
            title={t("state.stoppedTitle")}
            details={status.error?.message}
            action={
              <Button size="sm" variant="outline" onClick={session.restart}>
                {t("state.startAgain")}
              </Button>
            }
          >
            {t("state.stopped")}
          </StateMessage>
        );
      default:
        return <ConnectingScreen label={t("state.connecting", { name })} />;
    }
  })();

  return (
    <Page
      title={
        <span className="flex items-center gap-2">
          {tc("nav.screen")}
          {/* Sets the badge size: Badge's own text-caption is merged away by its color class. */}
          <span className="text-caption font-normal">
            <LiveBadge status={status} stats={session.stats} />
          </span>
        </span>
      }
      parent={device ? { label: name } : undefined}
      body="fill"
      actions={
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={panelOpen ? t("panel.hide") : t("panel.show")}
          aria-pressed={panelOpen}
          onClick={() => setSettings({ panelOpen: !panelOpen })}
        >
          <PanelRight />
        </Button>
      }
    >
      <div className="flex min-h-0 flex-1">
        <section
          aria-label={t("screen.region")}
          className={cn(
            "bg-sidebar flex min-w-0 flex-col",
            fullscreen ? "fixed inset-0 z-50" : "relative flex-1",
          )}
        >
          <DeviceToolbar
            live={live}
            control={control}
            audioAvailable={audioAvailable}
            alwaysOnTop={onTop}
            fullscreen={fullscreen}
            onScreenshot={screenshot}
            onAlwaysOnTop={() => void toggleOnTop()}
            onFullscreen={() => void toggleFullscreen()}
          />
          <MirrorScreen
            canvas={canvas}
            size={size}
            live={live}
            overlay={overlay}
            control={control}
            onInteract={session.resumeAudio}
          />
        </section>
        {panelOpen && !fullscreen && (
          <SettingsPanel
            info={session.info}
            size={size}
            audioAvailable={audioAvailable}
            supportedCodecs={codecSupport}
          />
        )}
      </div>
    </Page>
  );
}
