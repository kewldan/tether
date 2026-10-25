import { channel, type MockHandlers, sleep } from "@/dev/mockBackend";
import type {
  BugreportEvent,
  BugreportFile,
  BugreportList,
  BugreportResult,
} from "@/features/bugreport/api";

const DIR = "/Users/me/Documents/Tether/bugreports";
const MB = 1024 * 1024;

const reports: BugreportFile[] = [
  {
    path: `${DIR}/bugreport-husky-AP4A.261005.002-2026-10-25-22-12-05.zip`,
    name: "bugreport-husky-AP4A.261005.002-2026-10-25-22-12-05.zip",
    device: "husky",
    sizeBytes: 38.4 * MB,
    modified: Date.now() - 2 * 3600_000,
  },
  {
    path: `${DIR}/bugreport-dm1q-UP1A.231005.007-2026-10-23-15-40-11.zip`,
    name: "bugreport-dm1q-UP1A.231005.007-2026-10-23-15-40-11.zip",
    device: "dm1q",
    sizeBytes: 51 * MB,
    modified: Date.now() - 2 * 86400_000,
  },
];

const cancelled = new Set<string>();

const handlers: MockHandlers = {
  create_bugreport: async ({ serial, onEvent }): Promise<BugreportResult> => {
    const send = channel<BugreportEvent>(onEvent);
    cancelled.delete(serial as string);
    await sleep(1200);
    const total = 1825;
    for (let done = 20; done <= total; done += 45) {
      if (cancelled.has(serial as string)) {
        throw {
          kind: "cancelled",
          message: "operation was cancelled",
          hint: null,
        };
      }
      send({ type: "progress", done, total });
      await sleep(250);
    }
    const size = 13.2 * MB;
    for (let received = 0; received <= size; received += size / 10) {
      send({ type: "pulling", received, total: size });
      await sleep(80);
    }
    const name = `bugreport-sdk_gphone64_arm64-BE4B.251210.005-${new Date()
      .toISOString()
      .slice(0, 19)
      .replace(/[T:]/g, "-")}.zip`;
    const file: BugreportFile = {
      path: `${DIR}/${name}`,
      name,
      device: "sdk_gphone64_arm64",
      sizeBytes: size,
      modified: Date.now(),
    };
    reports.unshift(file);
    return { file, summary: { anrTraces: 1, tombstones: 18 } };
  },
  cancel_bugreport: ({ serial }) => {
    cancelled.add(serial as string);
    return null;
  },
  list_bugreports: (): BugreportList => ({ dir: DIR, reports: [...reports] }),
  delete_bugreport: ({ path }) => {
    const i = reports.findIndex((r) => r.path === path);
    if (i >= 0) reports.splice(i, 1);
    return null;
  },
  "plugin:opener|open_url": () => null,
};

export default handlers;
