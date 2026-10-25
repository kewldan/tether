import { create } from "zustand";

import type { AppError } from "@/lib/tauri";

import {
  clearLogcat,
  type LogcatEvent,
  type LogEntry,
  packageProcesses,
  startLogcat,
  stopLogcat,
} from "./api";
import { LogBuffer, type LogLine } from "./buffer";
import type { PackageScope } from "./filter";

/** Backlog fetched when a stream starts fresh. */
const BACKLOG = 5000;
const RESOLVE_INTERVAL = 10_000;

export type StreamStatus =
  | "idle"
  | "connecting"
  | "streaming"
  | "ended"
  | "error";

interface SessionState {
  serial: string | null;
  status: StreamStatus;
  error: AppError | null;
  /** Lines received during the last second. */
  rate: number;
  /** Bumped after every batch so views re-sync with `logBuffer`. */
  version: number;
  /** Crash blocks currently in the buffer. */
  crashCount: number;
  /** Crashes that arrived while the Logcat page was not open. */
  unseenCrashes: number;
  /** Device time of the last line, shown when the stream stops. */
  lastTime: string | null;
  scope: PackageScope | null;
}

/**
 * Low-frequency state of the logcat stream. The lines themselves live in
 * `logBuffer`; subscribe to `version` to follow them. The stream keeps
 * running when the user leaves the page, so `unseenCrashes` can drive a
 * sidebar badge (`useLogcatSession((s) => s.unseenCrashes)`).
 */
export const useLogcatSession = create<SessionState>()(() => ({
  serial: null,
  status: "idle",
  error: null,
  rate: 0,
  version: 0,
  crashCount: 0,
  unseenCrashes: 0,
  lastTime: null,
  scope: null,
}));

export const logBuffer = new LogBuffer();

const set = useLogcatSession.setState;
const get = useLogcatSession.getState;

const timestamp = (e: LogEntry) => `${e.date} ${e.time}`;

const sameLine = (a: LogEntry, b: LogEntry) =>
  a.pid === b.pid &&
  a.tid === b.tid &&
  a.tag === b.tag &&
  a.level === b.level &&
  a.message === b.message;

class LogcatController {
  private session: number | null = null;
  /** Incremented per start; events of older streams are ignored. */
  private token = 0;
  private buffers: string[] = [];
  private pageVisible = false;
  private received = 0;
  private rateTimer: ReturnType<typeof setInterval> | null = null;
  private resolveTimer: ReturnType<typeof setInterval> | null = null;
  /** After a reconnect the backlog repeats lines up to this time. */
  private resumeAfter: { time: string; tail: LogLine[] } | null = null;

  /**
   * Makes sure `serial` is streaming `buffers`. Reconnecting to the same
   * device continues where the previous stream stopped; a different device
   * or buffer set starts over.
   */
  connect(serial: string, buffers: string[]) {
    const { serial: current, status } = get();
    const sameBuffers = buffers.join() === this.buffers.join();
    if (
      current === serial &&
      sameBuffers &&
      (status === "connecting" || status === "streaming")
    )
      return;

    const last = logBuffer.last;
    const resume = current === serial && sameBuffers && last !== undefined;
    this.halt();
    this.buffers = buffers;

    if (resume) {
      this.resumeAfter = {
        time: timestamp(last),
        tail: logBuffer.lines.slice(-200),
      };
    } else {
      this.resumeAfter = null;
      logBuffer.clear();
    }
    set({
      serial,
      status: "connecting",
      error: null,
      crashCount: logBuffer.crashes,
      version: get().version + 1,
    });

    const token = ++this.token;
    startLogcat(
      serial,
      {
        buffers,
        tail: resume ? null : BACKLOG,
        since: resume && this.resumeAfter ? this.resumeAfter.time : null,
      },
      (event) => {
        if (token === this.token) this.onEvent(event);
      },
    )
      .then((id) => {
        if (token !== this.token) {
          void stopLogcat(id);
          return;
        }
        this.session = id;
        if (get().status === "connecting") set({ status: "streaming" });
      })
      .catch((error: AppError) => {
        if (token === this.token) set({ status: "error", error });
      });
    this.startRate();
  }

  /** Stops the stream and forgets the device and its lines. */
  reset() {
    this.halt();
    this.resumeAfter = null;
    logBuffer.clear();
    set({
      serial: null,
      status: "idle",
      error: null,
      crashCount: 0,
      lastTime: null,
      version: get().version + 1,
    });
  }

