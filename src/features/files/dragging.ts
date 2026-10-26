import { isTauri } from "@tauri-apps/api/core";
import type { PointerEvent as ReactPointerEvent } from "react";
import { toast } from "sonner";
import { create } from "zustand";

import i18n from "@/lib/i18n";
import type { AppError } from "@/lib/tauri";

import {
  controlTransfer,
  dragStage,
  type FileEntry,
  isDirLike,
  pullPaths,
  startNativeDrag,
} from "./api";
import { useTransfers } from "./transfers";

/**
 * Dragging rows between the computer and the device pane, and out of the
 * window onto the desktop.
 *
 * Inside the window the drag is our own (pointer events, a ghost and drop
 * targets found under the cursor), so it works the same in every webview
 * and in the browser preview. Once the cursor leaves the window, the drag
 * is handed to the OS (`files_start_drag`) while the button is still held:
 * computer files go as they are; device files are first pulled into a
 * staging folder (small ones as soon as the drag starts, the rest when the
 * cursor leaves), and the ghost shows "Preparing…" until they are ready.
 */

export type PaneKind = "local" | "device";

export interface DragPayload {
  from: PaneKind;
  /** The device of the page (source or target). */
  serial: string;
  entries: FileEntry[];
}

export interface DropTarget {
  pane: PaneKind;
  dir: string;
  name: string;
}

export type OutPhase = "idle" | "preparing" | "ready" | "failed";

interface DragState {
  payload: DragPayload | null;
  x: number;
  y: number;
  target: DropTarget | null;
  /** The cursor is outside the window. */
  outside: boolean;
  out: { phase: OutPhase; bytes: number; total: number };
}

const IDLE_OUT = { phase: "idle" as OutPhase, bytes: 0, total: 0 };

export const useDrag = create<DragState>()(() => ({
  payload: null,
  x: 0,
  y: 0,
  target: null,
  outside: false,
  out: IDLE_OUT,
}));

/** Device drags up to this size (files only) are staged right away. */
const EAGER_STAGE_MAX = 32 * 1024 * 1024;
const THRESHOLD = 5;

/** Copies the payload into the target through the transfer queue. */
export function performDrop(payload: DragPayload, target: DropTarget) {
  if (payload.from === target.pane) return;
  useTransfers.getState().enqueue({
    serial: payload.serial,
    direction: payload.from === "device" ? "pull" : "push",
    sources: payload.entries.map((e) => e.path),
    target: target.dir,
  });
}

/** The drop target under a point: a folder row, else the pane's folder. */
export function dropTargetAt(
  x: number,
  y: number,
  from: PaneKind,
): DropTarget | null {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  const pane = el?.closest<HTMLElement>("[data-drop-pane]");
  if (!el || !pane) return null;
  const kind = pane.dataset.dropPane as PaneKind;
  const dir = pane.dataset.dropDir;
  if (kind === from || !dir) return null;
  const folder = el.closest<HTMLElement>("[data-path][data-dir]");
  if (folder?.dataset.path && pane.contains(folder))
    return {
      pane: kind,
      dir: folder.dataset.path,
      name: folder.dataset.name ?? folder.dataset.path,
    };
  return { pane: kind, dir, name: pane.dataset.dropName ?? dir };
}

let stageCounter = 0;

interface Stage {
  id: string;
  paths: string[] | null;
  done: Promise<string[]>;
  cancel: () => void;
}

/** Pulls device files into a fresh staging folder (via `files_pull`). */
function stageDeviceFiles(
  serial: string,
  entries: FileEntry[],
  onProgress: (bytes: number, total: number) => void,
): Stage {
  const id = `drag-${Date.now().toString(36)}-${++stageCounter}`;
  let cancelled = false;
  let running = false;
  const run = async (): Promise<string[]> => {
    const dir = await dragStage(id);
    if (cancelled) throw { kind: "cancelled", message: "cancelled" };
    running = true;
    const summary = await pullPaths(
      id,
      serial,
      entries.map((e) => e.path),
      dir,
      (event) => {
        if (event.type === "started") onProgress(0, event.totalBytes);
        else if (event.type === "progress")
          onProgress(event.bytes, event.totalBytes);
      },
    );
    stage.paths = summary.destinations;
    return summary.destinations;
  };
  const stage: Stage = {
    id,
    paths: null,
    cancel: () => {
      cancelled = true;
      if (running) void controlTransfer(id, "cancel");
    },
    done: Promise.resolve([]),
  };
  stage.done = run();
  return stage;
}

