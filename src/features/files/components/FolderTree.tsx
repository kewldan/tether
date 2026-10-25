// biome-ignore-all lint/a11y/useSemanticElements: ARIA tree built from divs
// biome-ignore-all lint/a11y/useFocusableInteractive: the buttons inside each item take focus

import { ChevronDown, ChevronRight, Folder, Loader2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

import { isDirLike } from "../api";
import { useListing } from "../queries";

const ROOTS = [
  { path: "/sdcard", label: "sdcard" },
  { path: "/data/local/tmp", label: "data/local/tmp" },
  { path: "/", label: "/" },
];

/** Lazily loaded folder tree (Components board, "File tree"). */
export function FolderTree({
  serial,
  selected,
  onSelect,
}: {
  serial: string;
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  return (
    <div role="tree" className="text-small font-mono">
      {ROOTS.map((root) => (
        <Node
          key={root.path}
          serial={serial}
          path={root.path}
          label={root.label}
          depth={0}
          selected={selected}
          onSelect={onSelect}
          defaultOpen={root.path === "/sdcard"}
        />
      ))}
    </div>
  );
}

function Node({
  serial,
  path,
  label,
  depth,
  selected,
  onSelect,
  defaultOpen = false,
}: {
  serial: string;
  path: string;
  label: string;
  depth: number;
  selected: string | null;
  onSelect: (path: string) => void;
  defaultOpen?: boolean;
}) {
  const { t } = useTranslation("files");
  const [open, setOpen] = useState(defaultOpen);
  const { data, isLoading, error } = useListing(open ? serial : null, path);
  const children = (data?.entries ?? [])
    .filter((e) => isDirLike(e) && !e.name.startsWith("."))
    .sort((a, b) => a.name.localeCompare(b.name));
  const isSelected = selected === path;
  const Chevron = open ? ChevronDown : ChevronRight;

  return (
    <div role="treeitem" aria-expanded={open} aria-selected={isSelected}>
      <div
        className={cn(
          "flex h-[26px] items-center gap-1.5 rounded-sm pr-1.5",
          isSelected ? "bg-selected text-foreground" : "hover:bg-accent",
        )}
        style={{ paddingLeft: 4 + depth * 18 }}
      >
        <button
          type="button"
          aria-label={open ? t("tree.collapse") : t("tree.expand")}
          onClick={() => setOpen((o) => !o)}
          className="text-muted-foreground hover:text-foreground flex size-4 flex-none items-center justify-center"
        >
          <Chevron className="size-3.5" aria-hidden />
        </button>
        <button
          type="button"
          onClick={() => onSelect(path)}
          onDoubleClick={() => setOpen((o) => !o)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left outline-none"
        >
          <Folder
            className={cn("size-3.5 flex-none", isSelected && "text-brand")}
            aria-hidden
          />
          <span className="truncate">{label}</span>
        </button>
        {open && isLoading && (
          <Loader2
            className="text-muted-foreground size-3 animate-spin"
            aria-hidden
          />
        )}
      </div>
      {open && (
        <div role="group">
          {error || data?.denied ? (
            <div
              className="text-muted-foreground h-[26px] leading-[26px]"
              style={{ paddingLeft: 26 + (depth + 1) * 18 }}
            >
              {t("tree.denied")}
            </div>
          ) : (
            children.map((c) => (
              <Node
                key={c.path}
                serial={serial}
                path={c.path}
                label={c.name}
                depth={depth + 1}
                selected={selected}
                onSelect={onSelect}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}
