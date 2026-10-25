import type { Level, LogEntry } from "./api";

/** A log entry with an id that stays unique across stream sessions. */
export interface LogLine extends LogEntry {
  id: number;
}

/** Lines kept in memory; older ones are dropped. */
export const DEFAULT_CAPACITY = 100_000;

const emptyCounts = (): Record<Level, number> => ({
  V: 0,
  D: 0,
  I: 0,
  W: 0,
  E: 0,
  F: 0,
});

/**
 * Bounded, append-only store of log lines with running statistics. Lives
 * outside React; `generation` changes on clear so views know to rebuild.
 */
export class LogBuffer {
  lines: LogLine[] = [];
  counts = emptyCounts();
  tags = new Map<string, number>();
  crashes = 0;
  /** Last known process name per pid, from ActivityManager and crashes. */
  processes = new Map<number, string>();
  generation = 0;
  private nextId = 0;

  constructor(readonly capacity = DEFAULT_CAPACITY) {}

  get size() {
    return this.lines.length;
  }

  /** Id of the oldest line still kept. */
  get firstId() {
    return this.lines[0]?.id ?? this.nextId;
  }

  get last(): LogLine | undefined {
    return this.lines[this.lines.length - 1];
  }

  append(entries: LogEntry[]): LogLine[] {
    const added: LogLine[] = new Array(entries.length);
    for (let i = 0; i < entries.length; i++) {
      const line = entries[i] as LogLine;
      line.id = this.nextId++;
      added[i] = line;
      this.lines.push(line);
      this.counts[line.level]++;
      this.tags.set(line.tag, (this.tags.get(line.tag) ?? 0) + 1);
      if (line.crash) {
        this.crashes++;
        if (line.crash.pid !== null && line.crash.process)
          this.processes.set(line.crash.pid, line.crash.process);
      }
      if (line.processEvent?.kind === "started")
        this.processes.set(line.processEvent.pid, line.processEvent.process);
    }
    // Trim in chunks so the array is not shifted on every batch.
    if (this.lines.length > this.capacity * 1.1) {
      this.drop(this.lines.length - this.capacity);
    }
    return added;
  }

  private drop(count: number) {
    const removed = this.lines.splice(0, count);
    for (const line of removed) {
      this.counts[line.level]--;
      const n = (this.tags.get(line.tag) ?? 1) - 1;
      if (n <= 0) this.tags.delete(line.tag);
      else this.tags.set(line.tag, n);
      if (line.crash) this.crashes--;
    }
  }

  clear() {
    this.lines = [];
    this.counts = emptyCounts();
    this.tags.clear();
    this.crashes = 0;
    this.generation++;
  }

  /** Puts back lines removed by `clear` (undo). */
  restore(lines: LogLine[]) {
    const newer = this.lines;
    this.clear();
    for (const line of [...lines, ...newer]) {
      this.lines.push(line);
      this.counts[line.level]++;
      this.tags.set(line.tag, (this.tags.get(line.tag) ?? 0) + 1);
      if (line.crash) this.crashes++;
    }
  }

  /** Index of the line with `id`, by binary search (ids are increasing). */
  indexOf(id: number): number {
    let lo = 0;
    let hi = this.lines.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const v = this.lines[mid].id;
      if (v === id) return mid;
      if (v < id) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  /** First index whose id is greater than `id`. */
  indexAfter(id: number): number {
    let lo = 0;
    let hi = this.lines.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.lines[mid].id <= id) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  topTags(limit: number): [string, number][] {
    return [...this.tags.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
  }
}
