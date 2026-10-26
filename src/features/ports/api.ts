import { invoke } from "@tauri-apps/api/core";

export type Direction = "forward" | "reverse";

/**
 * One rule as adb lists it. `local` is the listening side (this computer
 * for forward, the device for reverse), `remote` where connections go.
 */
export interface PortRule {
  direction: Direction;
  local: string;
  remote: string;
}

export interface PortRules {
  forward: PortRule[];
  reverse: PortRule[];
}

export const listPorts = (serial: string) =>
  invoke<PortRules>("ports_list", { serial });

/** Returns the port adb picked when `local` is `tcp:0`. */
export const addPort = (
  serial: string,
  direction: Direction,
  local: string,
  remote: string,
) => invoke<number | null>("ports_add", { serial, direction, local, remote });

export const removePort = (
  serial: string,
  direction: Direction,
  local: string,
) => invoke<void>("ports_remove", { serial, direction, local });

export const removeAllPorts = (serial: string) =>
  invoke<void>("ports_remove_all", { serial });

export interface PortOwner {
  pid: number;
  /** null when the process belongs to another user. */
  name: string | null;
}

/** What is happening on one TCP port of this computer. */
export interface HostPortUsage {
  port: number;
  /** Established connections accepted on the port. */
  connections: number;
  /** Process listening on the port. */
  listener: PortOwner | null;
}

export const hostPortUsage = (ports: number[]) =>
  invoke<HostPortUsage[]>("ports_host_usage", { ports });

export const freeHostPort = (start: number) =>
  invoke<number | null>("ports_free_host_port", { start });

const DEVICE_KINDS = [
  "tcp:",
  "localabstract:",
  "localreserved:",
  "localfilesystem:",
  "dev:",
  "jdwp:",
  "vsock:",
];

export type SpecResult =
  | { ok: true; spec: string }
  | { ok: false; reason: "empty" | "port" | "hostTcp" | "kind" | "jdwp" };

/**
 * Turns what the user typed into an adb socket spec: a bare number means
 * `tcp:<n>`. The host side only accepts TCP ports; the device side also
 * unix sockets and `jdwp:<pid>`.
 */
export function parseSpec(input: string, hostSide: boolean): SpecResult {
  const value = input.trim();
  if (!value) return { ok: false, reason: "empty" };
  if (/\s|;/.test(value)) return { ok: false, reason: "kind" };
  const port = /^(?:tcp:)?(\d+)$/.exec(value);
  if (port) {
    const n = Number(port[1]);
    return n >= 1 && n <= 65535
      ? { ok: true, spec: `tcp:${n}` }
      : { ok: false, reason: "port" };
  }
  if (hostSide) return { ok: false, reason: "hostTcp" };
  const kind = DEVICE_KINDS.find((k) => value.startsWith(k));
  if (!kind || value.length === kind.length)
    return { ok: false, reason: "kind" };
  if (kind === "jdwp:" && !/^jdwp:\d+$/.test(value)) {
    return { ok: false, reason: "jdwp" };
  }
  if (kind === "tcp:") return { ok: false, reason: "port" };
  return { ok: true, spec: value };
}

/** `tcp:8081` → `8081`, other specs unchanged. */
export function shortSpec(spec: string): string {
  return spec.startsWith("tcp:") ? spec.slice(4) : spec;
}

export function tcpPort(spec: string): number | null {
  const m = /^tcp:(\d+)$/.exec(spec);
  return m ? Number(m[1]) : null;
}

export function isAddressInUse(message: string): boolean {
  return /address already in use/i.test(message);
}

/** i18n key (in `ports`) of a well-known rule's label. */
export function knownLabel(rule: PortRule): string | null {
  const { direction, local, remote } = rule;
  if (remote === "localabstract:chrome_devtools_remote") {
    return "labels.chromeDevtools";
  }
  if (remote.startsWith("localabstract:webview_devtools_remote")) {
    return "labels.webviewDevtools";
  }
  if (remote.startsWith("jdwp:")) return "labels.javaDebugger";
  if (direction === "reverse" && local === "tcp:8081") return "labels.metro";
  if (
    direction === "reverse" &&
    (local === "tcp:8088" || local === "tcp:8089")
  ) {
    return "labels.flipper";
  }
  return null;
}

export const ruleKey = (direction: Direction, local: string) =>
  `${direction}|${local}`;
