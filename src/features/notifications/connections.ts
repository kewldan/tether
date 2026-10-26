import type { Device } from "@/lib/tauri";

export interface ConnectionChange {
  serial: string;
  online: boolean;
}

/** Serials that are connected and authorized. */
export function onlineSerials(devices: Device[]): Set<string> {
  return new Set(
    devices.filter((d) => d.state.kind === "device").map((d) => d.serial),
  );
}

/**
 * Which devices are online, as last announced. Changes are only reported
 * when they still hold after a settle delay, so a device that drops and
 * comes back within it (cable wiggle, `adb reconnect`, Wi-Fi blip) is not
 * announced at all.
 */
export class ConnectionTracker {
  private stable = new Set<string>();
  private primed = false;

  /** Forget the baseline: the next list is taken as is (server restart). */
  reset() {
    this.primed = false;
  }

  /**
   * Feeds a new list. Returns true when it differs from the announced
   * state, i.e. a settle check should be scheduled. The first list after
   * start or `reset` only sets the baseline.
   */
  observe(online: Set<string>): boolean {
    if (!this.primed) {
      this.stable = new Set(online);
      this.primed = true;
      return false;
    }
    return this.diff(online).length > 0;
  }

  /** After the settle delay: what changed for good, now announced. */
  settle(online: Set<string>): ConnectionChange[] {
    if (!this.primed) {
      this.observe(online);
      return [];
    }
    const changes = this.diff(online);
    this.stable = new Set(online);
    return changes;
  }

  private diff(online: Set<string>): ConnectionChange[] {
    const changes: ConnectionChange[] = [];
    for (const serial of online)
      if (!this.stable.has(serial)) changes.push({ serial, online: true });
    for (const serial of this.stable)
      if (!online.has(serial)) changes.push({ serial, online: false });
    return changes;
  }
}
