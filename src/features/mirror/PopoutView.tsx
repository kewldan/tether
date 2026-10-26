import { getCurrentWindow } from "@tauri-apps/api/window";
import { Camera, ExternalLink, X } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { StatusDot } from "@/components/status/StatusDot";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ConnectingScreen, MirrorScreen } from "@/features/mirror/MirrorScreen";
import { popIn } from "@/features/mirror/popout";
import {
  type MirrorStatus,
  useMirrorSession,
} from "@/features/mirror/useMirrorSession";
import { useSettings } from "@/lib/settings";
import { useApplyTheme } from "@/lib/theme";

const TONE = {
  streaming: "success",
  connecting: "info",
  idle: "info",
  error: "error",
  noWebCodecs: "error",
  stopped: "neutral",
  detached: "neutral",
} as const satisfies Record<MirrorStatus["kind"], string>;

function FooterButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The picture-in-picture window (`index.html?popout=<serial>&name=…`):
 * the running session of one device, shown without restarting it. Closing
 * the window gives the session back to the main window.
 */
export default function PopoutView({
  serial,
  name,
}: {
  serial: string;
  name: string;
}) {
  const { t } = useTranslation("mirror");
  useApplyTheme();
  const density = useSettings((s) => s.density);
  useEffect(() => {
    document.documentElement.dataset.density = density;
  }, [density]);

  const canvas = useRef<HTMLCanvasElement>(null);
  const session = useMirrorSession(serial, canvas, "attach");
  const { status, size, control } = session;
  const live = status.kind === "streaming";
  const label = name || session.info?.deviceName || serial;

  const back = () => void popIn(serial, true).catch(() => {});
  const close = () => void getCurrentWindow().close();

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

  const overlay =
    status.kind === "connecting" || status.kind === "idle" ? (
      <ConnectingScreen label={t("popout.connecting")} />
    ) : (
      <div
        role={status.kind === "error" ? "alert" : "status"}
        className="text-small flex h-full flex-col items-center justify-center gap-3 p-3 text-center"
      >
        <span className="text-muted-foreground">
          {status.kind === "detached"
            ? t("popout.detached")
            : status.kind === "stopped"
              ? t("state.stopped")
              : status.kind === "error"
                ? (status.error.hint ?? status.error.message)
                : t("state.noWebCodecs")}
        </span>
        <Button size="sm" variant="outline" onClick={back}>
          {t("popout.back")}
        </Button>
      </div>
    );

  return (
    <div className="bg-popover text-foreground flex h-full flex-col p-1.5 select-none">
      <div
        data-tauri-drag-region
        className="text-caption flex h-6 flex-none items-center justify-between gap-2 px-0.5 pb-1.5"
      >
        <span
          data-tauri-drag-region
          className="flex min-w-0 items-center gap-[5px]"
        >
          <StatusDot tone={TONE[status.kind]} />
          <span data-tauri-drag-region className="truncate">
            {label}
          </span>
        </span>
        <span data-tauri-drag-region className="text-muted-foreground">
          {t("popout.badge")}
        </span>
      </div>
      <MirrorScreen
        compact
        canvas={canvas}
        size={size}
        live={live}
        overlay={overlay}
        control={control}
        onInteract={session.resumeAudio}
      />
      <div className="flex flex-none items-center justify-between pt-1.5">
        <FooterButton label={t("popout.back")} onClick={back}>
          <ExternalLink />
        </FooterButton>
        <FooterButton
          label={t("toolbar.screenshot")}
          disabled={!live}
          onClick={screenshot}
        >
          <Camera />
        </FooterButton>
        <FooterButton label={t("popout.close")} onClick={close}>
          <X />
        </FooterButton>
      </div>
    </div>
  );
}
