import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useEffect, useRef, useState } from "react";

import { isStagedPath, type LocalSummary, localSummary } from "./api";

export interface DropState {
  count: number;
  summary: LocalSummary | null;
}

/**
 * Files dragged from the OS onto the window. In Tauri the webview reports
 * real paths (`onDragDropEvent`); in the browser preview HTML5 drag events
 * stand in, with file names as fake paths for the mock backend.
 *
 * `accepts(x, y)` (CSS pixels) limits where a drop uploads, e.g. not over
 * the computer pane. Our own drag-out (staged device files) coming back
 * into the window is ignored.
 */
export function useDropUpload(
  enabled: boolean,
  onDrop: (paths: string[]) => void,
  accepts?: (x: number, y: number) => boolean,
): DropState | null {
  const [state, setState] = useState<DropState | null>(null);
  const [inside, setInside] = useState(true);
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;
  const acceptsRef = useRef(accepts);
  acceptsRef.current = accepts;

  useEffect(() => {
    if (!enabled) {
      setState(null);
      return;
    }
    let disposed = false;
    let generation = 0;

    const enter = (paths: string[], summary?: LocalSummary) => {
      const current = ++generation;
      setState({ count: paths.length, summary: summary ?? null });
      if (summary) return;
      localSummary(paths)
        .then((s) => {
          if (!disposed && current === generation)
            setState((prev) => (prev ? { ...prev, summary: s } : prev));
        })
        .catch(() => {});
    };
    const leave = () => {
      generation++;
      setState(null);
    };

    const at = (x: number, y: number) => acceptsRef.current?.(x, y) ?? true;

    if (isTauri()) {
      let unlisten: (() => void) | undefined;
      let ignore = false;
      const css = (p: { x: number; y: number }) =>
        at(p.x / window.devicePixelRatio, p.y / window.devicePixelRatio);
      getCurrentWebview()
        .onDragDropEvent(({ payload }) => {
          if (payload.type === "enter") {
            ignore =
              payload.paths.length === 0 || payload.paths.every(isStagedPath);
            if (ignore) return;
            enter(payload.paths);
            setInside(css(payload.position));
          } else if (payload.type === "over") {
            if (!ignore) setInside(css(payload.position));
          } else if (payload.type === "drop") {
            leave();
            const paths = payload.paths.filter((p) => !isStagedPath(p));
            if (!ignore && paths.length > 0 && css(payload.position))
              onDropRef.current(paths);
            ignore = false;
          } else if (payload.type === "leave") {
            leave();
            ignore = false;
          }
        })
        .then((fn) => {
          if (disposed) fn();
          else unlisten = fn;
        })
        .catch(() => {});
      return () => {
        disposed = true;
        unlisten?.();
      };
    }

    // Browser preview.
    let depth = 0;
    const hasFiles = (e: DragEvent) =>
      e.dataTransfer?.types.includes("Files") ?? false;
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (depth++ === 0) {
        const items = e.dataTransfer?.items.length ?? 0;
        enter(
          Array.from({ length: items }, (_, i) => `item-${i}`),
          {
            files: items,
            folders: 0,
            bytes: 0,
          },
        );
      }
    };
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setInside(at(e.clientX, e.clientY));
    };
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      if (--depth <= 0) {
        depth = 0;
        leave();
      }
    };
    const onDropEvent = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      leave();
      if (!at(e.clientX, e.clientY)) return;
      const files = Array.from(e.dataTransfer?.files ?? []);
      onDropRef.current(files.map((f) => `/Users/me/Desktop/${f.name}`));
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDropEvent);
    return () => {
      disposed = true;
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDropEvent);
    };
  }, [enabled]);

  return inside ? state : null;
}
