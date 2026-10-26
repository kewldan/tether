import type { MockHandlers } from "@/dev/mockBackend";
import type {
  Direction,
  HostPortUsage,
  PortRule,
  PortRules,
} from "@/features/ports/api";

// Rules on the sample Pixel 8 Pro, as on the Ports board.
const rules: Record<string, PortRules> = {
  "38121FDJH00A4B": {
    forward: [
      {
        direction: "forward",
        local: "tcp:9222",
        remote: "localabstract:chrome_devtools_remote",
      },
      { direction: "forward", local: "tcp:5005", remote: "jdwp:5106" },
    ],
    reverse: [
      { direction: "reverse", local: "tcp:8081", remote: "tcp:8081" },
      { direction: "reverse", local: "tcp:3000", remote: "tcp:3000" },
    ],
  },
};

/** Host ports "used by another app" in the browser preview. */
const BUSY_HOST_PORTS = new Set(["tcp:8080"]);

const of = (serial: unknown) => {
  const key = serial as string;
  rules[key] ??= { forward: [], reverse: [] };
  return rules[key];
};

const fail = (message: string) => {
  throw { kind: "device", message, hint: null };
};

const handlers: MockHandlers = {
  ports_list: ({ serial }) => structuredClone(of(serial)),
  ports_add: ({ serial, direction, local, remote }) => {
    const dir = direction as Direction;
    const list = of(serial)[dir];
    if (dir === "forward" && BUSY_HOST_PORTS.has(local as string)) {
      fail("cannot bind listener: Address already in use");
    }
    let spec = local as string;
    let port: number | null = Number(spec.slice(4));
    if (spec === "tcp:0") {
      port = 40000 + Math.floor(Math.random() * 20000);
      spec = `tcp:${port}`;
    }
    const rule: PortRule = {
      direction: dir,
      local: spec,
      remote: remote as string,
    };
    const i = list.findIndex((r) => r.local === spec);
    if (i >= 0) list[i] = rule;
    else list.push(rule);
    return port;
  },
  ports_remove: ({ serial, direction, local }) => {
    const set = of(serial);
    const dir = direction as Direction;
    const before = set[dir].length;
    set[dir] = set[dir].filter((r) => r.local !== local);
    if (set[dir].length === before) fail(`listener '${local}' not found`);
    return null;
  },
  ports_remove_all: ({ serial }) => {
    rules[serial as string] = { forward: [], reverse: [] };
    return null;
  },
  ports_host_usage: ({ ports }): HostPortUsage[] =>
    (ports as number[]).map((port) => ({
      port,
      connections: port === 9222 ? 2 : 0,
      listener: BUSY_HOST_PORTS.has(`tcp:${port}`)
        ? { pid: 31877, name: "node" }
        : { pid: 85118, name: "adb" },
    })),
  ports_free_host_port: ({ start }) => {
    let port = start as number;
    while (BUSY_HOST_PORTS.has(`tcp:${port}`)) port++;
    return port;
  },
};

export default handlers;
