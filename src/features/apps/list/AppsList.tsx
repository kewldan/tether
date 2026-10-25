import { ChevronsUpDown, PackageX, Search, Upload } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { AppMeta, AppSummary } from "../api";
import { Segmented } from "../components/Segmented";
import { pickAndInstall, useApkDrag } from "../install/openInstaller";
import { errorMessage } from "../queries";
import { type Segment, type SortKey, useAppsView } from "../store";
import type { AppActions } from "../useAppActions";
import { AppsTable } from "./AppsTable";
import { BulkBar } from "./BulkBar";

const SORTS: SortKey[] = ["updated", "installed", "name", "size", "package"];
const SKELETON_ROWS = Array.from({ length: 10 }, (_, i) => `skeleton-${i}`);

export function AppsList({
  apps,
  rows,
  counts,
  meta,
  loading,
  error,
  onRetry,
  onOpen,
  actions,
}: {
  apps: AppSummary[] | undefined;
  rows: AppSummary[];
  counts: Record<Segment, number> | null;
  meta: Record<string, AppMeta>;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  onOpen: (pkg: string) => void;
  actions: AppActions;
}) {
  const { t } = useTranslation("apps");
  const { segment, setSegment, query, setQuery, sort, descending, setSort } =
    useAppsView();
  const searchRef = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchor = useRef<string | null>(null);
  const dragging = useApkDrag((s) => s.dragging);

  // Drop selections that disappeared (uninstalled, filtered device change).
  useEffect(() => {
    if (!apps) return;
    setSelected((prev) => {
      const present = new Set(apps.map((a) => a.package));
      const next = new Set([...prev].filter((p) => present.has(p)));
      return next.size === prev.size ? prev : next;
    });
  }, [apps]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;
      if (e.key === "/" && !typing) {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === "Escape" && !typing) {
        setSelected(new Set());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const toggle = (pkg: string, on: boolean, range: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const from = anchor.current
        ? rows.findIndex((r) => r.package === anchor.current)
        : -1;
      const to = rows.findIndex((r) => r.package === pkg);
      if (range && from >= 0 && to >= 0) {
        const [a, b] = from < to ? [from, to] : [to, from];
        for (const r of rows.slice(a, b + 1)) {
          if (on) next.add(r.package);
          else next.delete(r.package);
        }
      } else if (on) next.add(pkg);
      else next.delete(pkg);
      return next;
    });
    anchor.current = pkg;
  };

  const selectedApps = useMemo(
    () => (apps ?? []).filter((a) => selected.has(a.package)),
    [apps, selected],
  );

  const segments: { value: Segment; label: string; count: number | null }[] = (
    ["user", "system", "disabled", "all"] as const
  ).map((value) => ({
    value,
    label: t(`segment.${value}`),
    count: counts?.[value] ?? null,
  }));

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2.5 px-5 py-3">
        <Segmented
          value={segment}
          onChange={setSegment}
          items={segments}
          label={t("segment.label")}
        />
        <div className="border-input bg-background focus-within:border-ring flex h-7 w-[300px] max-w-full min-w-0 items-center gap-2 rounded-[7px] border px-2.5">
          <Search
            className="text-muted-foreground size-3.5 flex-none"
            aria-hidden
          />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setQuery("");
                e.currentTarget.blur();
              }
            }}
            placeholder={t("list.search")}
            aria-label={t("list.searchLabel")}
            spellCheck={false}
            className="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent outline-none"
          />
          {!query && <Kbd>/</Kbd>}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="outline" size="sm" className="ml-auto" />}
          >
            {t("sort.label", { sort: t(`sort.${sort}`) })}
            <ChevronsUpDown />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuRadioGroup
              value={sort}
              onValueChange={(v) => setSort(v as SortKey, descending)}
            >
              {SORTS.map((s) => (
                <DropdownMenuRadioItem key={s} value={s}>
                  {t(`sort.${s}`)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup
              value={descending ? "desc" : "asc"}
              onValueChange={(v) => setSort(sort, v === "desc")}
            >
              <DropdownMenuRadioItem value="asc">
                {t("sort.ascending")}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="desc">
                {t("sort.descending")}
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div
        className={cn(
          "text-secondary-foreground mx-5 mb-3 flex h-[52px] flex-none items-center justify-center gap-2.5 rounded-[10px] border-[1.5px] border-dashed px-4 text-center transition-colors",
          dragging ? "border-brand bg-brand/15" : "border-input",
        )}
      >
        <Upload
          className="text-muted-foreground size-4 flex-none"
          aria-hidden
        />
        <span className="truncate">
          {t("drop.stripBefore")}
          <span className="text-foreground font-mono text-[12px]">.apk</span>,{" "}
          <span className="text-foreground font-mono text-[12px]">.apks</span>
          {t("drop.stripOr")}
          <span className="text-foreground font-mono text-[12px]">.xapk</span>
          {t("drop.stripAfter")}
          <button
            type="button"
            className="text-brand hover:underline"
            onClick={() => void pickAndInstall()}
          >
            {t("drop.browse")}
          </button>
        </span>
      </div>

      {error ? (
        <State
          title={t("list.errorTitle")}
          body={errorMessage(error)}
          action={
            <Button size="sm" variant="outline" onClick={onRetry}>
              {t("common:actions.retry")}
            </Button>
          }
        />
      ) : loading || !apps ? (
        <div className="flex flex-col gap-0 border-t" aria-hidden>
          {SKELETON_ROWS.map((key) => (
            <div
              key={key}
              className="flex h-11 items-center gap-3 border-b pr-5 pl-[60px]"
            >
              <Skeleton className="size-7 rounded-[7px]" />
              <div className="flex flex-1 flex-col gap-1.5">
                <Skeleton className="h-2.5 w-[28%]" />
                <Skeleton className="h-2 w-[18%] opacity-60" />
              </div>
              <Skeleton className="h-2.5 w-20" />
              <Skeleton className="h-2.5 w-14" />
            </div>
          ))}
        </div>
      ) : rows.length === 0 ? (
        <State
          title={
            query ? t("list.noMatches", { query }) : t(`list.empty.${segment}`)
          }
          body={query ? t("list.noMatchesHint") : undefined}
          action={
            query ? (
              <Button size="sm" variant="outline" onClick={() => setQuery("")}>
                {t("list.clearSearch")}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <AppsTable
          rows={rows}
          meta={meta}
          selected={selected}
          onToggle={toggle}
          onToggleAll={(on) =>
            setSelected(on ? new Set(rows.map((r) => r.package)) : new Set())
          }
          onOpen={onOpen}
          actions={actions}
        />
      )}

      <BulkBar
        apps={selectedApps}
        actions={actions}
        onClear={() => setSelected(new Set())}
      />
    </div>
  );
}

function State({
  title,
  body,
  action,
}: {
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 border-t px-6 text-center">
      <span className="bg-selected text-secondary-foreground flex size-10 items-center justify-center rounded-[10px]">
        <PackageX className="size-5" aria-hidden />
      </span>
      <div className="font-semibold">{title}</div>
      {body && (
        <div className="text-small text-secondary-foreground max-w-md">
          {body}
        </div>
      )}
      {action}
    </div>
  );
}
