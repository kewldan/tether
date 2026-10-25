import { type FileEntry, isDirLike } from "./api";
import type { SortKey } from "./store";

const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

/** Filters hidden files and the search query, then sorts (folders first). */
export function visibleEntries(
  entries: FileEntry[],
  options: {
    showHidden: boolean;
    query: string;
    sort: { key: SortKey; desc: boolean };
  },
): FileEntry[] {
  const q = options.query.trim().toLowerCase();
  const filtered = entries.filter(
    (e) =>
      (options.showHidden || !e.name.startsWith(".")) &&
      (q === "" || e.name.toLowerCase().includes(q)),
  );
  const { key, desc } = options.sort;
  const dir = desc ? -1 : 1;
  return filtered.sort((a, b) => {
    const folders = Number(isDirLike(b)) - Number(isDirLike(a));
    if (folders !== 0) return folders;
    let c = 0;
    if (key === "size") c = a.size - b.size;
    else if (key === "mtime") c = a.mtime - b.mtime;
    else if (key === "permissions")
      c = a.permissions.localeCompare(b.permissions);
    if (c === 0) c = collator.compare(a.name, b.name);
    return c * dir;
  });
}

export function totalSize(entries: FileEntry[]): number {
  return entries.reduce((sum, e) => sum + (isDirLike(e) ? 0 : e.size), 0);
}
