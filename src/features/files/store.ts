import { create } from "zustand";
import { persist } from "zustand/middleware";

import { normalize } from "./paths";

export type SortKey = "name" | "size" | "mtime" | "permissions";
export type ViewMode = "list" | "grid";

export interface Bookmark {
  path: string;
  label: string;
}

export const HOME = "/sdcard";

interface FilesPrefs {
  view: ViewMode;
  showHidden: boolean;
  sort: { key: SortKey; desc: boolean };
  bookmarks: Bookmark[];
  /** Local folder for downloads; null → the OS Downloads folder. */
  downloadDir: string | null;
  /** Last folder per device serial. */
  lastPath: Record<string, string>;
  setView: (view: ViewMode) => void;
  toggleHidden: () => void;
  sortBy: (key: SortKey) => void;
  addBookmark: (bookmark: Bookmark) => void;
  removeBookmark: (path: string) => void;
  setDownloadDir: (dir: string | null) => void;
  rememberPath: (serial: string, path: string) => void;
}

/** File manager preferences, kept in localStorage. */
export const useFilesPrefs = create<FilesPrefs>()(
  persist(
    (set) => ({
      view: "list",
      showHidden: false,
      sort: { key: "name", desc: false },
      bookmarks: [],
      downloadDir: null,
      lastPath: {},
      setView: (view) => set({ view }),
      toggleHidden: () => set((s) => ({ showHidden: !s.showHidden })),
      sortBy: (key) =>
        set((s) => ({
          sort:
            s.sort.key === key
              ? { key, desc: !s.sort.desc }
              : { key, desc: key === "mtime" || key === "size" },
        })),
      addBookmark: (bookmark) =>
        set((s) =>
          s.bookmarks.some((b) => b.path === bookmark.path)
            ? s
            : { bookmarks: [...s.bookmarks, bookmark] },
        ),
      removeBookmark: (path) =>
        set((s) => ({ bookmarks: s.bookmarks.filter((b) => b.path !== path) })),
      setDownloadDir: (downloadDir) => set({ downloadDir }),
      rememberPath: (serial, path) =>
        set((s) => ({ lastPath: { ...s.lastPath, [serial]: path } })),
    }),
    { name: "tether.files" },
  ),
);

interface BrowserState {
  path: string;
  back: string[];
  forward: string[];
  /** Selected entry paths. */
  selected: Set<string>;
  /** Anchor for shift-click range selection. */
  anchor: string | null;
  query: string;
  go: (path: string) => void;
  goBack: () => void;
  goForward: () => void;
  reset: (path: string) => void;
  setSelected: (selected: Set<string>, anchor?: string | null) => void;
  setQuery: (query: string) => void;
}

/** The folder being browsed, history and selection (not persisted). */
export const useBrowser = create<BrowserState>()((set, get) => ({
  path: HOME,
  back: [],
  forward: [],
  selected: new Set(),
  anchor: null,
  query: "",
  go: (raw) => {
    const path = normalize(raw);
    const { path: current, back } = get();
    if (path === current) return;
    set({
      path,
      back: [...back, current].slice(-100),
      forward: [],
      selected: new Set(),
      anchor: null,
      query: "",
    });
  },
  goBack: () => {
    const { back, path, forward } = get();
    const target = back[back.length - 1];
    if (target === undefined) return;
    set({
      path: target,
      back: back.slice(0, -1),
      forward: [path, ...forward],
      selected: new Set(),
      anchor: null,
      query: "",
    });
  },
  goForward: () => {
    const { back, path, forward } = get();
    const [target, ...rest] = forward;
    if (target === undefined) return;
    set({
      path: target,
      back: [...back, path],
      forward: rest,
      selected: new Set(),
      anchor: null,
      query: "",
    });
  },
  reset: (path) =>
    set({
      path: normalize(path),
      back: [],
      forward: [],
      selected: new Set(),
      anchor: null,
      query: "",
    }),
  setSelected: (selected, anchor) =>
    set((s) => ({
      selected,
      anchor: anchor === undefined ? s.anchor : anchor,
    })),
  setQuery: (query) => set({ query }),
}));
