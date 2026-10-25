import { useEffect } from "react";

import { isPackageFile } from "../api";
import { openInstallerWith, useApkDrag } from "./openInstaller";

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
 * Opens the install dialog when `.apk/.apks/.xapk` files are dropped on the
 * window. Uses Tauri's native drag-drop events (they carry real paths); in
 * the browser preview it falls back to HTML5 drops with file names only,
 * which the mock backend accepts.
 */
export function useApkDrop(enabled: boolean) {
  const setDragging = useApkDrag((s) => s.set);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;

    if (inTauri()) {
      void import("@tauri-apps/api/webview")
        .then(({ getCurrentWebview }) =>
          getCurrentWebview().onDragDropEvent((event) => {
            const p = event.payload;
            if (p.type === "enter") {
              setDragging(p.paths.some(isPackageFile));
            } else if (p.type === "leave") {
              setDragging(false);
            } else if (p.type === "drop") {
              setDragging(false);
              if (p.paths.some(isPackageFile)) openInstallerWith(p.paths);
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
      };
    }

    // Browser preview: HTML5 drag and drop.
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
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const names = Array.from(e.dataTransfer?.files ?? []).map((f) => f.name);
      if (names.some(isPackageFile)) openInstallerWith(names);
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("dragover", onOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("drop", onDrop);
    };
  }, [enabled, setDragging]);
}
