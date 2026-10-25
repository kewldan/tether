import { cn } from "cn";
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { Skeleton } from "@/components/ui/skeleton";
import type { ControlMessage } from "@/features/mirror/api";
import { keyMessages } from "@/features/mirror/keys";
import { useMirrorSettings } from "@/features/mirror/store";
import type { VideoSize } from "@/features/mirror/useMirrorSession";
import { hasMod } from "@/lib/platform";

/** Bezel padding around the screen, as on the board. */
const BEZEL = 6;
/** Aspect used before the first session packet (typical phone). */
const FALLBACK: VideoSize = { width: 1344, height: 2992 };

/**
 * Largest frame whose screen (inside a fixed bezel) has the given aspect
 * and fits the container, so the video is never letterboxed or stretched.
 */
function useFit(
  container: RefObject<HTMLDivElement | null>,
  aspect: number,
): { width: number; height: number } {
  const [box, setBox] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = container.current;
    if (!el) return;
    const update = () => {
      const w = Math.max(0, el.clientWidth - BEZEL * 2);
      const h = Math.max(0, el.clientHeight - BEZEL * 2);
      const width = Math.min(w, h * aspect);
      setBox({ width: width + BEZEL * 2, height: width / aspect + BEZEL * 2 });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [container, aspect]);
  return box;
}

/**
 * The device frame with the decoded video. Pointer events become touches
 * in video coordinates, the wheel scrolls, and while focused the keyboard
 * types on the device.
 */
export function MirrorScreen({
  canvas,
  size,
  live,
  overlay,
  control,
  onInteract,
}: {
  canvas: RefObject<HTMLCanvasElement | null>;
  size: VideoSize | null;
  /** Frames are being painted; input is forwarded only then. */
  live: boolean;
  /** Connecting skeleton or a state message drawn over the screen. */
  overlay: ReactNode;
  control: (message: ControlMessage) => void;
  onInteract: () => void;
}) {
  const { t } = useTranslation("mirror");
  const area = useRef<HTMLDivElement>(null);
  const video = size ?? FALLBACK;
  const box = useFit(area, video.width / video.height);
  const pointer = useRef<number | null>(null);

  const position = (e: { clientX: number; clientY: number }) => {
    const el = canvas.current;
    if (!el || !size) return null;
    const rect = el.getBoundingClientRect();
    const fx = (e.clientX - rect.left) / rect.width;
    const fy = (e.clientY - rect.top) / rect.height;
    return {
      x: Math.round(Math.min(Math.max(fx, 0), 1) * (size.width - 1)),
      y: Math.round(Math.min(Math.max(fy, 0), 1) * (size.height - 1)),
      width: size.width,
      height: size.height,
    };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    onInteract();
    e.currentTarget.parentElement?.focus();
    if (!live) return;
    if (e.button === 2) {
      // Right click: BACK (or wake the screen), like scrcpy.
      control({ type: "backOrScreenOn", action: "down" });
      control({ type: "backOrScreenOn", action: "up" });
      return;
    }
    if (e.button === 1) {
      control({ type: "key", action: "down", keycode: 3 });
      control({ type: "key", action: "up", keycode: 3 });
      return;
    }
    if (e.button !== 0 || pointer.current !== null) return;
    const p = position(e);
    if (!p) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointer.current = e.pointerId;
    control({ type: "touch", action: "down", ...p });
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (pointer.current !== e.pointerId) return;
    const p = position(e);
    if (p) control({ type: "touch", action: "move", ...p });
  };

  const onPointerEnd = (
    e: React.PointerEvent<HTMLCanvasElement>,
    action: "up" | "cancel",
  ) => {
    if (pointer.current !== e.pointerId) return;
    pointer.current = null;
    const p = position(e);
    if (p) control({ type: "touch", action, ...p });
  };

  // Wheel needs a non-passive listener to keep the page from scrolling.
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (!live) return;
      const p = position(e);
      if (!p) return;
      const scale = e.deltaMode === WheelEvent.DOM_DELTA_PIXEL ? 100 : 1;
      control({
        type: "scroll",
        ...p,
        hscroll: Math.max(-16, Math.min(16, -e.deltaX / scale)),
        vscroll: Math.max(-16, Math.min(16, -e.deltaY / scale)),
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  const onKey = (e: React.KeyboardEvent, action: "down" | "up") => {
    if (!live) return;
    const native = e.nativeEvent;
    // Paste goes through the paste event (clipboard text, no prompt).
    if (hasMod(native) && e.key.toLowerCase() === "v") return;
    if (hasMod(native) && e.key.toLowerCase() === "c") {
      if (action === "down") control({ type: "getClipboard", copyKey: "copy" });
      e.preventDefault();
      return;
    }
    const messages = keyMessages(native, action);
    if (messages.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    for (const m of messages) control(m);
  };

  const onPaste = (e: React.ClipboardEvent) => {
    if (!live) return;
    const text = e.clipboardData.getData("text/plain");
    if (!text) return;
    e.preventDefault();
    if (useMirrorSettings.getState().clipboardSync) {
      control({ type: "setClipboard", text, paste: true });
    } else {
      control({ type: "text", text });
    }
  };

  return (
    <div
      ref={area}
      className="flex min-h-0 flex-1 items-center justify-center px-5 pt-1 pb-5"
    >
      <div
        className="ring-input relative rounded-[26px] bg-black shadow-lg ring-1"
        style={{ width: box.width, height: box.height, padding: BEZEL }}
      >
        <div
          role="application"
          aria-label={t("screen.label")}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard goes to the device while focused
          tabIndex={0}
          onKeyDown={(e) => onKey(e, "down")}
          onKeyUp={(e) => onKey(e, "up")}
          onPaste={onPaste}
          className="focus-visible:outline-ring relative h-full w-full overflow-hidden rounded-[21px] outline-offset-4 focus-visible:outline-2"
        >
          <canvas
            ref={canvas}
            className={cn(
              "block h-full w-full touch-none select-none",
              !live && "invisible",
            )}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={(e) => onPointerEnd(e, "up")}
            onPointerCancel={(e) => onPointerEnd(e, "cancel")}
            onContextMenu={(e) => e.preventDefault()}
          />
          {!live && (
            <div className="bg-sidebar absolute inset-0 flex flex-col">
              {overlay}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Placeholder screen while the server starts. */
export function ConnectingScreen({ label }: { label: string }) {
  return (
    <div className="flex h-full flex-col gap-3 p-4" aria-busy>
      <div className="flex justify-between">
        <Skeleton className="bg-selected h-2.5 w-10" />
        <Skeleton className="bg-selected h-2.5 w-8" />
      </div>
      <Skeleton className="bg-selected mt-2 h-5 w-2/3" />
      <Skeleton className="bg-selected h-8 w-full rounded-full" />
      <div className="grid flex-1 grid-cols-2 content-start gap-2">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="bg-selected aspect-square rounded-xl" />
        ))}
      </div>
      <p className="text-muted-foreground text-small text-center">{label}</p>
    </div>
  );
}
