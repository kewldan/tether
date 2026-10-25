import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface Snippet {
  id: string;
  name: string;
  command: string;
}

export type SessionStatus = "connecting" | "running" | "exited" | "error";

/** What the UI shows about a terminal; the terminal itself lives in sessions.ts. */
export interface SessionMeta {
  uid: string;
  serial: string;
  status: SessionStatus;
  exitCode: number | null;
  /** `root` when the shell runs as uid 0. */
  user: "sh" | "root";
  /** Whether `su` exists on the device (null = unknown yet). */
  hasSu: boolean | null;
  cols: number;
  rows: number;
  error: string | null;
}

const DEFAULT_SNIPPETS: Snippet[] = [
  {
    id: "start-activity",
    name: "Start activity",
    command: "am start -n {package}/{activity}",
  },
  {
    id: "reset-relaunch",
    name: "Reset app & relaunch",
    command: "pm clear {package} && monkey -p {package} 1",
  },
  {
    id: "battery-unplug",
    name: "Battery: unplug sim",
    command: "dumpsys battery unplug",
  },
  {
    id: "current-activity",
    name: "Dump current activity",
    command: "dumpsys activity activities | grep mResumed",
  },
];

const MAX_HISTORY = 200;

interface ShellState {
  sessions: SessionMeta[];
  active: string | null;
  /** Session shown in the right half when split. */
  split: string | null;
  snippets: Snippet[];
  /** Remembered values of snippet variables, by name. */
  vars: Record<string, string>;
  history: string[];
  /** Serials for "run on devices". */
  targets: string[];
  upsertSession: (meta: SessionMeta) => void;
  patchSession: (uid: string, patch: Partial<SessionMeta>) => void;
  removeSession: (uid: string) => void;
  setActive: (uid: string | null) => void;
  setSplit: (uid: string | null) => void;
  saveSnippet: (snippet: Snippet) => void;
  deleteSnippet: (id: string) => void;
  setVar: (name: string, value: string) => void;
  remember: (command: string) => void;
  clearHistory: () => void;
  setTargets: (serials: string[]) => void;
}

export const useShellStore = create<ShellState>()(
  persist(
    (set) => ({
      sessions: [],
      active: null,
      split: null,
      snippets: DEFAULT_SNIPPETS,
      vars: {},
      history: [],
      targets: [],
      upsertSession: (meta) =>
        set((s) => ({
          sessions: s.sessions.some((x) => x.uid === meta.uid)
            ? s.sessions.map((x) => (x.uid === meta.uid ? meta : x))
            : [...s.sessions, meta],
        })),
      patchSession: (uid, patch) =>
        set((s) => ({
          sessions: s.sessions.map((x) =>
            x.uid === uid ? { ...x, ...patch } : x,
          ),
        })),
      removeSession: (uid) =>
        set((s) => {
          const i = s.sessions.findIndex((x) => x.uid === uid);
          const sessions = s.sessions.filter((x) => x.uid !== uid);
          const fallback =
            sessions[Math.min(i, sessions.length - 1)]?.uid ?? null;
          const split = s.split === uid ? null : s.split;
          let active = s.active === uid ? fallback : s.active;
          if (active !== null && active === split) {
            active = sessions.find((x) => x.uid !== split)?.uid ?? null;
          }
          return { sessions, active, split: active === null ? null : split };
        }),
      setActive: (active) =>
        set((s) => ({
          active,
          split: s.split === active ? null : s.split,
        })),
      setSplit: (split) => set({ split }),
      saveSnippet: (snippet) =>
        set((s) => ({
          snippets: s.snippets.some((x) => x.id === snippet.id)
            ? s.snippets.map((x) => (x.id === snippet.id ? snippet : x))
            : [...s.snippets, snippet],
        })),
      deleteSnippet: (id) =>
        set((s) => ({ snippets: s.snippets.filter((x) => x.id !== id) })),
      setVar: (name, value) =>
        set((s) => ({ vars: { ...s.vars, [name]: value } })),
      remember: (command) =>
        set((s) => ({
          history: [command, ...s.history.filter((h) => h !== command)].slice(
            0,
            MAX_HISTORY,
          ),
        })),
      clearHistory: () => set({ history: [] }),
      setTargets: (targets) => set({ targets }),
    }),
    {
      name: "tether.shell",
      partialize: (s) => ({
        snippets: s.snippets,
        vars: s.vars,
        history: s.history,
        targets: s.targets,
      }),
    },
  ),
);
