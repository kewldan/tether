import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { StatusDot } from "@/components/status/StatusDot";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  type AppDetails,
  type AppOpEntry,
  type PermissionState,
  resetAppPermissions,
  setAppOp,
  setAppPermission,
} from "../api";
import { Segmented } from "../components/Segmented";
import { errorHint, errorMessage, useAppOps } from "../queries";
import { Panel } from "./Panel";
import {
  GROUP_ICONS,
  GROUP_ORDER,
  groupOf,
  humanize,
  isFixed,
  isModified,
  type PermissionGroup,
  SPECIAL,
  shortPermission,
} from "./permissions";

type View = "runtime" | "install" | "special";

export function PermissionsTab({
  serial,
  details,
}: {
  serial: string;
  details: AppDetails;
}) {
  const { t } = useTranslation("apps");
  const [view, setView] = useState<View>("runtime");
  const client = useQueryClient();
  const pkg = details.package;
  const ops = useAppOps(serial, pkg, details.uid);
  const runtime = details.runtimePermissions;
  const special = details.requestedPermissions.filter((p) => SPECIAL[p]);

  const refresh = () =>
    client.invalidateQueries({ queryKey: ["app", serial, pkg] });
  const onError = (error: unknown) =>
    toast.error(errorMessage(error), { description: errorHint(error) });

  const bulk = useMutation({
    mutationFn: async (mode: "grant" | "revoke" | "reset") => {
      const editable = runtime.filter((p) => !isFixed(p));
      if (mode === "reset") {
        await resetAppPermissions({
          serial,
          package: pkg,
          permissions: editable.map((p) => p.name),
        });
        return;
      }
      const errors: string[] = [];
      for (const p of editable) {
        if (p.granted === (mode === "grant")) continue;
        try {
          await setAppPermission({
            serial,
            package: pkg,
            permission: p.name,
            granted: mode === "grant",
          });
        } catch (e) {
          errors.push(`${shortPermission(p.name)}: ${errorMessage(e)}`);
        }
      }
      if (errors.length > 0) throw { message: errors.join("\n"), hint: null };
    },
    onError,
    onSettled: refresh,
  });

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Segmented
          value={view}
          onChange={setView}
          label={t("permissions.filter")}
          items={[
            {
              value: "runtime",
              label: t("permissions.runtime"),
              count: runtime.length,
            },
            {
              value: "install",
              label: t("permissions.install"),
              count: details.installPermissions.length,
            },
            {
              value: "special",
              label: t("permissions.special"),
              count: special.length,
            },
          ]}
        />
        {view === "runtime" && runtime.length > 0 && (
          <span className="flex gap-1.5">
            <Button
              size="sm"
              variant="outline"
              disabled={bulk.isPending}
              onClick={() => bulk.mutate("grant")}
            >
              {t("permissions.grantAll")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={bulk.isPending}
              onClick={() => bulk.mutate("revoke")}
            >
              {t("permissions.revokeAll")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={bulk.isPending}
              onClick={() => bulk.mutate("reset")}
            >
              {t("permissions.reset")}
            </Button>
          </span>
        )}
      </div>

      {view === "runtime" && (
        <RuntimeList
          serial={serial}
          pkg={pkg}
          permissions={runtime}
          onError={onError}
          onDone={refresh}
        />
      )}
      {view === "install" && (
        <InstallList permissions={details.installPermissions} />
      )}
      {view === "special" && (
        <SpecialList
          serial={serial}
          pkg={pkg}
          requested={special}
          ops={ops.data?.package ?? []}
          loading={ops.isPending}
          onError={onError}
        />
      )}
    </div>
  );
}

function Empty({ children }: { children: string }) {
  return (
    <div className="text-muted-foreground bg-card rounded-[10px] border px-3.5 py-6 text-center">
      {children}
    </div>
  );
}

function RuntimeList({
  serial,
  pkg,
  permissions,
  onError,
  onDone,
}: {
  serial: string;
  pkg: string;
  permissions: PermissionState[];
  onError: (e: unknown) => void;
  onDone: () => void;
}) {
  const { t } = useTranslation("apps");
  const [pending, setPending] = useState<string | null>(null);
  const toggle = useMutation({
    mutationFn: (p: { name: string; granted: boolean }) =>
      setAppPermission({
        serial,
        package: pkg,
        permission: p.name,
        granted: p.granted,
      }),
    onMutate: (p) => setPending(p.name),
    onError,
    onSettled: () => {
      setPending(null);
      onDone();
    },
  });

  if (permissions.length === 0)
    return <Empty>{t("permissions.noneRuntime")}</Empty>;

  const granted = (short: string) =>
    permissions.some((p) => shortPermission(p.name) === short && p.granted);
  const stateText = (p: PermissionState): string | null => {
    const s = shortPermission(p.name);
    if (
      (s === "ACCESS_FINE_LOCATION" || s === "ACCESS_COARSE_LOCATION") &&
      p.granted
    ) {
      return granted("ACCESS_BACKGROUND_LOCATION")
        ? t("permissions.allTheTime")
        : t("permissions.whileInUse");
    }
    if (
      (s === "READ_MEDIA_IMAGES" || s === "READ_MEDIA_VIDEO") &&
      !p.granted &&
      granted("READ_MEDIA_VISUAL_USER_SELECTED")
    ) {
      return t("permissions.selectedOnly");
    }
    if (p.flags.includes("ONE_TIME")) return t("permissions.oneTime");
    return null;
  };

  const groups = new Map<PermissionGroup, PermissionState[]>();
  for (const p of permissions) {
    const g = groupOf(p.name);
    groups.set(g, [...(groups.get(g) ?? []), p]);
  }

  return (
    <>
      {GROUP_ORDER.filter((g) => groups.has(g)).map((g) => {
        const Icon = GROUP_ICONS[g];
        return (
          <Panel
            key={g}
            title={t(`permissions.groups.${g}`)}
            icon={<Icon aria-hidden />}
          >
            {(groups.get(g) ?? []).map((p, i) => {
              const fixed = isFixed(p);
              const label = t(`perm.${shortPermission(p.name)}`, {
                defaultValue: humanize(p.name),
              });
              const state = stateText(p);
              const control = (
                <Switch
                  checked={p.granted}
                  disabled={fixed || pending === p.name}
                  onCheckedChange={(v) =>
                    toggle.mutate({ name: p.name, granted: v })
                  }
                  aria-label={label}
                />
              );
              return (
                <div
                  key={p.name}
                  className={`grid h-10 grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 px-3.5 ${i > 0 ? "border-t" : ""}`}
                >
                  <span className="min-w-0">
                    <span className="block truncate">{label}</span>
                    <span className="text-muted-foreground block truncate font-mono text-[11px] leading-4">
                      {shortPermission(p.name)}
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    {isModified(p) && (
                      <Badge variant="warning">
                        {t("permissions.modified")}
                      </Badge>
                    )}
                    {state && (
                      <span className="text-small text-muted-foreground">
                        {state}
                      </span>
                    )}
                  </span>
                  {fixed ? (
                    <Tooltip>
                      <TooltipTrigger render={<span />}>
                        {control}
                      </TooltipTrigger>
                      <TooltipContent>{t("permissions.fixed")}</TooltipContent>
                    </Tooltip>
                  ) : (
                    control
                  )}
                </div>
              );
            })}
          </Panel>
        );
      })}
    </>
  );
}

function InstallList({ permissions }: { permissions: PermissionState[] }) {
  const { t } = useTranslation("apps");
  if (permissions.length === 0)
    return <Empty>{t("permissions.noneInstall")}</Empty>;
  return (
    <Panel title={t("permissions.installTitle")}>
      {permissions.map((p, i) => (
        <div
          key={p.name}
          className={`grid h-9 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3.5 ${i > 0 ? "border-t" : ""}`}
        >
          <span className="selectable truncate font-mono text-[12px]">
            {shortPermission(p.name)}
          </span>
          <span className="text-small flex items-center gap-1.5">
            <StatusDot tone={p.granted ? "success" : "neutral"} />
            {p.granted ? t("permissions.granted") : t("permissions.denied")}
          </span>
        </div>
      ))}
    </Panel>
  );
}

function SpecialList({
  serial,
  pkg,
  requested,
  ops,
  loading,
  onError,
}: {
  serial: string;
  pkg: string;
  requested: string[];
  ops: AppOpEntry[];
  loading: boolean;
  onError: (e: unknown) => void;
}) {
  const { t } = useTranslation("apps");
  const client = useQueryClient();
  const set = useMutation({
    mutationFn: (a: { op: string; allow: boolean }) =>
      setAppOp({
        serial,
        package: pkg,
        op: a.op,
        mode: a.allow ? "allow" : "default",
        uidScope: false,
      }),
    onError,
    onSettled: () =>
      client.invalidateQueries({ queryKey: ["app", serial, pkg, "ops"] }),
  });
  if (requested.length === 0)
    return <Empty>{t("permissions.noneSpecial")}</Empty>;
  return (
    <Panel title={t("permissions.specialTitle")}>
      {requested.map((perm, i) => {
        const op = SPECIAL[perm];
        const mode = ops.find((o) => o.op === op)?.mode ?? "default";
        const label = t(`special.${op}`, { defaultValue: humanize(perm) });
        return (
          <div
            key={perm}
            className={`grid h-10 grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 px-3.5 ${i > 0 ? "border-t" : ""}`}
          >
            <span className="min-w-0">
              <span className="block truncate">{label}</span>
              <span className="text-muted-foreground block truncate font-mono text-[11px] leading-4">
                {op}
              </span>
            </span>
            <span className="text-small text-muted-foreground">
              {t(`opMode.${mode}`, { defaultValue: mode })}
            </span>
            <Switch
              checked={mode === "allow"}
              disabled={loading || set.isPending}
              onCheckedChange={(v) => set.mutate({ op, allow: v })}
              aria-label={label}
            />
          </div>
        );
      })}
    </Panel>
  );
}
