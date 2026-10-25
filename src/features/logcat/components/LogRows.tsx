import { cn } from "cn";
import { ChevronDown, RotateCcw, TriangleAlert } from "lucide-react";
import { memo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";

import type { LogLine } from "../buffer";
import type { Matcher } from "../filter";
import { LEVEL_TEXT, MESSAGE_TEXT, ROW_TINT } from "../format";

/** Shared column grid of the header and log rows (Logcat board). */
export const LOG_GRID =
  "grid grid-cols-[96px_84px_22px_148px_minmax(0,1fr)] gap-2.5 px-4";

/** Wraps search matches in <mark>. */
export function Highlighted({
  text,
  matcher,
}: {
  text: string;
  matcher: Matcher | null;
}) {
  if (!matcher) return text;
  const ranges = matcher.ranges(text);
  if (ranges.length === 0) return text;
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start > at) parts.push(text.slice(at, start));
    parts.push(
      <mark
        key={start}
        className="bg-log-w/30 dark:bg-log-w/32 rounded-[2px] px-px text-inherit"
      >
        {text.slice(start, end)}
      </mark>,
    );
    at = end;
  }
  if (at < text.length) parts.push(text.slice(at));
  return parts;
}

function LevelMark({ level }: { level: LogLine["level"] }) {
  return (
    <span
      className={cn(
        "mt-0.5 inline-flex w-[18px] justify-center rounded-xs text-[11px] leading-[18px] font-bold",
        level === "F"
          ? "bg-log-f text-primary-foreground"
          : cn("bg-selected", LEVEL_TEXT[level]),
      )}
    >
      {level}
    </span>
  );
}

/** One log line. Never animated. */
export const LogRow = memo(function LogRow({
  line,
  selected,
  wrap,
  matcher,
  onSelect,
}: {
  line: LogLine;
  selected: boolean;
  wrap: boolean;
  matcher: Matcher | null;
  onSelect: (line: LogLine) => void;
}) {
  const { t } = useTranslation("logcat");
  const nl = line.message.indexOf("\n");
  const firstLine = nl < 0 ? line.message : line.message.slice(0, nl);
  const extra = nl < 0 ? 0 : line.message.split("\n").length - 1;

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: the list owns focus and arrow keys
    <div
      data-selected={selected || undefined}
      onClick={() => {
        // Keep text selection working: a drag-select is not a click.
        if (!window.getSelection()?.isCollapsed) return;
        onSelect(line);
      }}
      className={cn(
        LOG_GRID,
        "hover:bg-accent min-h-[22px] cursor-pointer items-start",
        ROW_TINT[line.level],
        selected && "bg-brand/15 shadow-[inset_2px_0_0_var(--color-brand)]",
      )}
    >
      <span className="text-muted-foreground num">{line.time}</span>
      <span className="text-muted-foreground num whitespace-pre">
        {`${line.pid}`.padEnd(5)} {line.tid}
      </span>
      <LevelMark level={line.level} />
      <span
        className="text-secondary-foreground truncate"
        title={line.tag.length > 18 ? line.tag : undefined}
      >
        <Highlighted text={line.tag} matcher={matcher} />
      </span>
      {wrap ? (
        <span
          className={cn(
            "selectable break-words whitespace-pre-wrap",
            MESSAGE_TEXT[line.level],
          )}
        >
          <Highlighted text={line.message} matcher={matcher} />
        </span>
      ) : (
        <span className={cn("flex min-w-0 gap-2", MESSAGE_TEXT[line.level])}>
          <span className="selectable truncate whitespace-pre">
            <Highlighted text={firstLine} matcher={matcher} />
          </span>
          {extra > 0 && (
            <span className="text-muted-foreground flex-none">
              {t("list.moreLines", { count: extra })}
            </span>
          )}
        </span>
      )}
    </div>
  );
});

/** Collapsible crash block with the stack trace (Logcat board). */
export const CrashBlock = memo(function CrashBlock({
  line,
  open,
  selected,
  onlyCrashes,
  onToggle,
  onSelect,
  onCopy,
  onOnlyCrashes,
}: {
  line: LogLine;
  open: boolean;
  selected: boolean;
  onlyCrashes: boolean;
  onToggle: (id: number) => void;
  onSelect: (line: LogLine) => void;
  onCopy: (line: LogLine) => void;
  onOnlyCrashes: () => void;
}) {
  const { t } = useTranslation("logcat");
  const crash = line.crash;
  if (!crash) return null;
  const lines = line.message.split("\n");
  // The Java header (`FATAL EXCEPTION: main`) is already the block title.
  const stack = crash.kind === "java" ? lines.slice(1) : lines;
  const pkg = crash.process;

  return (
    <div className="@container px-3 py-1">
      <div
        className={cn(
          "border-error/13 bg-error/13 overflow-hidden rounded-md border shadow-[inset_3px_0_0_var(--color-error)]",
          selected && "ring-brand ring-1",
        )}
      >
        {/* biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: the list owns focus and arrow keys */}
        <div
          className="flex cursor-pointer items-center gap-2.5 py-1.5 pr-2.5 pl-3.5 font-sans"
          onClick={() => onSelect(line)}
        >
          <TriangleAlert className="text-error size-4 flex-none" aria-hidden />
          <span className="text-error flex-none font-semibold">
            {t(`crash.${crash.kind}`)}
          </span>
          <span className="selectable text-small min-w-0 flex-1 truncate font-mono">
            {crash.title}
          </span>
          <span className="text-muted-foreground num text-caption flex-none font-mono @max-2xl:hidden">
            {line.time}
            {crash.pid !== null && ` · ${t("crash.pid", { pid: crash.pid })}`}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              onCopy(line);
            }}
          >
            {t("crash.copy")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            aria-pressed={onlyCrashes}
            className={cn("@max-xl:hidden", onlyCrashes && "bg-selected")}
            onClick={(e) => {
              e.stopPropagation();
              onOnlyCrashes();
            }}
          >
            {t("crash.onlyCrashes")}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("crash.toggle")}
            aria-expanded={open}
            onClick={(e) => {
              e.stopPropagation();
              onToggle(line.id);
            }}
          >
            <ChevronDown className={cn(!open && "-rotate-90")} />
          </Button>
        </div>
        {open && (
          <div className="selectable border-error/13 border-t pt-0.5 pr-3.5 pb-2 pl-10 leading-5">
            {stack.map((l, i) => {
              const ours = pkg !== null && i > 0 && l.includes(pkg);
              return (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: static stack lines
                  key={i}
                  className={cn(
                    "whitespace-pre",
                    ours ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  {l || " "}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
});

export function RestartRow({
  pkg,
  from,
  to,
}: {
  pkg: string;
  from: number;
  to: number;
}) {
  const { t } = useTranslation("logcat");
  return (
    <div className="text-brand text-small flex items-center gap-2.5 px-4 py-1.5 font-sans">
      <span className="bg-brand/15 h-px flex-1" />
      <RotateCcw className="size-3.5" aria-hidden />
      {t("restart", { pkg, from, to })}
      <span className="bg-brand/15 h-px flex-1" />
    </div>
  );
}
