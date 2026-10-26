import { Loader2 } from "lucide-react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

import { useDrag } from "../dragging";
import { FileIcon } from "./FileIcon";

const WIDTH = 240;
const HEIGHT = 52;

/** Card that follows the cursor while rows are dragged. */
export function DragGhost() {
  const { t } = useTranslation("files");
  const payload = useDrag((s) => s.payload);
  const x = useDrag((s) => s.x);
  const y = useDrag((s) => s.y);
  const target = useDrag((s) => s.target);
  const outside = useDrag((s) => s.outside);
  const out = useDrag((s) => s.out);
  if (!payload) return null;

  const first = payload.entries[0];
  const count = payload.entries.length;
  const preparing = out.phase === "preparing";
  const hint = target
    ? t("dragOut.copyTo", { name: target.name })
    : preparing && (outside || out.total > 0)
      ? out.total > 0
        ? t("dragOut.preparingPercent", {
            percent: Math.floor((out.bytes / out.total) * 100),
          })
        : t("dragOut.preparing")
      : outside
        ? t("dragOut.release")
        : null;

  // Stay visible at the window edge while the cursor is outside.
  const left = Math.max(4, Math.min(x + 14, window.innerWidth - WIDTH - 4));
  const top = Math.max(4, Math.min(y + 16, window.innerHeight - HEIGHT - 4));

  return createPortal(
    <div
      aria-hidden
      className="bg-popover pointer-events-none fixed z-[100] flex max-w-[240px] min-w-0 items-center gap-2.5 rounded-lg border px-3 py-2 shadow-lg"
      style={{ left, top }}
    >
      {first && <FileIcon entry={first} className="size-4" />}
      <div className="flex min-w-0 flex-col">
        <span className="text-small truncate font-medium">
          {count === 1 && first ? first.name : t("dialogs.items", { count })}
        </span>
        {hint && (
          <span
            className={cn(
              "text-caption flex items-center gap-1 truncate",
              target ? "text-brand" : "text-muted-foreground",
            )}
          >
            {preparing && !target && (
              <Loader2 className="size-3 flex-none animate-spin" />
            )}
            <span className="num truncate">{hint}</span>
          </span>
        )}
      </div>
      {count > 1 && (
        <span className="bg-brand text-primary-foreground text-caption num ml-auto flex h-5 min-w-5 flex-none items-center justify-center rounded-full px-1.5 font-semibold">
          {count}
        </span>
      )}
    </div>,
    document.body,
  );
}
