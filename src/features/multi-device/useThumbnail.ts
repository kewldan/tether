import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { thumbnail } from "@/features/multi-device/api";
import { useMulti } from "@/features/multi-device/store";
import type { AppError } from "@/lib/tauri";

/** Pause between two screencaps of one device. */
const INTERVAL_MS = 2500;
/** Thumbnail width in px (about 2× the card on a HiDPI screen). */
const WIDTH = 360;

/**
 * Low-res live screen of one device: a scaled `screencap` every few
 * seconds while the tile is on screen and the window is visible — no video
 * stream, so a grid of many devices stays cheap. `refresh()` grabs a new
 * frame right away (after a tap).
 */
export function useThumbnail(
  serial: string | null,
  target: RefObject<HTMLElement | null>,
) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [visible, setVisible] = useState(true);
  const [pageVisible, setPageVisible] = useState(
    document.visibilityState === "visible",
  );
  const wake = useRef<(() => void) | null>(null);
  const setScreen = useMulti((s) => s.setScreen);

  useEffect(() => {
    const el = target.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry?.isIntersecting ?? true),
      { rootMargin: "100px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [target]);

  useEffect(() => {
    const onChange = () =>
      setPageVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);

  const active = serial !== null && visible && pageVisible;

  useEffect(() => {
    if (!active || !serial) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sleep = () =>
      new Promise<void>((resolve) => {
        wake.current = resolve;
        timer = setTimeout(resolve, INTERVAL_MS);
      });
    void (async () => {
      while (!stopped) {
        try {
          const t = await thumbnail(serial, WIDTH);
          if (stopped) break;
          setSrc(t.dataUrl);
          setError(null);
          setScreen(serial, t.screenWidth, t.screenHeight);
        } catch (e) {
          if (stopped) break;
          setError((e as Partial<AppError>)?.message ?? String(e));
        }
        await sleep();
        clearTimeout(timer);
      }
    })();
    return () => {
      stopped = true;
      clearTimeout(timer);
      wake.current?.();
      wake.current = null;
    };
  }, [active, serial, setScreen]);

  const refresh = useCallback(() => {
    // Give the tap a moment to land before the next frame.
    setTimeout(() => wake.current?.(), 350);
  }, []);

  const tick = useMulti((s) => s.tick);
  useEffect(() => {
    if (tick > 0) refresh();
  }, [tick, refresh]);

  return { src, error, refresh };
}
