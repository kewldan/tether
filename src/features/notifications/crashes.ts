import type { CrashKind } from "@/features/logcat/api";

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
