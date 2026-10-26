import { channel, type MockHandlers, sleep } from "@/dev/mockBackend";
import { addLocalFile } from "@/dev/mocks/files-local";
import type {
  DirListing,
  FileEntry,
  LocalSummary,
  TransferEvent,
  TransferSummary,
} from "@/features/files/api";

// A small fake device file system, shaped like a Pixel's /sdcard.

const DIR = 0o040000;
const REG = 0o100000;
const LNK = 0o120000;
const MB = 1_000_000;

interface Node {
  mode: number;
  size: number;
  mtime: number;
  owner: string;
  group: string;
  linkTo?: string;
}

const now = Math.floor(Date.now() / 1000);
const day = 86_400;
const fs = new Map<string, Node>();

function perm(mode: number) {
  const t =
    (mode & 0o170000) === DIR ? "d" : (mode & 0o170000) === LNK ? "l" : "-";
  const r = (b: number, c: string) => (mode & b ? c : "-");
  const x = (b: number, s: number, on: string, off: string) =>
    mode & s ? (mode & b ? on : off) : r(b, "x");
  return (
    t +
    r(0o400, "r") +
    r(0o200, "w") +
    x(0o100, 0o4000, "s", "S") +
    r(0o040, "r") +
    r(0o020, "w") +
    x(0o010, 0o2000, "s", "S") +
    r(0o004, "r") +
    r(0o002, "w") +
    x(0o001, 0o1000, "t", "T")
  );
}

function dir(
  path: string,
  mtime = now - 3 * day,
  owner = "u0_a212",
  mode = 0o2770,
) {
  fs.set(path, {
    mode: DIR | mode,
    size: 4096,
    mtime,
    owner,
    group: "media_rw",
  });
}
function file(path: string, size: number, mtime: number, owner = "u0_a212") {
  fs.set(path, { mode: REG | 0o660, size, mtime, owner, group: "media_rw" });
}

// Root and system-ish folders.
for (const p of [
  "/",
  "/data",
  "/data/local",
  "/system",
  "/storage",
  "/vendor",
  "/product",
  "/apex",
])
  fs.set(p, {
    mode: DIR | 0o755,
    size: 4096,
    mtime: now - 40 * day,
    owner: "root",
    group: "root",
  });
fs.set("/data", {
  mode: DIR | 0o771,
  size: 4096,
  mtime: now - 2 * day,
  owner: "system",
  group: "system",
});
fs.set("/sdcard", {
  mode: LNK | 0o777,
  size: 21,
  mtime: now - 40 * day,
  owner: "root",
  group: "root",
  linkTo: "/storage/self/primary",
});
fs.set("/etc", {
  mode: LNK | 0o644,
  size: 11,
  mtime: now - 40 * day,
  owner: "root",
  group: "root",
  linkTo: "/system/etc",
});
fs.set("/init.rc", {
  mode: REG | 0o750,
  size: 25_310,
  mtime: now - 40 * day,
  owner: "root",
  group: "shell",
});
fs.set("/data/local/tmp", {
  mode: DIR | 0o771,
  size: 4096,
  mtime: now - day,
  owner: "shell",
  group: "shell",
});
fs.set("/data/local/tmp/frida-server", {
  mode: REG | 0o755,
  size: 53 * MB,
  mtime: now - 5 * day,
  owner: "shell",
  group: "shell",
});
fs.set("/data/local/tmp/perfetto.cfg", {
  mode: REG | 0o644,
  size: 1_204,
  mtime: now - 2 * day,
  owner: "shell",
  group: "shell",
});

for (const d of [
  "Alarms",
  "Android",
  "Audiobooks",
  "DCIM",
  "Documents",
  "Download",
  "Movies",
  "Music",
  "Notifications",
  "Pictures",
  "Podcasts",
  "Recordings",
  "Ringtones",
])
  dir(`/sdcard/${d}`);
dir("/sdcard/Android", now - 9 * day, "media_rw", 0o2771);
dir("/sdcard/DCIM/Camera", now - 3600);
dir("/sdcard/DCIM/Camera/.thumbnails", now - day - 3600 * 2);
dir("/sdcard/DCIM/Screenshots", now - 2 * day);
dir("/sdcard/Pictures/Telegram", now - 6 * day);
dir("/sdcard/Download/shop", now - 4 * day);
dir("/sdcard/Documents/empty", now - 10 * day);

