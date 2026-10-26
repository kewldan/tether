import { type MockHandlers, sleep } from "@/dev/mockBackend";
import type {
  LocalEntry,
  LocalListing,
  LocalPlace,
} from "@/features/files/api";

// A small fake computer for the two-pane mode: /Users/me on a Mac.

const DIR = 0o040000;
const REG = 0o100000;
const MB = 1_000_000;
const now = Math.floor(Date.now() / 1000);
const day = 86_400;

interface Node {
  dir: boolean;
  size: number;
  mtime: number;
  hidden?: boolean;
}

const fs = new Map<string, Node>();
const dir = (path: string, mtime = now - 5 * day, hidden = false) =>
  fs.set(path, { dir: true, size: 0, mtime, hidden });
const file = (path: string, size: number, mtime: number) =>
  fs.set(path, { dir: false, size: Math.round(size), mtime });

for (const p of ["/", "/Users", "/Users/me", "/Volumes", "/Volumes/Backup"])
  dir(p, now - 60 * day);
for (const d of [
  "Desktop",
  "Documents",
  "Downloads",
  "Movies",
  "Music",
  "Pictures",
  "Projects",
])
  dir(`/Users/me/${d}`);
dir("/Users/me/Library", now - 2 * day, true);
dir("/Users/me/.android", now - day);
file("/Users/me/.zshrc", 2_310, now - 30 * day);
dir("/Users/me/Projects/shop-assets", now - 3 * day);
file("/Users/me/Projects/shop-assets/banner.png", 1.2 * MB, now - 3 * day);
file("/Users/me/Projects/shop-assets/catalog.json", 48_200, now - 3 * day);
file("/Users/me/Desktop/shop-assets-v2.zip", 18.4 * MB, now - 3600);
file("/Users/me/Desktop/backup.ab", 2100 * MB, now - 2 * day);
file(
  "/Users/me/Desktop/Screenshot 2026-10-25 at 19.02.11.png",
  2.1 * MB,
  now - day,
);
file("/Users/me/Downloads/app-debug.apk", 31.7 * MB, now - 7200);
file("/Users/me/Downloads/release-notes.md", 4_120, now - 2 * day);
file("/Users/me/Downloads/Отчёт за октябрь.pdf", 1.4 * MB, now - 4 * day);
file("/Users/me/Documents/contract.pdf", 640_000, now - 12 * day);
file("/Users/me/Pictures/wallpaper-4k.jpg", 7.8 * MB, now - 20 * day);
file("/Users/me/Movies/demo.mov", 312 * MB, now - 9 * day);

const fail = (message: string, kind = "invalid_input") => {
  throw { kind, message, hint: null };
};

function clean(path: string) {
  const parts: string[] = [];
  for (const s of path.split("/")) {
    if (!s || s === ".") continue;
    if (s === "..") parts.pop();
    else parts.push(s);
  }
  return `/${parts.join("/")}`;
}
const parentOf = (p: string) =>
  p === "/" ? null : p.slice(0, p.lastIndexOf("/")) || "/";
const nameOf = (p: string) =>
  p === "/" ? "/" : p.slice(p.lastIndexOf("/") + 1);

function toEntry(path: string, node: Node): LocalEntry {
  const name = nameOf(path);
  return {
    name,
    path,
    kind: node.dir ? "dir" : "file",
    linkToDir: false,
    size: node.size,
    mtime: node.mtime,
    mode: (node.dir ? DIR | 0o755 : REG | 0o644) >>> 0,
    permissions: node.dir ? "drwxr-xr-x" : "-rw-r--r--",
    owner: null,
    group: null,
    unreadable: false,
    hidden: node.hidden === true || name.startsWith("."),
  };
}

function list(raw: string): LocalListing {
  const path = clean(raw);
  const node = fs.get(path);
  if (!node) fail(`${path}: no such file or folder`);
  if (!node?.dir) fail(`${path} is not a folder`);
  const entries: LocalEntry[] = [];
  for (const [p, n] of fs)
    if (p !== path && parentOf(p) === path) entries.push(toEntry(p, n));
  const crumbs: { name: string; path: string }[] = [];
  for (let p: string | null = path; p !== null; p = parentOf(p))
    crumbs.unshift({ name: nameOf(p), path: p });
  return { path, parent: parentOf(path), crumbs, entries, denied: false };
}

/** Called by the device mock when a pull lands on the computer. */
export function addLocalFile(path: string, size: number, isDir = false) {
  const p = clean(path);
  let dest = p;
  for (let n = 1; fs.has(dest); n++) {
    const dot = p.lastIndexOf(".");
    dest =
      dot > p.lastIndexOf("/") + 1
        ? `${p.slice(0, dot)} (${n})${p.slice(dot)}`
        : `${p} (${n})`;
  }
  fs.set(dest, {
    dir: isDir,
    size: Math.round(size),
    mtime: Math.floor(Date.now() / 1000),
  });
  return dest;
}

const places: LocalPlace[] = [
  { key: "home", label: "me", path: "/Users/me" },
  { key: "desktop", label: "Desktop", path: "/Users/me/Desktop" },
  { key: "documents", label: "Documents", path: "/Users/me/Documents" },
  { key: "downloads", label: "Downloads", path: "/Users/me/Downloads" },
  { key: "pictures", label: "Pictures", path: "/Users/me/Pictures" },
  { key: "videos", label: "Movies", path: "/Users/me/Movies" },
  { key: "music", label: "Music", path: "/Users/me/Music" },
  { key: "volume", label: "/", path: "/" },
  { key: "volume", label: "Backup", path: "/Volumes/Backup" },
];

const handlers: MockHandlers = {
  files_local_list: async ({ path }) => {
    await sleep(60);
    return list(path as string);
  },
  files_local_resolve: ({ base, input }) => {
    const s = (input as string).trim();
    if (s === "" || s === "~") return "/Users/me";
    if (s.startsWith("~/")) return clean(`/Users/me/${s.slice(2)}`);
    return clean(s.startsWith("/") ? s : `${base}/${s}`);
  },
  files_local_places: () => places,
  files_drag_stage: ({ id }) => {
    const dir = `/private/var/folders/T/tether-drag/${id}`;
    return dir;
  },
  files_start_drag: () => null,
};

export default handlers;
