import type { LogBuffer, LogLine } from "./buffer";
import type { CompiledFilter } from "./filter";

export type Row =
  | { kind: "line"; key: number; line: LogLine }
  | {
      kind: "restart";
      key: string;
      pkg: string;
      from: number;
      to: number;
    };

/**
 * The filtered rows of a `LogBuffer`. New lines are filtered incrementally;
 * only a filter change or a clear rebuilds everything.
 */
export class LogView {
  rows: Row[] = [];
  /** Shown lines that match the search (for the counter and highlight). */
  matches = 0;
  private key: string | null = null;
  private generation = -1;
  private lastId = -1;
  private mainPid: number | null = null;
  private pending = { from: -1, count: 0 };

  /** True when a sync would rebuild instead of appending. */
  isStale(buffer: LogBuffer, key: string) {
    return key !== this.key || buffer.generation !== this.generation;
  }

  /** Brings rows up to date. Returns true when they changed. */
  sync(
    buffer: LogBuffer,
    filter: CompiledFilter,
    key: string,
    pkg: string | null,
  ): boolean {
    if (key !== this.key || buffer.generation !== this.generation) {
      this.key = key;
      this.generation = buffer.generation;
      this.rows = [];
      this.matches = 0;
      this.lastId = -1;
      this.mainPid = null;
      this.scan(buffer.lines, 0, filter, pkg);
      this.pending = { from: -1, count: 0 };
      return true;
    }
    const start = buffer.indexAfter(this.lastId);
    const before = this.rows.length;
    this.scan(buffer.lines, start, filter, pkg);
    const trimmed = this.trim(buffer.firstId);
    this.pending = { from: -1, count: 0 };
    return trimmed || this.rows.length !== before;
  }

  /** Lines that arrived after the last sync and would be shown. */
  countPending(buffer: LogBuffer, filter: CompiledFilter): number {
    if (this.pending.from < 0) this.pending = { from: this.lastId, count: 0 };
    const lines = buffer.lines;
    let i = buffer.indexAfter(this.pending.from);
    for (; i < lines.length; i++) {
      if (filter.test(lines[i])) this.pending.count++;
      this.pending.from = lines[i].id;
    }
    return this.pending.count;
  }

  private scan(
    lines: LogLine[],
    start: number,
    filter: CompiledFilter,
    pkg: string | null,
  ) {
    const { matcher } = filter;
    for (let i = start; i < lines.length; i++) {
      const line = lines[i];
      if (!filter.test(line)) continue;
      const ev = line.processEvent;
      if (pkg && ev && ev.process === pkg) {
        if (
          ev.kind === "started" &&
          this.mainPid !== null &&
          this.mainPid !== ev.pid
        ) {
          this.rows.push({
            kind: "restart",
            key: `r${line.id}`,
            pkg,
            from: this.mainPid,
            to: ev.pid,
          });
        }
        this.mainPid = ev.pid;
      }
      this.rows.push({ kind: "line", key: line.id, line });
      if (matcher && (matcher.test(line.message) || matcher.test(line.tag)))
        this.matches++;
    }
    if (lines.length > 0) this.lastId = lines[lines.length - 1].id;
  }

  /** Drops rows of lines the buffer no longer keeps. */
  private trim(firstId: number): boolean {
    const rows = this.rows;
    if (rows.length === 0) return false;
    const first = rows[0];
    if (first.kind === "line" && first.line.id >= firstId) return false;
    let lo = 0;
    let hi = rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const r = rows[mid];
      const id = r.kind === "line" ? r.line.id : Number(r.key.slice(1));
      if (id < firstId) lo = mid + 1;
      else hi = mid;
    }
    if (lo === 0) return false;
    this.rows = rows.slice(lo);
    return true;
  }
}

/** Rows for "Show ±N lines around": unfiltered neighbours of one line. */
export function contextRows(
  buffer: LogBuffer,
  centerId: number,
  radius: number,
): Row[] {
  const i = buffer.indexOf(centerId);
  if (i < 0) return [];
  return buffer.lines
    .slice(Math.max(0, i - radius), i + radius + 1)
    .map((line) => ({ kind: "line", key: line.id, line }));
}
