import { cn } from "cn";

import type { AppIcon as Icon } from "../api";
import { tileClass, tileLetter } from "../naming";

const SIZES = {
  sm: "size-7 rounded-[7px] text-small",
  md: "size-11 rounded-[10px] text-section",
  lg: "size-14 rounded-[14px] text-title",
} as const;

/**
 * Launcher icon read from the APK, or a lettered tile in a stable chart
 * color. Adaptive icons get their background and a centered foreground
 * (the foreground is 108dp with a 72dp safe zone, hence the 150% scale).
 */
export function AppIcon({
  pkg,
  name,
  icon,
  size = "sm",
  dimmed,
}: {
  pkg: string;
  name: string;
  icon: Icon | null | undefined;
  size?: keyof typeof SIZES;
  dimmed?: boolean;
}) {
  const base = cn(
    "relative flex flex-none items-center justify-center overflow-hidden select-none",
    SIZES[size],
    dimmed && "opacity-60 grayscale",
  );

  if (icon?.kind === "bitmap") {
    return (
      <img
        src={icon.src}
        alt=""
        aria-hidden
        draggable={false}
        className={cn(base, "object-contain")}
      />
    );
  }
  if (icon?.kind === "adaptive" && icon.foreground) {
    const bg = icon.background;
    const bgIsImage = bg?.startsWith("data:");
    return (
      <span
        aria-hidden
        className={cn(base, !bg && "bg-selected")}
        style={
          bg
            ? bgIsImage
              ? {
                  backgroundImage: `url("${bg}")`,
                  backgroundSize: "150%",
                  backgroundPosition: "center",
                }
              : { backgroundColor: bg }
            : undefined
        }
      >
        <img
          src={icon.foreground}
          alt=""
          draggable={false}
          className="absolute inset-[-25%] size-[150%] max-w-none object-contain"
        />
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className={cn(base, "text-primary-foreground font-bold", tileClass(pkg))}
    >
      {tileLetter(name)}
    </span>
  );
}