const camera: [string, number, number][] = [
  ["PXL_20261025_193004121.jpg", 4.1 * MB, now - 1800],
  ["PXL_20261025_182211907.jpg", 3.8 * MB, now - 5200],
  ["PXL_20261024_174501223.mp4", 212.6 * MB, now - day - 7200],
  ["PXL_20261024_131808650.PORTRAIT.jpg", 5.6 * MB, now - day - 22_000],
  ["PXL_20261023_090144532.jpg", 3.2 * MB, now - 2 * day],
  ["PXL_20261022_211530004.NIGHT.jpg", 6.9 * MB, now - 3 * day],
  ["PXL_20261021_160012777.mp4", 88.4 * MB, now - 4 * day],
  ["PXL_20261020_124400190.jpg", 2.7 * MB, now - 5 * day],
  ["PXL_20261019_083059811.jpg", 3.4 * MB, now - 6 * day],
];
for (const [name, size, mtime] of camera)
  file(`/sdcard/DCIM/Camera/${name}`, Math.round(size), mtime);
// A long folder for virtualization.
for (let i = 0; i < 400; i++) {
  const n = String(i).padStart(3, "0");
  file(
    `/sdcard/DCIM/Screenshots/Screenshot_20261020-1${n}.png`,
    380_000 + i * 997,
    now - 2 * day - i * 600,
  );
}
file("/sdcard/Download/shop-release.apk", 48.2 * MB, now - 4 * day);
file("/sdcard/Download/notes.txt", 1_840, now - 3600 * 5);
file("/sdcard/Download/config.json", 612, now - day);
file("/sdcard/Download/Как установить RuStore.mht", 580_806, now - 30 * day);
file("/sdcard/Download/shop/catalog.xml", 92_311, now - 4 * day);
file("/sdcard/Documents/report-q3.pdf", 2.4 * MB, now - 12 * day);
file("/sdcard/Pictures/wallpaper.png", 1.9 * MB, now - 20 * day);
file("/sdcard/Pictures/Telegram/IMG_20261024_181233.jpg", 4.1 * MB, now - day);
file("/sdcard/.nomedia", 0, now - 40 * day);
file("/sdcard/window_dump.xml", 6_549, now - 9 * day);

const TEXT: Record<string, string> = {
  "/sdcard/Download/notes.txt":
    "Tether test notes\n\n- adb pull /sdcard/DCIM/Camera ~/Downloads\n- Check the drop zone on the file list\n- Транзакции и кириллица в именах файлов\n",
  "/sdcard/Download/config.json":
    '{\n  "apiBase": "https://api.example.shop/v2",\n  "debug": true,\n  "retries": 3\n}\n',
  "/data/local/tmp/perfetto.cfg":
    'buffers: { size_kb: 63488 }\ndata_sources: { config { name: "linux.ftrace" } }\nduration_ms: 10000\n',
};

for (const [path, text] of Object.entries(TEXT)) {
  const node = fs.get(path);
  if (node) node.size = new TextEncoder().encode(text).byteLength;
}

const resolveLink = (path: string): string => {
  const node = fs.get(path);
  return node?.linkTo ? node.linkTo : path;
};
// /sdcard → /storage/self/primary: keep everything under /sdcard instead.
const realPath = (path: string) =>
  path === "/storage/self/primary" ? "/sdcard" : path;

function parentOf(path: string) {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}
function nameOf(path: string) {
  return path.slice(path.lastIndexOf("/") + 1);
}
function isDir(path: string): boolean {
  const node = fs.get(path);
  if (!node) return false;
  if (node.linkTo) {
    const target = realPath(node.linkTo);
    return target === path ? true : isDir(target);
  }
  return (node.mode & 0o170000) === DIR;
}

function toEntry(path: string, node: Node): FileEntry {
  const kind = node.linkTo
    ? "symlink"
    : (node.mode & 0o170000) === DIR
      ? "dir"
      : "file";
  return {
    name: nameOf(path),
    path,
    kind,
    linkToDir: node.linkTo ? isDir(realPath(node.linkTo)) : false,
    size: node.size,
    mtime: node.mtime,
    mode: node.mode,
    permissions: perm(node.mode),
    owner: node.owner,
    group: node.group,
    unreadable: false,
  };
}

const fail = (message: string, kind = "device") => {
  throw { kind, message, hint: null };
};
const norm = (p: string) => {
  const parts: string[] = [];
  for (const s of p.split("/")) {
    if (!s || s === ".") continue;
    if (s === "..") parts.pop();
    else parts.push(s);
  }
  return `/${parts.join("/")}`;
};

