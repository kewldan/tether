/** POSIX path helpers for device paths. */

export function normalize(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

export function join(dir: string, name: string): string {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

export function parent(path: string): string {
  const p = normalize(path);
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

export function basename(path: string): string {
  const p = normalize(path);
  return p === "/" ? "/" : p.slice(p.lastIndexOf("/") + 1);
}

/** Resolves user input against the current folder. */
export function resolve(cwd: string, input: string): string {
  const trimmed = input.trim();
  if (trimmed === "" || trimmed === "~") return "/sdcard";
  if (trimmed.startsWith("~/")) return normalize(`/sdcard/${trimmed.slice(2)}`);
  return normalize(trimmed.startsWith("/") ? trimmed : join(cwd, trimmed));
}

/** `/sdcard/DCIM` → [{ name: "/", path: "/" }, { "sdcard" }, { "DCIM" }]. */
export function segments(path: string): { name: string; path: string }[] {
  const out = [{ name: "/", path: "/" }];
  let acc = "";
  for (const part of normalize(path).split("/").filter(Boolean)) {
    acc += `/${part}`;
    out.push({ name: part, path: acc });
  }
  return out;
}

/** True for `/a/b` inside `/a` (or equal). */
export function isWithin(path: string, dir: string): boolean {
  const p = normalize(path);
  const d = normalize(dir);
  return p === d || p.startsWith(d === "/" ? "/" : `${d}/`);
}

/** File name of a local path (either separator). */
export function localBasename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Characters a device file name cannot contain. */
export function invalidName(name: string): boolean {
  return (
    name.trim() === "" || name === "." || name === ".." || name.includes("\0")
  );
}
