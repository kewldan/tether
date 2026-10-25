import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { type AppComponent, type ComponentKind, startActivity } from "../api";
import { Segmented } from "../components/Segmented";
import { shortClass } from "../naming";
import { errorHint, errorMessage, useAppComponents } from "../queries";
import { Panel } from "./Panel";

type Filter = "activities" | "services" | "receivers" | "providers";
const KINDS: Record<Filter, ComponentKind[]> = {
  activities: ["activity", "alias"],
  services: ["service"],
  receivers: ["receiver"],
  providers: ["provider"],
};

export const isLauncher = (c: AppComponent) =>
  c.actions.includes("android.intent.action.MAIN") &&
  c.categories.includes("android.intent.category.LAUNCHER");

/** Starts `pkg/<class>` and reports failures (e.g. not exported). */
export function useStartActivity(serial: string, pkg: string) {
  const { t } = useTranslation("apps");
  return (c: AppComponent) =>
    startActivity({ serial, component: `${pkg}/${c.name}` })
      .then(() =>
        toast.success(
          t("components.started", { name: shortClass(pkg, c.name) }),
        ),
      )
      .catch((e) =>
        toast.error(errorMessage(e), {
          description: errorHint(e) ?? t("components.startHint"),
        }),
      );
}

export function ComponentRow({
  pkg,
  component,
  first,
  onStart,
  compact,
}: {
  pkg: string;
  component: AppComponent;
  first: boolean;
  onStart?: (c: AppComponent) => void;
  compact?: boolean;
}) {
  const { t } = useTranslation("apps");
  const c = component;
  const startable = onStart && (c.kind === "activity" || c.kind === "alias");
  return (
    <div
      className={cn(
        "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-3 text-[12px]",
        compact ? "h-[34px]" : "min-h-[38px] py-1.5",
        !first && "border-t",
      )}
    >
      <span className="flex min-w-0 flex-wrap items-center gap-1.5">
        <span className="selectable truncate font-mono" title={c.name}>
          {shortClass(pkg, c.name)}
        </span>
        {isLauncher(c) && <Badge className="h-4 text-[10px]">LAUNCHER</Badge>}
        {!compact && (
          <>
            {c.exported ? (
              <Badge variant="info" className="h-4 text-[10px]">
                {t("components.exported")}
              </Badge>
            ) : null}
            {!c.enabled && (
              <Badge className="h-4 text-[10px] line-through">
                {t("badge.disabled")}
              </Badge>
            )}
            {c.permission && (
              <span className="text-muted-foreground truncate font-mono text-[11px]">
                {c.permission}
              </span>
            )}
          </>
        )}
      </span>
      {startable ? (
        <Button size="sm" variant="outline" onClick={() => onStart(c)}>
          {t("components.start")}
        </Button>
      ) : (
        <span />
      )}
    </div>
  );
}

export function ComponentsTab({
  serial,
  pkg,
}: {
  serial: string;
  pkg: string;
}) {
  const { t } = useTranslation("apps");
  const components = useAppComponents(serial, pkg);
  const [filter, setFilter] = useState<Filter>("activities");
  const [query, setQuery] = useState("");
  const start = useStartActivity(serial, pkg);

  const all = components.data?.components ?? [];
  const counts = useMemo(() => {
    const out = {} as Record<Filter, number>;
    for (const f of Object.keys(KINDS) as Filter[]) {
      out[f] = all.filter((c) => KINDS[f].includes(c.kind)).length;
    }
    return out;
  }, [all]);
  const q = query.trim().toLowerCase();
  const rows = all
    .filter((c) => KINDS[filter].includes(c.kind))
    .filter((c) => !q || c.name.toLowerCase().includes(q))
    .sort((a, b) => Number(isLauncher(b)) - Number(isLauncher(a)));

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          value={filter}
          onChange={setFilter}
          label={t("components.filter")}
          items={(Object.keys(KINDS) as Filter[]).map((f) => ({
            value: f,
            label: t(`components.${f}`),
            count: components.data ? counts[f] : null,
          }))}
        />
        <div className="border-input bg-background focus-within:border-ring ml-auto flex h-7 w-[240px] items-center gap-2 rounded-[7px] border px-2.5">
          <Search className="text-muted-foreground size-3.5" aria-hidden />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("components.search")}
            aria-label={t("components.search")}
            spellCheck={false}
            className="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent outline-none"
          />
        </div>
      </div>
      {components.isPending ? (
        <Skeleton className="h-40 rounded-[10px]" />
      ) : components.error ? (
        <div className="text-error bg-card rounded-[10px] border px-3.5 py-4">
          {errorMessage(components.error)}
        </div>
      ) : (
        <Panel
          title={t(`components.${filter}`)}
          aside={
            <span className="text-muted-foreground tabular-nums">
              {rows.length}
            </span>
          }
        >
          {rows.length === 0 ? (
            <div className="text-muted-foreground px-3.5 py-6 text-center">
              {t("components.none")}
            </div>
          ) : (
            rows.map((c, i) => (
              <ComponentRow
                key={`${c.kind}:${c.name}`}
                pkg={pkg}
                component={c}
                first={i === 0}
                onStart={start}
              />
            ))
          )}
        </Panel>
      )}
    </div>
  );
}
