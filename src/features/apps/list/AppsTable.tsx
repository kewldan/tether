import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp } from "lucide-react";
import { type KeyboardEvent, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import type { AppMeta, AppSummary } from "../api";
import { AppBadges } from "../components/AppBadges";
import { AppIcon } from "../components/AppIcon";
import { formatBytes, formatWhen } from "../format";
import { appName } from "../naming";
import { type SortKey, useAppsView } from "../store";
import type { AppActions } from "../useAppActions";
import { AppRowMenu } from "./AppRowMenu";

const ROW = 44;
const TH =
  "bg-background text-small text-muted-foreground sticky top-0 z-10 h-8 border-b px-3 text-left font-medium whitespace-nowrap";
const TD = "h-11 border-b px-3 whitespace-nowrap";

function SortHeader({
  sortKey,
  children,
  align = "left",
}: {
  sortKey: SortKey;
  children: string;
  align?: "left" | "right";
}) {
  const { sort, descending, setSort } = useAppsView();
  const on = sort === sortKey;
  const Arrow = descending ? ArrowDown : ArrowUp;
  return (
    <button
      type="button"
      onClick={() => setSort(sortKey)}
      className={cn(
        "hover:text-foreground inline-flex items-center gap-1 outline-none focus-visible:underline",
        align === "right" && "justify-end",
      )}
    >
      {children}
      {on && <Arrow className="text-brand size-3" aria-hidden />}
    </button>
  );
}

/**
 * Dense, virtualized apps table (Apps board, Components "Dense table"):
 * only visible rows are rendered, with spacer rows keeping the scroll
 * height, so a few hundred packages stay smooth.
 */
export function AppsTable({
  rows,
  meta,
  selected,
  onToggle,
  onToggleAll,
  onOpen,
  actions,
}: {
  rows: AppSummary[];
  meta: Record<string, AppMeta>;
  selected: Set<string>;
  onToggle: (pkg: string, on: boolean, range: boolean) => void;
  onToggleAll: (on: boolean) => void;
  onOpen: (pkg: string) => void;
  actions: AppActions;
}) {
  const { t, i18n } = useTranslation("apps");
  const { sort, descending } = useAppsView();
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW,
    overscan: 12,
  });
  const items = virtualizer.getVirtualItems();
  const before = items[0]?.start ?? 0;
  const after = virtualizer.getTotalSize() - (items.at(-1)?.end ?? 0);
  const now = Date.now();
  const all = rows.length > 0 && rows.every((r) => selected.has(r.package));
  const some = !all && rows.some((r) => selected.has(r.package));
  const ariaSort = (key: SortKey) =>
    sort === key ? (descending ? "descending" : "ascending") : undefined;

  // Arrow keys move between rows' name buttons; space toggles selection.
  const onKey = (e: KeyboardEvent, index: number, pkg: string) => {
    if (e.key === " ") {
      e.preventDefault();
      onToggle(pkg, !selected.has(pkg), e.shiftKey);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = index + (e.key === "ArrowDown" ? 1 : -1);
      if (next < 0 || next >= rows.length) return;
      virtualizer.scrollToIndex(next);
      requestAnimationFrame(() =>
        scrollRef.current
          ?.querySelector<HTMLElement>(`[data-row="${next}"]`)
          ?.focus(),
      );
    }
  };

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto border-t">
      <table
        className="w-full table-fixed border-collapse"
        aria-label={t("list.tableLabel")}
        aria-rowcount={rows.length + 1}
      >
        <colgroup>
          <col className="w-[52px]" />
          <col />
          <col className="w-[170px]" />
          <col className="w-[96px]" />
          <col className="w-[104px]" />
          <col className="w-[220px] max-[1180px]:w-[150px]" />
          <col className="w-[48px]" />
        </colgroup>
        <thead>
          <tr>
            <th className={cn(TH, "pr-0 pl-5")}>
              <Checkbox
                checked={all}
                indeterminate={some}
                onCheckedChange={(v) => onToggleAll(v)}
                aria-label={t("list.selectAll")}
              />
            </th>
            <th className={TH} aria-sort={ariaSort("name")}>
              <SortHeader sortKey="name">{t("list.columns.app")}</SortHeader>
            </th>
            <th className={TH}>{t("list.columns.version")}</th>
            <th className={cn(TH, "text-right")} aria-sort={ariaSort("size")}>
              <SortHeader sortKey="size" align="right">
                {t("list.columns.size")}
              </SortHeader>
            </th>
            <th className={TH} aria-sort={ariaSort("updated")}>
              <SortHeader sortKey="updated">
                {t("list.columns.updated")}
              </SortHeader>
            </th>
            <th className={TH}>
              <span className="sr-only">{t("list.columns.tags")}</span>
            </th>
            <th className={TH}>
              <span className="sr-only">{t("list.more")}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {before > 0 && (
            <tr aria-hidden style={{ height: before }}>
              <td colSpan={7} />
            </tr>
          )}
          {items.map((item) => {
            const app = rows[item.index];
            const m = meta[app.package];
            const name = appName(app, m);
            const isSelected = selected.has(app.package);
            return (
              <tr
                key={app.package}
                aria-rowindex={item.index + 2}
                aria-selected={isSelected}
                onClick={(e) => {
                  if (e.shiftKey || e.metaKey || e.ctrlKey) {
                    onToggle(app.package, !isSelected, e.shiftKey);
                  } else {
                    onOpen(app.package);
                  }
                }}
                className={cn(
                  "cursor-default",
                  isSelected ? "bg-brand/15" : "hover:bg-accent",
                )}
              >
                <td className={cn(TD, "pr-0 pl-5")}>
                  <Checkbox
                    checked={isSelected}
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggle(app.package, !isSelected, e.shiftKey);
                    }}
                    aria-label={t("list.select", { name })}
                  />
                </td>
                <td className={TD}>
                  <button
                    type="button"
                    data-row={item.index}
                    onClick={(e) => {
                      if (e.shiftKey || e.metaKey || e.ctrlKey) return;
                      e.stopPropagation();
                      onOpen(app.package);
                    }}
                    onKeyDown={(e) => onKey(e, item.index, app.package)}
                    className="focus-visible:outline-ring flex w-full min-w-0 items-center gap-3 rounded-md text-left outline-none focus-visible:outline-2 focus-visible:outline-offset-2"
                  >
                    <AppIcon
                      pkg={app.package}
                      name={name}
                      icon={m?.icon}
                      dimmed={app.disabled}
                    />
                    <span className="min-w-0">
                      <span
                        className={cn(
                          "block truncate font-medium",
                          app.disabled && "text-secondary-foreground",
                        )}
                      >
                        {name}
                      </span>
                      <span className="text-muted-foreground block truncate font-mono text-[11px] leading-4">
                        {app.package}
                      </span>
                    </span>
                  </button>
                </td>
                <td className={cn(TD, "truncate font-mono text-[12px]")}>
                  {app.versionName ?? "—"}{" "}
                  {app.versionCode > 0 &&
                    app.versionName !== String(app.versionCode) && (
                      <span className="text-muted-foreground">
                        ({app.versionCode})
                      </span>
                    )}
                </td>
                <td className={cn(TD, "text-right tabular-nums")}>
                  {formatBytes(app.size)}
                </td>
                <td
                  className={cn(
                    TD,
                    "text-muted-foreground truncate tabular-nums",
                  )}
                >
                  {formatWhen(app.lastUpdate, t, i18n.language, now)}
                </td>
                <td className={cn(TD, "overflow-hidden")}>
                  <AppBadges app={app} />
                </td>
                <td className={cn(TD, "px-1 text-center")}>
                  <AppRowMenu app={app} actions={actions} />
                </td>
              </tr>
            );
          })}
          {after > 0 && (
            <tr aria-hidden style={{ height: after }}>
              <td colSpan={7} />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
