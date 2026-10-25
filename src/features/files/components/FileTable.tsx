// biome-ignore-all lint/a11y/useSemanticElements: virtualized ARIA grid built from divs
// biome-ignore-all lint/a11y/useFocusableInteractive: the grid container takes focus and handles keys
// biome-ignore-all lint/a11y/useKeyWithClickEvents: the grid container handles keys
// biome-ignore-all lint/a11y/noStaticElementInteractions: click guards around checkboxes
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Checkbox } from "@/components/ui/checkbox";
import { useSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";

import { type FileEntry, isDirLike } from "../api";
import { formatBytes, formatDate } from "../format";
import { type SortKey, useFilesPrefs } from "../store";
import { FileIcon } from "./FileIcon";
import type { ListProps } from "./listProps";

const COLUMNS = "grid-cols-[36px_minmax(0,1fr)_96px_150px_120px]";

/** Dense, virtualized table: name, size, modified, permissions. */
export function FileTable({
  entries,
  selected,
  focused,
  scrollRef,
  onRowClick,
  onToggle,
  onToggleAll,
  onOpen,
}: ListProps) {
  const { t, i18n } = useTranslation("files");
  const compact = useSettings((s) => s.density === "compact");
  const rowHeight = compact ? 28 : 32;
  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
    paddingStart: rowHeight,
    scrollPaddingStart: rowHeight,
  });

  // Keep the keyboard cursor visible.
  const focusedIndex = focused
    ? entries.findIndex((e) => e.path === focused)
    : -1;
  useEffect(() => {
    if (focusedIndex >= 0)
      virtualizer.scrollToIndex(focusedIndex, { align: "auto" });
  }, [focusedIndex, virtualizer]);

  const allSelected = entries.length > 0 && selected.size === entries.length;

  return (
    <div
      role="grid"
      aria-multiselectable
      aria-rowcount={entries.length + 1}
      className="relative"
      style={{ height: virtualizer.getTotalSize() }}
    >
      <div
        role="row"
        className={cn(
          "bg-background text-muted-foreground text-small sticky top-0 z-10 grid items-center border-b font-medium",
          COLUMNS,
        )}
        style={{ height: rowHeight }}
      >
        <div role="columnheader" className="flex justify-center pl-1">
          <Checkbox
            aria-label={t("table.selectAll")}
            checked={allSelected}
            onCheckedChange={onToggleAll}
          />
        </div>
        <SortHeader sortKey="name">{t("table.name")}</SortHeader>
        <SortHeader sortKey="size" align="right">
          {t("table.size")}
        </SortHeader>
        <SortHeader sortKey="mtime">{t("table.modified")}</SortHeader>
        <SortHeader sortKey="permissions">{t("table.permissions")}</SortHeader>
      </div>

      {virtualizer.getVirtualItems().map((row) => {
        const entry = entries[row.index] as FileEntry;
        const isSelected = selected.has(entry.path);
        return (
          <div
            key={entry.path}
            role="row"
            aria-selected={isSelected}
            aria-rowindex={row.index + 2}
            data-path={entry.path}
            onClick={(e) => onRowClick(entry, e)}
            onDoubleClick={() => onOpen(entry)}
            className={cn(
              "absolute inset-x-0 top-0 grid items-center border-b",
              COLUMNS,
              isSelected ? "bg-brand/15" : "hover:bg-accent",
              focused === entry.path &&
                "outline-ring outline-1 -outline-offset-2",
              entry.unreadable && "opacity-60",
            )}
            style={{
              height: rowHeight,
              transform: `translateY(${row.start}px)`,
            }}
          >
            <div
              role="gridcell"
              className="flex justify-center pl-1"
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              <Checkbox
                aria-label={t("table.select", { name: entry.name })}
                checked={isSelected}
                onCheckedChange={() => onToggle(entry)}
                tabIndex={-1}
              />
            </div>
            <div
              role="gridcell"
              className="flex min-w-0 items-center gap-2.5 px-3"
            >
              <FileIcon entry={entry} />
              <span className="truncate" title={entry.name}>
                {entry.name}
              </span>
              {entry.kind === "symlink" && (
                <span className="text-muted-foreground text-caption flex-none">
                  {t("table.link")}
                </span>
              )}
            </div>
            <div
              role="gridcell"
              className={cn(
                "num truncate px-3 text-right",
                isDirLike(entry) && "text-muted-foreground",
              )}
            >
              {isDirLike(entry) || entry.unreadable
                ? "—"
                : formatBytes(entry.size)}
            </div>
            <div
              role="gridcell"
              className="text-muted-foreground num truncate px-3"
            >
              {formatDate(entry.mtime, i18n.language, t)}
            </div>
            <div
              role="gridcell"
              className="text-muted-foreground text-small truncate px-3 font-mono"
            >
              {entry.permissions}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SortHeader({
  sortKey,
  align,
  children,
}: {
  sortKey: SortKey;
  align?: "right";
  children: React.ReactNode;
}) {
  const sort = useFilesPrefs((s) => s.sort);
  const sortBy = useFilesPrefs((s) => s.sortBy);
  const active = sort.key === sortKey;
  const Arrow = sort.desc ? ArrowDown : ArrowUp;
  return (
    <div
      role="columnheader"
      aria-sort={active ? (sort.desc ? "descending" : "ascending") : "none"}
      className={cn("min-w-0 px-3", align === "right" && "text-right")}
    >
      <button
        type="button"
        onClick={() => sortBy(sortKey)}
        className={cn(
          "hover:text-foreground focus-visible:outline-ring inline-flex max-w-full items-center gap-1 rounded-xs outline-none focus-visible:outline-2",
          active && "text-foreground",
        )}
      >
        <span className="truncate">{children}</span>
        {active && (
          <Arrow className="text-brand size-3 flex-none" aria-hidden />
        )}
      </button>
    </div>
  );
}
