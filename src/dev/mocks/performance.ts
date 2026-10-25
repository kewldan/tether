import { channel, type MockHandlers } from "@/dev/mockBackend";
import type {
  PerfEvent,
  PerfSample,
  Process,
} from "@/features/performance/api";

const timers = new Map<number, ReturnType<typeof setInterval>>();
let nextId = 1;

const walk = (v: number, amp: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v + (Math.random() - 0.5) * amp));

function sampler(pkg: string | null) {
  let cpu = 24;
  let mem = 7.4;
  let rx = 2.4;
  let tx = 0.6;
  let fps = 58;
  let current = 1840;
  let temp = 31.4;
  const cores = [34, 18, 52, 12, 40, 22, 10, 64, 8];
  return (): PerfSample => {
    cpu = walk(cpu, 10, 3, 95);
    mem = walk(mem, 0.15, 6.8, 8.2);
    rx = walk(rx, 1.6, 0, 6);
    tx = walk(tx, 0.5, 0, 2);
    fps = walk(fps, 8, 30, 60);
    current = walk(current, 160, 900, 2400);
    temp = walk(temp, 0.2, 29, 36);
    return {
      time: Date.now(),
      cpu,
      cores: cores.map((c, i) => {
        cores[i] = walk(c, 18, 2, 100);
        return cores[i] ?? 0;
      }),
      memory: {
        totalKb: 12 * 1024 * 1024,
        availableKb: (12 - mem) * 1024 * 1024,
        usedKb: mem * 1024 * 1024,
        swapTotalKb: 6 * 1024 * 1024,
        swapUsedKb: 1.2 * 1024 * 1024,
      },
      network: {
        iface: "wlan0",
        rxBytesPerSec: rx * 1024 * 1024,
        txBytesPerSec: tx * 1024 * 1024,
      },
      battery: {
        level: 82,
        temperatureC: temp,
        voltageMv: 4210,
        currentMa: current,
        charging: true,
        plugged: true,
      },
      frames: pkg ? { fps, jankyPercent: 4.1, p95Ms: 21 } : null,
      packagePssKb: pkg ? 319_488 : null,
    };
  };
}

let processes: Process[] = [
  {
    pid: 5106,
    user: "u0_a312",
    cpu: 23.4,
    rssKb: 319_488,
    state: "R",
    name: "com.example.shop",
  },
  {
    pid: 1534,
    user: "system",
    cpu: 6.1,
    rssKb: 428_032,
    state: "S",
    name: "system_server",
  },
  {
    pid: 2311,
    user: "u0_a141",
    cpu: 2.0,
    rssKb: 205_824,
    state: "S",
    name: "com.android.systemui",
  },
  {
    pid: 912,
    user: "system",
    cpu: 1.8,
    rssKb: 65_536,
    state: "S",
    name: "surfaceflinger",
  },
  {
    pid: 3120,
    user: "u0_a187",
    cpu: 0.9,
    rssKb: 182_272,
    state: "S",
    name: "com.google.android.gms.persistent",
  },
  {
    pid: 4420,
    user: "u0_a312",
    cpu: 0.4,
    rssKb: 98_304,
    state: "S",
    name: "com.example.shop:sync",
  },
  { pid: 1, user: "root", cpu: 0.0, rssKb: 12_824, state: "S", name: "init" },
  {
    pid: 524,
    user: "root",
    cpu: 0.0,
    rssKb: 191_812,
    state: "S",
    name: "zygote64",
  },
  { pid: 744, user: "logd", cpu: 0.3, rssKb: 9_080, state: "S", name: "logd" },
  { pid: 8400, user: "shell", cpu: 0.1, rssKb: 5_512, state: "R", name: "top" },
  {
    pid: 59,
    user: "root",
    cpu: 0.0,
    rssKb: 0,
    state: "S",
    name: "[watchdogd]",
  },
  {
    pid: 7863,
    user: "root",
    cpu: 0.0,
    rssKb: 0,
    state: "I",
    name: "[kworker/0:3-events]",
  },
];

const handlers: MockHandlers = {
  perf_subscribe: ({ onEvent, package: pkg }) => {
    const send = channel<PerfEvent>(onEvent);
    const id = nextId++;
    setTimeout(
      () => send({ type: "info", cpu: { cores: 9, clusters: [4, 4, 1] } }),
      50,
    );
    const next = sampler((pkg as string | null) ?? null);
    // Backfill a minute so charts render immediately in the preview. Async,
    // like the real backend, so a cancelled subscription never delivers.
    const now = Date.now();
    setTimeout(() => {
      if (!timers.has(id)) return;
      for (let i = 60; i > 0; i--) {
        send({ type: "sample", sample: { ...next(), time: now - i * 1000 } });
      }
    }, 60);
    timers.set(
      id,
      setInterval(() => send({ type: "sample", sample: next() }), 1000),
    );
    return id;
  },
  perf_unsubscribe: ({ id }) => {
    clearInterval(timers.get(id as number));
    timers.delete(id as number);
    return null;
  },
  perf_processes: () =>
    processes.map((p) => ({
      ...p,
      cpu: Math.max(0, p.cpu + (Math.random() - 0.5) * p.cpu * 0.3),
    })),
  perf_kill: ({ pid, package: pkg }) => {
    if (pid === 1) {
      throw {
        kind: "device",
        message: "/system/bin/sh: kill: 1: Operation not permitted",
        hint: null,
      };
    }
    processes = processes.filter((p) =>
      pkg ? p.name.split(":")[0] !== pkg : p.pid !== pid,
    );
    return null;
  },
  perf_export_csv: ({ fileName, contents }) => {
    const url = URL.createObjectURL(
      new Blob([contents as string], { type: "text/csv" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName as string;
    a.click();
    URL.revokeObjectURL(url);
    return `~/Downloads/${fileName as string}`;
  },
};

export default handlers;