function list(path: string): DirListing {
  const p = norm(path);
  const real = realPath(resolveLink(p));
  if (!fs.has(p) && !fs.has(real)) fail(`${p}: no such file or folder`);
  if (!isDir(p)) fail(`${p} is not a folder`, "invalid_input");
  if (p === "/data" || p === "/data/local")
    return { path: p, entries: [], denied: true };
  const entries: FileEntry[] = [];
  for (const [childPath, node] of fs) {
    if (childPath !== real && parentOf(childPath) === real)
      entries.push(
        toEntry(p === real ? childPath : `${p}/${nameOf(childPath)}`, node),
      );
  }
  return { path: p, entries, denied: false };
}

// ---- previews ---------------------------------------------------------------

async function fakeImage(seed: number, type: string): Promise<ArrayBuffer> {
  const canvas = new OffscreenCanvas(640, 480);
  const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
  const hue = (seed * 47) % 360;
  const sky = ctx.createLinearGradient(0, 0, 0, 480);
  sky.addColorStop(0, `hsl(${hue} 30% 70%)`);
  sky.addColorStop(0.55, `hsl(${(hue + 30) % 360} 40% 80%)`);
  sky.addColorStop(0.56, `hsl(${(hue + 90) % 360} 18% 42%)`);
  sky.addColorStop(1, `hsl(${(hue + 90) % 360} 20% 28%)`);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, 640, 480);
  ctx.fillStyle = `hsl(${(hue + 40) % 360} 70% 88%)`;
  ctx.beginPath();
  ctx.arc(460 - (seed % 5) * 40, 110, 26, 0, Math.PI * 2);
  ctx.fill();
  const blob = await canvas.convertToBlob({ type });
  return blob.arrayBuffer();
}

// ---- transfers --------------------------------------------------------------

const controls = new Map<string, { cancel: boolean; pause: boolean }>();

function sizeOf(path: string): { bytes: number; files: string[] } {
  if (!isDir(path)) return { bytes: fs.get(path)?.size ?? 0, files: [path] };
  const real = realPath(resolveLink(path));
  const files: string[] = [];
  let bytes = 0;
  for (const [p, node] of fs) {
    if (p.startsWith(`${real}/`) && (node.mode & 0o170000) === REG) {
      files.push(p);
      bytes += node.size;
    }
  }
  return { bytes, files };
}

async function simulate(
  id: string,
  totalBytes: number,
  totalFiles: number,
  label: (i: number) => string,
  send: (e: TransferEvent) => void,
  failAt?: { fraction: number; message: string },
) {
  const control = { cancel: false, pause: false };
  controls.set(id, control);
  try {
    send({ type: "scanning" });
    await sleep(300);
    send({ type: "started", totalBytes, totalFiles });
    const speed = 14 * MB + Math.random() * 10 * MB; // bytes/s
    let bytes = 0;
    while (bytes < totalBytes) {
      await sleep(100);
      if (control.cancel) fail("operation was cancelled", "cancelled");
      if (control.pause) continue;
      bytes = Math.min(totalBytes, bytes + speed / 10);
      if (failAt && bytes / totalBytes >= failAt.fraction) fail(failAt.message);
      const filesDone = Math.floor((bytes / totalBytes) * totalFiles);
      send({
        type: "progress",
        bytes: Math.round(bytes),
        totalBytes,
        filesDone,
        totalFiles,
        current: label(Math.min(filesDone, totalFiles - 1)),
      });
    }
  } finally {
    controls.delete(id);
  }
}

