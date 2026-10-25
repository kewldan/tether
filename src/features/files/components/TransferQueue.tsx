import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  FolderOpen,
  Pause,
  Play,
  RotateCw,
  X,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import { spring } from "@/lib/motion";
import { os } from "@/lib/platform";
import { cn } from "@/lib/utils";

import { formatBytes, formatEta, formatSpeed } from "../format";
import { reveal } from "../reveal";
import { isActive, type Transfer, useTransfers } from "../transfers";

const ROW =
  "grid grid-cols-[20px_minmax(0,1.6fr)_120px_minmax(0,2fr)_90px_60px_56px] items-center gap-3 border-t px-4 text-small";

/**
 * Transfer queue docked under the file list. Styled as the floating panel
 * from the board, but kept in flow so it never hides the last rows.
 */
export function TransferQueue({
  serial,
  onShowFolder,
}: {
  serial: string;
  onShowFolder: (path: string) => void;
}) {
  const { t } = useTranslation("files");
  const items = useTransfers(
    useShallow((s) => s.items.filter((x) => x.serial === serial)),
  );
  const pauseAll = useTransfers((s) => s.pauseAll);
  const resumeAll = useTransfers((s) => s.resumeAll);
  const clearFinished = useTransfers((s) => s.clearFinished);
  const [collapsed, setCollapsed] = useState(false);

  const active = items.filter(isActive);
  const running = active.filter((x) => x.status !== "paused");
  const failed = items.filter((x) => x.status === "failed").length;
  const queued = items.filter((x) => x.status === "queued").length;
  const speed = running.reduce((sum, x) => sum + x.speed, 0);
  const finished = items.length - active.length - queued;

  const summary = [
    active.length > 0 && t("queue.active", { count: active.length }),
    queued > 0 && t("queue.queued", { count: queued }),
    failed > 0 && t("queue.failed", { count: failed }),
    running.length > 0 && speed > 0 && formatSpeed(speed),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <AnimatePresence>
      {items.length > 0 && (
        <motion.section
          aria-label={t("queue.title")}
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 16 }}
          transition={spring.smooth}
          className="bg-popover relative z-20 flex-none overflow-hidden rounded-t-xl border border-b-0 shadow-lg"
        >
          <div className="flex h-10 items-center justify-between gap-3 px-4">
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="font-semibold">{t("queue.title")}</span>
              <span className="text-muted-foreground num text-small truncate">
                {summary || t("queue.allDone")}
              </span>
            </div>
            <div className="flex flex-none items-center gap-1">
              {active.length > 0 &&
                (running.length > 0 ? (
                  <Button variant="ghost" size="sm" onClick={pauseAll}>
                    {t("queue.pauseAll")}
                  </Button>
                ) : (
                  <Button variant="ghost" size="sm" onClick={resumeAll}>
                    {t("queue.resumeAll")}
                  </Button>
                ))}
              {finished > 0 && (
                <Button variant="ghost" size="sm" onClick={clearFinished}>
                  {t("queue.clearFinished")}
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={collapsed ? t("queue.expand") : t("queue.collapse")}
                aria-expanded={!collapsed}
                onClick={() => setCollapsed((c) => !c)}
              >
                {collapsed ? <ChevronUp /> : <ChevronDown />}
              </Button>
            </div>
          </div>
          <motion.div
            initial={false}
            animate={{ height: collapsed ? 0 : "auto" }}
            transition={spring.smooth}
            className="max-h-[180px] overflow-y-auto"
          >
            <AnimatePresence initial={false}>
              {items.map((item) => (
                <motion.div
                  key={item.id}
                  layout
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 36, opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={spring.smooth}
                  className="overflow-hidden"
                >
                  <Row item={item} onShowFolder={onShowFolder} />
                </motion.div>
              ))}
            </AnimatePresence>
          </motion.div>
        </motion.section>
      )}
    </AnimatePresence>
  );
}

