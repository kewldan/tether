import type { CrashKind, LogEntry } from "@/features/logcat/api";

export interface CrashReport {
  serial: string;
  /** Package of the crashed process, without the `:service` suffix. */
  app: string | null;
  kind: CrashKind;
  /** Exception line, signal line or ANR reason. */
  title: string;
  /** The whole crash block, for "Copy trace". */
  trace: string;
}

export interface CrashGroup {
  app: string | null;
  reports: CrashReport[];
}

/** `com.example.shop:sync` → `com.example.shop`. */
export function packageOf(process: string | null): string | null {
  const name = process?.split(":")[0]?.trim();
  return name ? name : null;
}

/** Identifies one crash report across streams of the same device. */
export function crashKey(serial: string, entry: LogEntry): string {
  return `${serial}|${entry.date} ${entry.time}|${entry.pid}|${entry.crash?.kind ?? ""}`;
}

/**
 * Crash reports already taken, so one caught by both the Logcat page's
 * stream and the background watcher is announced once.
 */
export class SeenCrashes {
  private keys = new Set<string>();

  constructor(private readonly max = 500) {}

  /** Records `key`; false when it was already there. */
  add(key: string): boolean {
    if (this.keys.has(key)) return false;
    this.keys.add(key);
    if (this.keys.size > this.max) {
      const oldest = this.keys.values().next().value;
      if (oldest !== undefined) this.keys.delete(oldest);
    }
    return true;
  }
}

/**
 * Groups a burst of crashes by app and drops apps announced within the
 * cooldown, so a crash loop (the system restarting a service that dies
 * again) produces one notice per minute instead of one per restart.
 */
export class CrashThrottle {
  private announced = new Map<string, number>();

  constructor(private readonly cooldownMs = 60_000) {}

  take(reports: CrashReport[], now: number): CrashGroup[] {
    const groups = new Map<string, CrashGroup>();
    for (const report of reports) {
      const key = report.app ?? "";
      let group = groups.get(key);
      if (!group) {
        group = { app: report.app, reports: [] };
        groups.set(key, group);
      }
      group.reports.push(report);
    }
    const fresh: CrashGroup[] = [];
    for (const [key, group] of groups) {
      const last = this.announced.get(key);
      if (last !== undefined && now - last < this.cooldownMs) continue;
      this.announced.set(key, now);
      fresh.push(group);
    }
    return fresh;
  }
}