const handlers: MockHandlers = {
  files_list: async ({ path }) => {
    await sleep(120);
    return list(path as string);
  },
  files_mkdir: async ({ path }) => {
    const p = norm(path as string);
    if (fs.has(p)) fail(`${p}: already exists`);
    if (p.startsWith("/data/") && !p.startsWith("/data/local/tmp"))
      fail(`mkdir: '${p}': Permission denied`);
    dir(p, now);
    return null;
  },
  files_rename: async ({ from, to }) => {
    const f = norm(from as string);
    const t = norm(to as string);
    if (fs.has(t)) fail(`${t}: already exists`);
    for (const [p, node] of [...fs]) {
      if (p === f || p.startsWith(`${f}/`)) {
        fs.delete(p);
        fs.set(t + p.slice(f.length), node);
      }
    }
    return null;
  },
  files_delete: async ({ paths }) => {
    await sleep(200);
    for (const raw of paths as string[]) {
      const target = norm(raw);
      for (const p of [...fs.keys()])
        if (p === target || p.startsWith(`${target}/`)) fs.delete(p);
    }
    return null;
  },
  files_chmod: async ({ paths, mode }) => {
    const m = Number.parseInt(mode as string, 8);
    if (Number.isNaN(m)) fail(`invalid mode "${mode}"`, "invalid_input");
    for (const p of paths as string[]) {
      const node = fs.get(norm(p));
      if (node) node.mode = (node.mode & 0o170000) | m;
    }
    return null;
  },
  files_storage: () => ({
    total: 256 * 1000 * MB,
    used: 168.4 * 1000 * MB,
    available: 87.6 * 1000 * MB,
    mount: "/storage/emulated",
  }),
  files_preview: async ({ path, maxBytes }) => {
    const p = norm(path as string);
    await sleep(150);
    const text = TEXT[p];
    if (text !== undefined)
      return new TextEncoder().encode(text).slice(0, maxBytes as number).buffer;
    const lower = p.toLowerCase();
    if (/\.(jpe?g|png|webp)$/.test(lower)) {
      const type = lower.endsWith(".png") ? "image/png" : "image/jpeg";
      return fakeImage(p.length + (fs.get(p)?.mtime ?? 0), type);
    }
    if (lower.endsWith(".xml") || lower.endsWith(".mht"))
      return new TextEncoder().encode(
        '<?xml version="1.0" encoding="UTF-8"?>\n<hierarchy rotation="0">\n  <node index="0" class="android.widget.FrameLayout" package="com.example.shop" />\n</hierarchy>\n',
      ).buffer;
    // Binary noise for everything else.
    return new Uint8Array(Math.min(256, maxBytes as number)).buffer;
  },
  files_default_download_dir: () => "/Users/me/Downloads",
  files_local_summary: ({ paths }): LocalSummary => ({
    files: (paths as string[]).length,
    folders: 0,
    bytes: (paths as string[]).length * 4.9 * MB,
  }),
  files_pull: async ({ id, paths, localDir, onEvent }) => {
    const send = channel<TransferEvent>(onEvent);
    const sources = (paths as string[]).map(norm);
    const all = sources.map(sizeOf);
    const files = all.flatMap((s) => s.files);
    const bytes = all.reduce((sum, s) => sum + s.bytes, 0);
    await simulate(
      id as string,
      Math.max(bytes, 1),
      files.length,
      (i) => nameOf(files[i] ?? ""),
      send,
    );
    // Land in the fake computer so the two-pane view shows the copy.
    const destinations = sources.map((s, i) =>
      addLocalFile(`${localDir}/${nameOf(s)}`, all[i]?.bytes ?? 0, isDir(s)),
    );
    return {
      bytes,
      files: files.length,
      skipped: 0,
      destinations,
    } satisfies TransferSummary;
  },
  files_push: async ({ id, paths, remoteDir, onEvent }) => {
    const send = channel<TransferEvent>(onEvent);
    const locals = paths as string[];
    const target = norm(remoteDir as string);
    const sizes = locals.map((p) =>
      p.endsWith(".ab") ? 2100 * MB : 3 * MB + (p.length % 7) * 1.7 * MB,
    );
    const bytes = Math.round(sizes.reduce((a, b) => a + b, 0));
    const failing = locals.some((p) => p.endsWith(".ab"));
    await simulate(
      id as string,
      bytes,
      locals.length,
      (i) => locals[i]?.split("/").pop() ?? "",
      send,
      failing
        ? { fraction: 0.3, message: "No space left on /sdcard (needs 2.1 GB)" }
        : undefined,
    );
    const destinations = locals.map((p, i) => {
      const name = p.split(/[\\/]/).pop() ?? "file";
      let dest = `${target}/${name}`;
      for (let n = 1; fs.has(dest); n++) dest = `${target}/${name} (${n})`;
      file(dest, Math.round(sizes[i] ?? 0), Math.floor(Date.now() / 1000));
      return dest;
    });
    return {
      bytes,
      files: locals.length,
      skipped: 0,
      destinations,
    } satisfies TransferSummary;
  },
  files_transfer_control: ({ id, action }) => {
    const control = controls.get(id as string);
    if (!control) return null;
    if (action === "cancel") control.cancel = true;
    if (action === "pause") control.pause = true;
    if (action === "resume") control.pause = false;
    return null;
  },
  "plugin:dialog|open": ({ options }) => {
    const o = (options ?? {}) as { directory?: boolean; multiple?: boolean };
    if (o.directory)
      return o.multiple
        ? ["/Users/me/Projects/shop-assets"]
        : "/Users/me/Downloads";
    return [
      "/Users/me/Desktop/shop-assets-v2.zip",
      "/Users/me/Desktop/backup.ab",
    ];
  },
  "plugin:opener|reveal_item_in_dir": () => null,
};

export default handlers;
