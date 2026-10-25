// biome-ignore-all lint/a11y/useSemanticElements: virtualized ARIA grid built from divs
// biome-ignore-all lint/a11y/useFocusableInteractive: the grid container takes focus and handles keys
// biome-ignore-all lint/a11y/useKeyWithClickEvents: the grid container handles keys
// biome-ignore-all lint/a11y/noStaticElementInteractions: click guards around checkboxes
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "cn";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Checkbox } from "@/components/ui/checkbox";

import { type FileEntry, isDirLike } from "../api";
import { formatBytes } from "../format";
import { useThumbnail } from "../queries";
import { FileIcon } from "./FileIcon";
import type { ListProps } from "./listProps";

const TILE = 132;
const TILE_HEIGHT = 168;
const GAP = 8;
const PAD = 12;

/** Thumbnail grid; images load lazily for the rows on screen. */
export function FileGrid({
  serial,
  entries,
  selected,
  focused,
  scrollRef,
  onRowClick,
  onToggle,
  onOpen,
}: ListProps & { serial: string }) {
  const [width, setWidth] = useState(800);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [scrollRef]);

  const columns = Math.max(
    1,
    Math.floor((width - PAD * 2 + GAP) / (TILE + GAP)),
  );
  const rows = Math.ceil(entries.length / columns);
  const virtualizer = useVirtualizer({
    count: rows,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => TILE_HEIGHT + GAP,
    overscan: 3,
    paddingStart: PAD,
    paddingEnd: PAD,
  });

  const focusedIndex = focused
    ? entries.findIndex((e) => e.path === focused)
    : -1;
  useEffect(() => {
    if (focusedIndex >= 0)
      virtualizer.scrollToIndex(Math.floor(focusedIndex / columns), {
        align: "auto",
      });
  }, [focusedIndex, columns, virtualizer]);

  return (
    <div
      role="grid"
      aria-multiselectable
      className="relative"
      style={{ height: virtualizer.getTotalSize() }}
    >
      {virtualizer.getVirtualItems().map((row) => (
        <div
          key={row.key}
          role="row"
          className="absolute top-0 flex"
          style={{
            transform: `translateY(${row.start}px)`,
            left: PAD,
            gap: GAP,
          }}
        >
          {entries
            .slice(row.index * columns, row.index * columns + columns)
            .map((entry) => (
              <Tile
                key={entry.path}
                serial={serial}
                entry={entry}
                selected={selected.has(entry.path)}
                focused={focused === entry.path}
                onClick={(e) => onRowClick(entry, e)}
                onToggle={() => onToggle(entry)}
                onOpen={() => onOpen(entry)}
              />
            ))}
        </div>
      ))}
    </div>
  );
}

function Tile({
  serial,
  entry,
  selected,
  focused,
  onClick,
  onToggle,
  onOpen,
}: {
  serial: string;
  entry: FileEntry;
  selected: boolean;
  focused: boolean;
  onClick: (e: React.MouseEvent) => void;
  onToggle: () => void;
  onOpen: () => void;
}) {
  const { t } = useTranslation("files");
  const { data: thumb } = useThumbnail(serial, entry, true);
  return (
    <div
      role="gridcell"
      aria-selected={selected}
      data-path={entry.path}
      onClick={onClick}
      onDoubleClick={onOpen}
      className={cn(
        "group/tile relative flex flex-col gap-1.5 rounded-lg border border-transparent p-1.5",
        selected ? "bg-brand/15 border-brand/30" : "hover:bg-accent",
        focused && "outline-ring outline-1",
        entry.unreadable && "opacity-60",
      )}
      style={{ width: TILE, height: TILE_HEIGHT }}
    >
      <div className="bg-sidebar flex h-[96px] items-center justify-center overflow-hidden rounded-md">
        {thumb?.type === "image" ? (
          <img
            src={thumb.url}
            alt=""
            draggable={false}
            className="size-full object-cover"
          />
        ) : (
          <FileIcon entry={entry} className="size-9" />
        )}
      </div>
      <div
        className={cn(
          "absolute top-2.5 left-2.5",
          !selected && "opacity-0 group-hover/tile:opacity-100",
        )}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <Checkbox
          aria-label={t("table.select", { name: entry.name })}
          checked={selected}
          onCheckedChange={onToggle}
          tabIndex={-1}
          className="bg-background"
        />
      </div>
      <div
        className="text-small line-clamp-2 px-0.5 leading-4 break-all"
        title={entry.name}
      >
        {entry.name}
      </div>
      <div className="text-muted-foreground num text-caption mt-auto px-0.5">
        {isDirLike(entry) ? t("grid.folder") : formatBytes(entry.size)}
      </div>
    </div>
  );
}
