import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import type { LogLine } from "../buffer";
import type { Matcher } from "../filter";
import type { Row } from "../view";
import { CrashBlock, LogRow, RestartRow } from "./LogRows";

const LINE = 22;

function estimate(row: Row, wrap: boolean, collapsed: ReadonlySet<number>) {
  if (row.kind === "restart") return 32;
  const { line } = row;
  if (line.crash) {
    const open = !collapsed.has(line.id);
    return open ? 52 + 20 * Math.min(line.message.split("\n").length, 200) : 42;
  }
  if (!wrap) return LINE;
  let lines = 1;
  for (let i = line.message.indexOf("\n"); i >= 0 && lines < 200; ) {
    lines++;
    i = line.message.indexOf("\n", i + 1);
  }
  // Long single lines wrap too; a rough guess, measured after render.
  return LINE * Math.max(lines, Math.ceil(line.message.length / 160));
}

/**
 * Virtualized log table. Follows the tail while `following`; scrolling up
 * stops following, reaching the bottom resumes it.
 */
export function LogList({
  rows,
  version,
  wrap,
  matcher,
  selectedId,
  following,
  collapsed,
  onlyCrashes,
  onFollowingChange,
  onSelect,
  onToggleCrash,
  onCopyCrash,
  onOnlyCrashes,
}: {
  rows: Row[];
  /** Changes whenever `rows` (mutated in place) changes. */
  version: number;
  wrap: boolean;
  matcher: Matcher | null;
  selectedId: number | null;
  following: boolean;
  collapsed: ReadonlySet<number>;
  onlyCrashes: boolean;
  onFollowingChange: (following: boolean) => void;
  onSelect: (line: LogLine) => void;
  onToggleCrash: (id: number) => void;
  onCopyCrash: (line: LogLine) => void;
  onOnlyCrashes: () => void;
}) {
  const { t } = useTranslation("logcat");
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastTop = useRef(0);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => estimate(rows[i], wrap, collapsed),
    getItemKey: (i) => rows[i].key,
    overscan: 16,
    paddingStart: 4,
    paddingEnd: 4,
  });

  // Re-estimate when the layout mode changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps are the trigger
  useLayoutEffect(() => {
    virtualizer.measure();
  }, [wrap, collapsed]);

  const total = virtualizer.getTotalSize();
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps are the trigger
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (following && el) {
      el.scrollTop = el.scrollHeight;
      lastTop.current = el.scrollTop;
    }
  }, [following, version, total]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 6;
    if (atBottom) {
      if (!following) onFollowingChange(true);
    } else if (following && el.scrollTop < lastTop.current - 40) {
      onFollowingChange(false);
    }
    lastTop.current = el.scrollTop;
  }, [following, onFollowingChange]);

  const selectIndex = (index: number) => {
    const row = rows[index];
    if (row?.kind !== "line") return;
    onSelect(row.line);
    if (following) onFollowingChange(false);
    virtualizer.scrollToIndex(index, { align: "auto" });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const step = e.key === "ArrowDown" ? 1 : -1;
    let i =
      selectedId === null
        ? rows.length
        : rows.findIndex((r) => r.kind === "line" && r.line.id === selectedId);
    if (i < 0) i = rows.length;
    for (let j = i + step; j >= 0 && j < rows.length; j += step) {
      if (rows[j].kind === "line") {
        selectIndex(j);
        return;
      }
    }
  };

  return (
    <div
      ref={scrollRef}
      role="log"
      aria-label={t("list.label")}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard navigation of lines
      tabIndex={0}
      onScroll={onScroll}
      onWheel={(e) => {
        if (e.deltaY < 0 && following) onFollowingChange(false);
      }}
      onKeyDown={onKeyDown}
      className="focus-visible:outline-ring text-small min-h-0 flex-1 overflow-auto font-mono leading-[22px] outline-none focus-visible:outline-2 focus-visible:-outline-offset-2"
    >
      <div className="relative w-full" style={{ height: total }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index];
          return (
            <div
              key={item.key}
              data-index={item.index}
              ref={virtualizer.measureElement}
              className="absolute top-0 left-0 w-full"
              style={{ transform: `translateY(${item.start}px)` }}
            >
              {row.kind === "restart" ? (
                <RestartRow pkg={row.pkg} from={row.from} to={row.to} />
              ) : row.line.crash ? (
                <CrashBlock
                  line={row.line}
                  open={!collapsed.has(row.line.id)}
                  selected={row.line.id === selectedId}
                  onlyCrashes={onlyCrashes}
                  onToggle={onToggleCrash}
                  onSelect={onSelect}
                  onCopy={onCopyCrash}
                  onOnlyCrashes={onOnlyCrashes}
                />
              ) : (
                <LogRow
                  line={row.line}
                  selected={row.line.id === selectedId}
                  wrap={wrap}
                  matcher={matcher}
                  onSelect={onSelect}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