function Row({
  item,
  onShowFolder,
}: {
  item: Transfer;
  onShowFolder: (path: string) => void;
}) {
  const { t } = useTranslation("files");
  const cancel = useTransfers((s) => s.cancel);
  const pause = useTransfers((s) => s.pause);
  const resume = useTransfers((s) => s.resume);
  const retry = useTransfers((s) => s.retry);
  const remove = useTransfers((s) => s.remove);

  const computer = t(`computer.${os}`);
  const direction =
    item.direction === "pull"
      ? t("queue.toComputer", { computer })
      : t("queue.toDevice", { computer });
  const failed = item.status === "failed";
  const progress =
    item.totalBytes > 0 ? Math.min(1, item.bytes / item.totalBytes) : 0;
  const eta =
    item.status === "running" && item.speed > 0 && item.totalBytes > 0
      ? formatEta((item.totalBytes - item.bytes) / item.speed, t)
      : "";
  const name =
    item.more > 0
      ? t("queue.more", { name: item.name, count: item.more })
      : item.name;

  return (
    <div className={cn(ROW, "h-9", failed && "bg-error/13")}>
      <StatusIcon item={item} />
      <span className="truncate font-mono" title={item.current || item.name}>
        {name}
      </span>
      <span className="text-muted-foreground truncate">{direction}</span>

      {failed ? (
        <span
          className="text-error col-span-3 truncate"
          title={item.error?.message}
        >
          {item.error?.message}
        </span>
      ) : item.status === "done" ? (
        <span className="text-muted-foreground col-span-3 truncate">
          {t("queue.done", {
            files: t("preview.files", { count: item.summary?.files ?? 0 }),
            size: formatBytes(item.summary?.bytes ?? 0),
          })}
          {item.summary &&
            item.summary.skipped > 0 &&
            ` · ${t("queue.skipped", { count: item.summary.skipped })}`}
        </span>
      ) : item.status === "cancelled" ? (
        <span className="text-muted-foreground col-span-3">
          {t("queue.cancelled")}
        </span>
      ) : (
        <>
          <span
            role="progressbar"
            aria-label={item.name}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress * 100)}
            className="bg-selected block h-1 overflow-hidden rounded-full"
          >
            {item.status === "scanning" || item.status === "queued" ? (
              <span className="bg-primary/60 block h-full w-1/3 animate-pulse rounded-full" />
            ) : (
              <motion.span
                className="bg-primary block h-full origin-left rounded-full"
                initial={false}
                animate={{ scaleX: progress }}
                transition={spring.smooth}
              />
            )}
          </span>
          <span className="text-muted-foreground num truncate">
            {item.status === "paused"
              ? t("queue.paused")
              : item.status === "queued"
                ? t("queue.waiting")
                : item.status === "scanning"
                  ? t("queue.scanning")
                  : formatSpeed(item.speed)}
          </span>
          <span className="text-muted-foreground num truncate">{eta}</span>
        </>
      )}

      <span className="flex items-center justify-end gap-0.5">
        {failed || item.status === "cancelled" ? (
          <Button variant="outline" size="sm" onClick={() => retry(item.id)}>
            <RotateCw />
            {t("queue.retry")}
          </Button>
        ) : item.status === "done" ? (
          <>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={
                item.direction === "pull"
                  ? t("queue.reveal")
                  : t("queue.showOnDevice")
              }
              onClick={() => {
                const dest = item.summary?.destinations[0];
                if (!dest) return;
                if (item.direction === "pull") reveal(dest);
                else onShowFolder(item.target);
              }}
            >
              <FolderOpen />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t("queue.dismiss")}
              onClick={() => remove(item.id)}
            >
              <X />
            </Button>
          </>
        ) : (
          <>
            {item.status === "paused" ? (
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={t("queue.resume")}
                onClick={() => resume(item.id)}
              >
                <Play />
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={t("queue.pause")}
                disabled={item.status === "queued"}
                onClick={() => pause(item.id)}
              >
                <Pause />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t("queue.cancel")}
              onClick={() => cancel(item.id)}
            >
              <X />
            </Button>
          </>
        )}
      </span>
    </div>
  );
}

function StatusIcon({ item }: { item: Transfer }) {
  if (item.status === "failed")
    return <CircleAlert className="text-error size-3.5" aria-label="failed" />;
  if (item.status === "done")
    return <Check className="text-success size-3.5" aria-label="done" />;
  const Icon = item.direction === "pull" ? ArrowDown : ArrowUp;
  return (
    <Icon
      aria-hidden
      className={cn(
        "size-3.5",
        item.status === "cancelled" ? "text-muted-foreground" : "text-info",
      )}
    />
  );
}