/** Small drag image for the OS drag: name (or count) on a card. */
function dragIcon(entries: FileEntry[]): string | null {
  try {
    const css = getComputedStyle(document.documentElement);
    const token = (name: string) => css.getPropertyValue(name).trim();
    const canvas = document.createElement("canvas");
    const w = 200;
    const h = 36;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = token("--popover");
    ctx.strokeStyle = token("--border");
    ctx.beginPath();
    ctx.roundRect(0.5, 0.5, w - 1, h - 1, 8);
    ctx.fill();
    ctx.stroke();
    const t = i18n.getFixedT(null, "files");
    const first = entries[0];
    const label =
      entries.length === 1 && first
        ? first.name
        : t("dialogs.items", { count: entries.length });
    ctx.fillStyle = token("--brand");
    ctx.beginPath();
    ctx.roundRect(10, 10, 16, 16, 4);
    ctx.fill();
    ctx.fillStyle = token("--foreground");
    ctx.font = `500 13px ${css.fontFamily}`;
    ctx.textBaseline = "middle";
    let text = label;
    while (text.length > 1 && ctx.measureText(text).width > w - 46)
      text = text.slice(0, -1);
    ctx.fillText(text === label ? label : `${text}…`, 34, h / 2 + 0.5);
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}

function swallowNextClick() {
  const stop = (e: Event) => {
    e.stopPropagation();
    e.preventDefault();
  };
  window.addEventListener("click", stop, { capture: true, once: true });
  setTimeout(() => window.removeEventListener("click", stop, true), 0);
}

/**
 * Call from `onPointerDown` of a list: when the press on a row turns into
 * a drag, `getPayload(rowPath)` decides what is dragged.
 */
export function trackRowDrag(
  down: ReactPointerEvent<HTMLElement>,
  getPayload: (rowPath: string) => DragPayload | null,
) {
  if (down.button !== 0 || down.pointerType === "touch") return;
  const origin = down.target as HTMLElement;
  if (origin.closest("button, input, label, [role=checkbox], [data-no-drag]"))
    return;
  const rowPath = origin.closest<HTMLElement>("[data-path]")?.dataset.path;
  if (!rowPath) return;

  const container = down.currentTarget;
  const pointerId = down.pointerId;
  const startX = down.clientX;
  const startY = down.clientY;
  const canDragOut = isTauri();
  let payload: DragPayload | null = null;
  let stage: Stage | null = null;
  let native = false;
  let ended = false;

  const setOut = (out: DragState["out"]) => useDrag.setState({ out });

  const ensureStage = (p: DragPayload) => {
    if (stage || p.from !== "device") return;
    setOut({ phase: "preparing", bytes: 0, total: 0 });
    stage = stageDeviceFiles(p.serial, p.entries, (bytes, total) => {
      if (!ended) setOut({ phase: "preparing", bytes, total });
    });
    stage.done.then(
      (paths) => {
        if (ended) return;
        setOut({ phase: "ready", bytes: 0, total: 0 });
        if (useDrag.getState().outside) goNative(paths);
      },
      (error: AppError) => {
        if (ended || error?.kind === "cancelled") return;
        setOut({ phase: "failed", bytes: 0, total: 0 });
        toast.error(
          i18n.t("files:dragOut.failed", {
            name: p.entries[0]?.name ?? "",
          }),
          { description: error?.message },
        );
      },
    );
  };

  const goNative = (paths: string[]) => {
    if (native || ended || !payload) return;
    native = true;
    const icon = dragIcon(payload.entries);
    startNativeDrag(paths, icon, () => {}).catch((e: AppError) =>
      toast.error(e?.message ?? String(e)),
    );
    // The OS owns the drag now; the webview gets no pointerup.
    finish(false);
  };

  const onMove = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    if (!payload) {
      if (Math.hypot(e.clientX - startX, e.clientY - startY) < THRESHOLD)
        return;
      payload = getPayload(rowPath);
      if (!payload || payload.entries.length === 0) {
        finish(false);
        return;
      }
      try {
        container.setPointerCapture(pointerId);
      } catch {
        // Already released; window listeners still track the pointer.
      }
      document.body.style.userSelect = "none";
      document.body.style.cursor = "grabbing";
      window.getSelection()?.removeAllRanges();
      useDrag.setState({ payload, out: IDLE_OUT });
      const small =
        payload.entries.every((x) => !isDirLike(x)) &&
        payload.entries.reduce((n, x) => n + x.size, 0) <= EAGER_STAGE_MAX;
      if (canDragOut && small) ensureStage(payload);
    }
    const outside =
      e.clientX < 0 ||
      e.clientY < 0 ||
      e.clientX >= window.innerWidth ||
      e.clientY >= window.innerHeight;
    useDrag.setState({
      x: e.clientX,
      y: e.clientY,
      outside,
      target: outside ? null : dropTargetAt(e.clientX, e.clientY, payload.from),
    });
    if (outside && canDragOut) {
      if (payload.from === "local")
        goNative(payload.entries.map((x) => x.path));
      else {
        ensureStage(payload);
        const ready = (stage as Stage | null)?.paths;
        if (ready) goNative(ready);
      }
    }
  };

  const onUp = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    if (payload) {
      const { target } = useDrag.getState();
      if (target) performDrop(payload, target);
      swallowNextClick();
    }
    finish(true);
  };

  const onCancel = (e: PointerEvent) => {
    if (e.pointerId === pointerId) finish(true);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || !payload) return;
    e.preventDefault();
    e.stopPropagation();
    swallowNextClick();
    finish(true);
  };

  function finish(cancelStage: boolean) {
    if (ended) return;
    ended = true;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    window.removeEventListener("keydown", onKey, true);
    try {
      if (container.hasPointerCapture(pointerId))
        container.releasePointerCapture(pointerId);
    } catch {
      // The element may be gone.
    }
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    // Staged files that were handed to the OS stay until the next sweep.
    if (cancelStage && stage && !stage.paths) stage.cancel();
    if (payload)
      useDrag.setState({
        payload: null,
        target: null,
        outside: false,
        out: IDLE_OUT,
      });
  }

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
  window.addEventListener("keydown", onKey, true);
}
