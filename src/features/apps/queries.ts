import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { toast } from "sonner";

import type { AppError } from "@/lib/tauri";
import {
  type AppMeta,
  type AppSummary,
  appBattery,
  appComponents,
  appDetails,
  appNetwork,
  appOps,
  appSigning,
  appStorage,
  listApps,
  loadAppMeta,
} from "./api";
import { appName } from "./naming";
import {
  type Segment,
  type SortKey,
  useAppMetaStore,
  useAppsView,
} from "./store";

export const appsKey = (serial: string | null) => ["apps", serial] as const;

export function useApps(serial: string | null) {
  return useQuery({
    queryKey: appsKey(serial),
    queryFn: () => (serial ? listApps(serial) : Promise.reject()),
    enabled: serial !== null,
    staleTime: 30_000,
  });
}

/** Starts streaming labels/icons for the listed apps (user apps first). */
export function useMetaLoader(serial: string | null, apps?: AppSummary[]) {
  const merge = useAppMetaStore((s) => s.merge);
  useEffect(() => {
    if (!serial || !apps) return;
    const known = useAppMetaStore.getState().bySerial[serial] ?? {};
    const wanted = apps
      .filter((a) => !a.overlay && a.apkPath && !known[a.package])
      .sort((a, b) => Number(a.system) - Number(b.system))
      .map((a) => ({
        package: a.package,
        apkPath: a.apkPath,
        versionCode: a.versionCode,
        lastUpdate: a.lastUpdate,
      }));
    if (wanted.length === 0) return;
    loadAppMeta(serial, wanted, (batch) => merge(serial, batch)).catch(
      () => {},
    );
  }, [serial, apps, merge]);
}

export function segmentOf(app: AppSummary, segment: Segment) {
  switch (segment) {
    case "user":
      return !app.system;
    case "system":
      return app.system && !app.overlay;
    case "disabled":
      return app.disabled;
    case "all":
      return true;
  }
}

function compare(
  a: AppSummary,
  b: AppSummary,
  sort: SortKey,
  meta: Record<string, AppMeta>,
  collator: Intl.Collator,
) {
  switch (sort) {
    case "name":
      return collator.compare(
        appName(a, meta[a.package]),
        appName(b, meta[b.package]),
      );
    case "package":
      return a.package.localeCompare(b.package);
    case "updated":
      return (a.lastUpdate ?? 0) - (b.lastUpdate ?? 0);
    case "installed":
      return (a.firstInstall ?? 0) - (b.firstInstall ?? 0);
    case "size":
      return (a.size ?? 0) - (b.size ?? 0);
  }
}

/** The filtered, searched and sorted list the table (and prev/next) uses. */
export function useVisibleApps(
  apps: AppSummary[] | undefined,
  meta: Record<string, AppMeta>,
) {
  const { segment, query, sort, descending } = useAppsView();
  return useMemo(() => {
    if (!apps) return { rows: [], counts: null };
    const counts: Record<Segment, number> = {
      user: 0,
      system: 0,
      disabled: 0,
      all: apps.length,
    };
    for (const a of apps) {
      if (segmentOf(a, "user")) counts.user++;
      if (segmentOf(a, "system")) counts.system++;
      if (a.disabled) counts.disabled++;
    }
    const q = query.trim().toLowerCase();
    const collator = new Intl.Collator(undefined, { sensitivity: "base" });
    const rows = apps
      .filter((a) => segmentOf(a, segment))
      .filter(
        (a) =>
          !q ||
          a.package.toLowerCase().includes(q) ||
          appName(a, meta[a.package]).toLowerCase().includes(q),
      )
      .sort((a, b) => {
        const r = compare(a, b, sort, meta, collator);
        return (descending ? -r : r) || a.package.localeCompare(b.package);
      });
    return { rows, counts };
  }, [apps, meta, segment, query, sort, descending]);
}

const pkgArgs = (serial: string | null, pkg: string) => ({
  serial: serial ?? "",
  package: pkg,
});

export function useAppDetails(serial: string | null, pkg: string) {
  return useQuery({
    queryKey: ["app", serial, pkg, "details"],
    queryFn: () => appDetails(pkgArgs(serial, pkg)),
    enabled: serial !== null,
  });
}

export function useAppComponents(serial: string | null, pkg: string) {
  return useQuery({
    queryKey: ["app", serial, pkg, "components"],
    queryFn: () => appComponents(pkgArgs(serial, pkg)),
    enabled: serial !== null,
    staleTime: 60_000,
  });
}

export function useAppStorage(serial: string | null, pkg: string) {
  return useQuery({
    queryKey: ["app", serial, pkg, "storage"],
    queryFn: () => appStorage(pkgArgs(serial, pkg)),
    enabled: serial !== null,
  });
}

export function useAppOps(
  serial: string | null,
  pkg: string,
  uid: number | null | undefined,
) {
  return useQuery({
    queryKey: ["app", serial, pkg, "ops"],
    queryFn: () => appOps({ ...pkgArgs(serial, pkg), uid: uid ?? null }),
    enabled: serial !== null && uid !== undefined,
  });
}

export function useAppBattery(serial: string | null, pkg: string) {
  return useQuery({
    queryKey: ["app", serial, pkg, "battery"],
    queryFn: () => appBattery(pkgArgs(serial, pkg)),
    enabled: serial !== null,
  });
}

export function useAppSigning(serial: string | null, pkg: string) {
  return useQuery({
    queryKey: ["app", serial, pkg, "signing"],
    queryFn: () => appSigning(pkgArgs(serial, pkg)),
    enabled: serial !== null,
    staleTime: 5 * 60_000,
  });
}

export function useAppNetwork(
  serial: string | null,
  pkg: string,
  uid: number | null,
) {
  return useQuery({
    queryKey: ["app", serial, pkg, "network", uid],
    queryFn: () => appNetwork({ serial: serial ?? "", uid: uid ?? 0 }),
    enabled: serial !== null && uid !== null,
    staleTime: 30_000,
  });
}

export function errorMessage(error: unknown): string {
  if (typeof error === "object" && error && "message" in error) {
    return String((error as AppError).message);
  }
  return String(error);
}

export function errorHint(error: unknown): string | undefined {
  if (typeof error === "object" && error && "hint" in error) {
    return (error as AppError).hint ?? undefined;
  }
  return undefined;
}

/**
 * Runs a device action, shows its error as a toast and refreshes the app's
 * queries (and the list) afterwards.
 */
export function useAppAction<A>(
  serial: string | null,
  run: (args: A) => Promise<unknown>,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: run,
    onError: (error) =>
      toast.error(errorMessage(error), { description: errorHint(error) }),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ["app", serial] });
      void client.invalidateQueries({ queryKey: appsKey(serial) });
    },
  });
}