  /** Stops the stream; lines are kept. */
  halt() {
    this.token++;
    if (this.session !== null) void stopLogcat(this.session);
    this.session = null;
  }

  /**
   * Clears the view and the device buffers. `undo` brings the lines back
   * into the view (the device copy is gone); `done` settles when the device
   * has been cleared.
   */
  clear(): { undo: () => void; done: Promise<void> } {
    const saved = logBuffer.lines;
    logBuffer.clear();
    set({ version: get().version + 1, crashCount: 0 });
    const { serial } = get();
    const done = serial ? clearLogcat(serial, this.buffers) : Promise.resolve();
    const undo = () => {
      logBuffer.restore(saved);
      set({ version: get().version + 1, crashCount: logBuffer.crashes });
    };
    return { undo, done };
  }

  setPageVisible(visible: boolean) {
    this.pageVisible = visible;
    if (visible) set({ unseenCrashes: 0 });
  }

  /** Filters by a package: resolves its uid and pids and keeps following them. */
  setPackage(serial: string | null, name: string | null) {
    if (this.resolveTimer) clearInterval(this.resolveTimer);
    this.resolveTimer = null;
    if (!name) {
      set({ scope: null });
      return;
    }
    const prev = get().scope;
    if (prev?.name !== name)
      set({ scope: { name, uid: null, pids: new Set() } });
    if (!serial) return;

    const resolve = () =>
      packageProcesses(serial, name)
        .then((info) => {
          const scope = get().scope;
          if (scope?.name !== name) return;
          const pids = new Set(scope.pids);
          for (const p of info.processes) pids.add(p.pid);
          if (pids.size !== scope.pids.size || info.uid !== scope.uid)
            set({ scope: { name, uid: info.uid, pids } });
        })
        .catch(() => {});
    void resolve();
    this.resolveTimer = setInterval(resolve, RESOLVE_INTERVAL);
  }

  private onEvent(event: LogcatEvent) {
    if (event.type === "ended") {
      this.session = null;
      set({
        status: event.error ? "error" : "ended",
        error: event.error,
        lastTime: logBuffer.last ? timestamp(logBuffer.last) : null,
      });
      return;
    }

    let entries = event.entries;
    if (this.resumeAfter) entries = this.skipRepeated(entries);
    if (entries.length === 0) return;

    logBuffer.append(entries);
    this.received += entries.length;
    this.followPackage(entries);

    const newCrashes = entries.reduce((n, e) => n + (e.crash ? 1 : 0), 0);
    set({
      status: "streaming",
      version: get().version + 1,
      crashCount: logBuffer.crashes,
      unseenCrashes: get().unseenCrashes + (this.pageVisible ? 0 : newCrashes),
    });
  }

  /** Drops the part of a resumed backlog we already have. */
  private skipRepeated(entries: LogEntry[]): LogEntry[] {
    const resume = this.resumeAfter;
    if (!resume) return entries;
    const out: LogEntry[] = [];
    let passed = false;
    for (const e of entries) {
      if (!passed) {
        const ts = timestamp(e);
        if (ts < resume.time) continue;
        if (ts === resume.time && resume.tail.some((t) => sameLine(t, e)))
          continue;
        passed = true;
      }
      out.push(e);
    }
    if (passed) this.resumeAfter = null;
    return out;
  }

  /** Adds restarted processes of the filtered package to its pids. */
  private followPackage(entries: LogEntry[]) {
    const scope = get().scope;
    if (!scope) return;
    let pids: Set<number> | null = null;
    for (const e of entries) {
      const ev = e.processEvent;
      if (
        ev?.kind === "started" &&
        (ev.process === scope.name ||
          ev.process.startsWith(`${scope.name}:`)) &&
        !scope.pids.has(ev.pid)
      ) {
        pids ??= new Set(scope.pids);
        pids.add(ev.pid);
      }
    }
    if (pids) set({ scope: { ...scope, pids } });
  }

  private startRate() {
    if (this.rateTimer) return;
    this.rateTimer = setInterval(() => {
      const rate = this.received;
      this.received = 0;
      if (rate !== get().rate) set({ rate });
    }, 1000);
  }
}

export const logcat = new LogcatController();
