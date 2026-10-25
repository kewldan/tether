import type { DeviceState } from "@/lib/tauri";
import { cn } from "@/lib/utils";

export type Tone = "success" | "warning" | "error" | "info" | "neutral";

const TONE_CLASS: Record<Tone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  error: "bg-error",
  info: "bg-info",
  neutral: "bg-muted-foreground",
};

/** Maps an adb device state to its status tone. */
export function deviceTone(state: DeviceState): Tone {
  switch (state.kind) {
    case "device":
      return "success";
    case "unauthorized":
    case "authorizing":
    case "no_permissions":
      return "warning";
    case "offline":
      return "error";
    case "connecting":
    case "recovery":
    case "rescue":
    case "sideload":
    case "bootloader":
      return "info";
    default:
      return "neutral";
  }
}

/** 7 px status dot; always pair it with a text label. */
export function StatusDot({
  tone,
  className,
}: {
  tone: Tone;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-[7px] flex-none rounded-full transition-colors duration-300",
        TONE_CLASS[tone],
        className,
      )}
    />
  );
}
