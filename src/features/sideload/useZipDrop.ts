import { useEffect, useRef, useState } from "react";

const isZip = (path: string) => path.toLowerCase().endsWith(".zip");

/** A real webview (the browser mock backend provides no window metadata). */
const inTauri = () =>
  Boolean(
    (
      window as {
        __TAURI_INTERNALS__?: { metadata?: { currentWebview?: unknown } };
      }
    ).__TAURI_INTERNALS__?.metadata?.currentWebview,
  );

/**
 * Calls `onDrop` with the first `.zip` dropped on the window while
 * `enabled`; returns whether a zip is being dragged over it. Native
 * drag-drop events carry real paths; the browser preview only has names.
 */
export function useZipDrop(
  enabled: boolean,
  onDrop: (path: string) => void,
): boolean {
  const [dragging, setDragging] = useState(false);
  const callback = useRef(onDrop);
  callback.current = onDrop;

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;

    if (inTauri()) {
      void import("@tauri-apps/api/webview")
        .then(({ getCurrentWebview }) =>
          getCurrentWebview().onDragDropEvent((event) => {
            const p = event.payload;
            if (p.type === "enter") setDragging(p.paths.some(isZip));
            else if (p.type === "leave") setDragging(false);
            else if (p.type === "drop") {
              setDragging(false);
              const zip = p.paths.find(isZip);
              if (zip) callback.current(zip);
            }
          }),
        )
        .then((fn) => {
          if (disposed) fn();
          else unlisten = fn;
        })
        .catch(() => {});
      return () => {
        disposed = true;
        unlisten?.();
        setDragging(false);
      };
    }

    let depth = 0;
    const hasFiles = (e: DragEvent) =>
      Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setDragging(true);
    };
    const onLeave = () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onOver = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const onDropEvent = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const zip = Array.from(e.dataTransfer?.files ?? [])
        .map((f) => f.name)
        .find(isZip);
      if (zip) callback.current(zip);
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("dragover", onOver);
    window.addEventListener("drop", onDropEvent);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("drop", onDropEvent);
      setDragging(false);
    };
  }, [enabled]);

  return dragging;
}
