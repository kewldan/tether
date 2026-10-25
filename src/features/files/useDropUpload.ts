import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useEffect, useRef, useState } from "react";

import { type LocalSummary, localSummary } from "./api";

export interface DropState {
  count: number;
  summary: LocalSummary | null;
}

/**
 * Files dragged from the OS onto the window. In Tauri the webview reports
 * real paths (`onDragDropEvent`); in the browser preview HTML5 drag events
 * stand in, with file names as fake paths for the mock backend.
 */
export function useDropUpload(
  enabled: boolean,
  onDrop: (paths: string[]) => void,
): DropState | null {
  const [state, setState] = useState<DropState | null>(null);
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;

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

    if (isTauri()) {
      let unlisten: (() => void) | undefined;
      getCurrentWebview()
        .onDragDropEvent(({ payload }) => {
          if (payload.type === "enter") {
            if (payload.paths.length > 0) enter(payload.paths);
          } else if (payload.type === "drop") {
            leave();
            if (payload.paths.length > 0) onDropRef.current(payload.paths);
          } else if (payload.type === "leave") {
            leave();
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
      if (hasFiles(e)) e.preventDefault();
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

  return state;
}
