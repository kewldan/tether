import {
  type KeyboardEvent,
  type MouseEvent,
  useCallback,
  useMemo,
} from "react";
import type { StoreApi, UseBoundStore } from "zustand";

import { hasMod } from "@/lib/platform";

import type { FileEntry } from "./api";
import type { BrowserState, ViewMode } from "./store";

type BrowserStore = UseBoundStore<StoreApi<BrowserState>>;

/**
 * Click, shift/⌘-click, checkbox and keyboard-cursor selection over a list
 * of entries, shared by the device and the computer pane.
 */
export function useSelection<E extends FileEntry>(
  entries: E[],
  store: BrowserStore,
) {
  const selected = store((s) => s.selected);
  const anchor = store((s) => s.anchor);
  const setSelected = store((s) => s.setSelected);

  const selection = useMemo(
    () => entries.filter((e) => selected.has(e.path)),
    [entries, selected],
  );

  const select = useCallback(
    (paths: string[], cursor: string | null) =>
      setSelected(new Set(paths), cursor),
    [setSelected],
  );

  const onRowClick = useCallback(
    (entry: FileEntry, e: MouseEvent) => {
      if (e.shiftKey && anchor) {
        const a = entries.findIndex((x) => x.path === anchor);
        const b = entries.findIndex((x) => x.path === entry.path);
        if (a >= 0 && b >= 0) {
          const [from, to] = a < b ? [a, b] : [b, a];
          setSelected(
            new Set(entries.slice(from, to + 1).map((x) => x.path)),
            anchor,
          );
          return;
        }
      }
      if (e.metaKey || e.ctrlKey) {
        const next = new Set(selected);
        if (next.has(entry.path)) next.delete(entry.path);
        else next.add(entry.path);
        setSelected(next, entry.path);
        return;
      }
      select([entry.path], entry.path);
    },
    [anchor, entries, selected, select, setSelected],
  );

  const onToggle = useCallback(
    (entry: FileEntry) => {
      const next = new Set(selected);
      if (next.has(entry.path)) next.delete(entry.path);
      else next.add(entry.path);
      setSelected(next, entry.path);
    },
    [selected, setSelected],
  );

  const onToggleAll = useCallback(() => {
    if (selection.length === entries.length) select([], null);
    else
      select(
        entries.map((e) => e.path),
        anchor,
      );
  }, [selection.length, entries, select, anchor]);

  /**
   * Cursor keys, Home/End, ⌘A and Escape. Returns true when the key was
   * handled (the caller handles Enter, Delete and friends).
   */
  const navKey = useCallback(
    (e: KeyboardEvent<HTMLElement>, view: ViewMode): boolean => {
      if (hasMod(e) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        select(
          entries.map((x) => x.path),
          anchor,
        );
        return true;
      }
      const index = anchor ? entries.findIndex((x) => x.path === anchor) : -1;
      const moveTo = (i: number) => {
        const next = entries[Math.max(0, Math.min(entries.length - 1, i))];
        if (!next) return true;
        e.preventDefault();
        if (e.shiftKey && anchor) {
          const sel = new Set(selected);
          sel.add(next.path);
          setSelected(sel, next.path);
        } else {
          select([next.path], next.path);
        }
        return true;
      };
      switch (e.key) {
        case "ArrowDown":
          return hasMod(e) ? false : moveTo(index + 1);
        case "ArrowUp":
          return hasMod(e) || e.altKey
            ? false
            : moveTo(index < 0 ? 0 : index - 1);
        case "ArrowRight":
          return view === "grid" ? moveTo(index + 1) : false;
        case "ArrowLeft":
          return view === "grid" ? moveTo(index - 1) : false;
        case "Home":
          return moveTo(0);
        case "End":
          return moveTo(entries.length - 1);
        case "Escape":
          if (selected.size === 0) return false;
          e.preventDefault();
          select([], null);
          return true;
      }
      return false;
    },
    [anchor, entries, select, selected, setSelected],
  );

  /** Entries a drag starting on `path` carries: the selection if the row
   * is part of it, otherwise just that row (which becomes the selection). */
  const dragEntries = useCallback(
    (path: string): E[] => {
      if (selected.has(path)) return selection;
      const entry = entries.find((x) => x.path === path);
      if (!entry) return [];
      select([path], path);
      return [entry];
    },
    [entries, select, selected, selection],
  );

  return {
    selected,
    anchor,
    selection,
    select,
    setSelected,
    onRowClick,
    onToggle,
    onToggleAll,
    navKey,
    dragEntries,
  };
}
