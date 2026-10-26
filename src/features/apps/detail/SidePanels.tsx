import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Skeleton } from "@/components/ui/skeleton";
import type { AppDetails, AppStorage } from "../api";
import { formatBytes } from "../format";
import { useAppComponents } from "../queries";
import { ComponentRow, isLauncher, useStartActivity } from "./ComponentsTab";
import { KeyValues, Panel } from "./Panel";

const SEGMENTS = [
  { key: "apk", color: "bg-chart-1" },
  { key: "data", color: "bg-chart-2" },
  { key: "cache", color: "bg-chart-3" },
  { key: "external", color: "bg-chart-4" },
] as const;

/** Storage bar + legend (App / User data / Cache / External). */
export function StoragePanel({
  storage,
  splits,
  loading,
}: {
  storage: AppStorage | undefined;
  splits: number;
  loading: boolean;
}) {
  const { t } = useTranslation("apps");
  const values = SEGMENTS.map((s) => ({
    ...s,
    value: storage?.[s.key] ?? null,
  }));
  const total = values.reduce((sum, v) => sum + (v.value ?? 0), 0);
  return (
    <Panel title={t("storage.title")}>
      <div className="flex flex-col gap-2.5 px-3.5 py-3">
        {loading ? (
          <Skeleton className="h-2 rounded-full" />
        ) : (
          <div className="bg-selected flex h-2 gap-0.5 overflow-hidden rounded-full">
            {values
              .filter((v) => v.value)
              .map((v) => (
                <span
                  key={v.key}
                  className={v.color}
                  style={{
                    width: `${((v.value ?? 0) / Math.max(total, 1)) * 100}%`,
                  }}
                />
              ))}
          </div>
        )}
        <dl className="text-small m-0 grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1">
          {values.map((v) => (
            <div key={v.key} className="contents">
              <dt className="flex items-center gap-1.5">
                <span
                  className={`size-[7px] rounded-full ${v.color}`}
                  aria-hidden
                />
                {v.key === "apk"
                  ? splits > 0
                    ? t("storage.appSplits", { count: splits + 1 })
                    : t("storage.app")
                  : t(`storage.${v.key}`)}
              </dt>
              <dd className="m-0 text-right tabular-nums">
                {loading ? "…" : formatBytes(v.value)}
              </dd>
            </div>
          ))}
        </dl>
        {!loading && storage && storage.data === null && (
          <p className="text-caption text-muted-foreground m-0">
            {t("storage.privateHint")}
          </p>
        )}
      </div>
    </Panel>
  );
}

export function LaunchablePanel({
  serial,
  pkg,
  onShowAll,
}: {
  serial: string;
  pkg: string;
  onShowAll: () => void;
}) {
  const { t } = useTranslation("apps");
  const components = useAppComponents(serial, pkg);
  const start = useStartActivity(serial, pkg);
  const activities = (components.data?.components ?? []).filter(
    (c) => c.kind === "activity" || c.kind === "alias",
  );
  const shown = [...activities]
    .sort(
      (a, b) =>
        Number(isLauncher(b)) - Number(isLauncher(a)) ||
        Number(b.exported) - Number(a.exported),
    )
    .slice(0, 4);
  return (
    <Panel
      title={t("components.launchable")}
      aside={
        activities.length > 0 && (
          <button
            type="button"
            className="text-brand font-medium hover:underline"
            onClick={onShowAll}
          >
            {t("components.all", { count: activities.length })}
          </button>
        )
      }
    >
      {components.isPending ? (
        <div className="flex flex-col gap-2 p-3">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ) : shown.length === 0 ? (
        <div className="text-small text-muted-foreground px-3.5 py-3">
          {components.error
            ? t("components.unavailable")
            : t("components.none")}
        </div>
      ) : (
        shown.map((c, i) => (
          <ComponentRow
            key={c.name}
            pkg={pkg}
            component={c}
            first={i === 0}
            onStart={start}
            compact
          />
        ))
      )}
    </Panel>
  );
}

export function PackagePanel({ details }: { details: AppDetails }) {
  const { t } = useTranslation("apps");
  return (
    <Panel title={t("package.title")}>
      <KeyValues
        items={[
          [
            t("package.abi"),
            <span key="abi" className="font-mono">
              {details.primaryAbi ?? "—"}
            </span>,
          ],
          [
            t("package.uid"),
            <span key="uid" className="font-mono">
              {details.uid ?? "—"}
            </span>,
          ],
          ...(details.sharedUser
            ? ([
                [
                  t("package.sharedUser"),
                  <span key="shared" className="font-mono">
                    {details.sharedUser}
                  </span>,
                ],
              ] as [string, ReactNode][])
            : []),
          [
            t("package.dataDir"),
            <span key="dir" className="font-mono" title={details.dataDir ?? ""}>
              {details.dataDir ?? "—"}
            </span>,
          ],
        ]}
      />
    </Panel>
  );
}
