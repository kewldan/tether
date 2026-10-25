import {
  ArrowLeft,
  Camera,
  Circle,
  ClipboardCheck,
  ClipboardX,
  Maximize,
  Minimize,
  Pin,
  Power,
  RotateCcw,
  Square,
  Volume1,
  Volume2,
  VolumeX,
} from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { type ControlMessage, KEYCODE } from "@/features/mirror/api";
import { useMirrorSettings } from "@/features/mirror/store";
import { cn } from "@/lib/utils";

function Tool({
  label,
  on,
  disabled,
  onClick,
  children,
}: {
  label: string;
  on?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            aria-pressed={on}
            disabled={disabled}
            onClick={onClick}
            className={cn(
              "text-secondary-foreground hover:bg-accent hover:text-foreground focus-visible:outline-ring ease-spring-snappy flex size-[34px] items-center justify-center rounded-md transition-[background-color,color,transform] duration-[340ms] outline-none focus-visible:outline-2 active:scale-[.97] disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-[18px]",
              on && "bg-brand/15 text-brand hover:bg-brand/15 hover:text-brand",
            )}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

const Separator = () => (
  <span aria-hidden className="bg-input mx-1 h-5 w-px flex-none" />
);

/** The floating control strip above the device (board 07). */
export function DeviceToolbar({
  live,
  control,
  audioAvailable,
  alwaysOnTop,
  fullscreen,
  onScreenshot,
  onAlwaysOnTop,
  onFullscreen,
}: {
  live: boolean;
  control: (message: ControlMessage) => void;
  audioAvailable: boolean;
  alwaysOnTop: boolean;
  fullscreen: boolean;
  onScreenshot: () => void;
  onAlwaysOnTop: () => void;
  onFullscreen: () => void;
}) {
  const { t } = useTranslation("mirror");
  const clipboardSync = useMirrorSettings((s) => s.clipboardSync);
  const audio = useMirrorSettings((s) => s.audio);
  const set = useMirrorSettings((s) => s.set);

  const press = (keycode: number) => {
    control({ type: "key", action: "down", keycode });
    control({ type: "key", action: "up", keycode });
  };

  return (
    <div className="flex justify-center p-2.5">
      <div
        role="toolbar"
        aria-label={t("toolbar.label")}
        className="bg-card flex items-center gap-0.5 rounded-lg border p-[3px]"
      >
        <Tool
          label={t("toolbar.back")}
          disabled={!live}
          onClick={() => {
            control({ type: "backOrScreenOn", action: "down" });
            control({ type: "backOrScreenOn", action: "up" });
          }}
        >
          <ArrowLeft />
        </Tool>
        <Tool
          label={t("toolbar.home")}
          disabled={!live}
          onClick={() => press(KEYCODE.home)}
        >
          <Circle />
        </Tool>
        <Tool
          label={t("toolbar.recents")}
          disabled={!live}
          onClick={() => press(KEYCODE.appSwitch)}
        >
          <Square />
        </Tool>
        <Separator />
        <Tool
          label={t("toolbar.volumeDown")}
          disabled={!live}
          onClick={() => press(KEYCODE.volumeDown)}
        >
          <Volume1 />
        </Tool>
        <Tool
          label={t("toolbar.volumeUp")}
          disabled={!live}
          onClick={() => press(KEYCODE.volumeUp)}
        >
          <Volume2 />
        </Tool>
        <Tool
          label={t("toolbar.power")}
          disabled={!live}
          onClick={() => press(KEYCODE.power)}
        >
          <Power />
        </Tool>
        <Tool
          label={t("toolbar.rotate")}
          disabled={!live}
          onClick={() => control({ type: "rotateDevice" })}
        >
          <RotateCcw />
        </Tool>
        <Separator />
        <Tool
          label={t("toolbar.screenshot")}
          disabled={!live}
          onClick={onScreenshot}
        >
          <Camera />
        </Tool>
        <Tool
          label={
            clipboardSync ? t("toolbar.clipboardOn") : t("toolbar.clipboardOff")
          }
          on={clipboardSync}
          onClick={() => set({ clipboardSync: !clipboardSync })}
        >
          {clipboardSync ? <ClipboardCheck /> : <ClipboardX />}
        </Tool>
        <Tool
          label={
            !audioAvailable
              ? t("toolbar.audioUnavailable")
              : audio
                ? t("toolbar.audioOn")
                : t("toolbar.audioOff")
          }
          on={audio && audioAvailable}
          disabled={!audioAvailable}
          onClick={() => set({ audio: !audio })}
        >
          {audio ? <Volume2 /> : <VolumeX />}
        </Tool>
        <Tool
          label={t("toolbar.alwaysOnTop")}
          on={alwaysOnTop}
          onClick={onAlwaysOnTop}
        >
          <Pin />
        </Tool>
        <Tool
          label={
            fullscreen ? t("toolbar.exitFullscreen") : t("toolbar.fullscreen")
          }
          on={fullscreen}
          onClick={onFullscreen}
        >
          {fullscreen ? <Minimize /> : <Maximize />}
        </Tool>
      </div>
    </div>
  );
}
