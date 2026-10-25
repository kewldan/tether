import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  type AppDetails,
  type AppOpEntry,
  type OpMode,
  type StandbyBucket,
  setAppOp,
  setBatteryUnrestricted,
  setStandbyBucket,
} from "../api";
import { formatBytes } from "../format";
import {
  errorHint,
  errorMessage,
  useAppBattery,
  useAppOps,
  useAppStorage,
} from "../queries";
import type { AppActions } from "../useAppActions";
import { Panel } from "./Panel";
import { StoragePanel } from "./SidePanels";

const onError = (e: unknown) =>
  toast.error(errorMessage(e), { description: errorHint(e) });

export function StorageTab({
  serial,
  details,
  actions,
}: {
  serial: string;
  details: AppDetails;
  actions: AppActions;
}) {
  const { t } = useTranslation("apps");
  const storage = useAppStorage(serial, details.package);
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-start gap-4 max-[1100px]:grid-cols-1">
      <div className="flex flex-col gap-3">
        <StoragePanel
          storage={storage.data}
          splits={details.splits.length}
          loading={storage.isPending}
        />
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => void actions.clearCache(details)}
          >
            {t("actions.clearCache")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => actions.clearData([details])}
          >
            {t("actions.clearDataEllipsis")}
          </Button>
        </div>
      </div>
      <Panel title={t("storage.apkFiles", { count: details.apks.length })}>
        {details.apks.map((apk, i) => (
          <div
            key={apk.path}
            className={cn(
              "grid min-h-9 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3.5 py-1.5",
              i > 0 && "border-t",
            )}
          >
            <span
              className="selectable truncate font-mono text-[12px]"
              title={apk.path}
            >
              {apk.path.split("/").pop()}
            </span>
            <span className="text-small tabular-nums">
              {formatBytes(apk.size)}
            </span>
          </div>
        ))}
      </Panel>
    </div>
  );
}

const BUCKETS: { value: StandbyBucket; code: number }[] = [
  { value: "active", code: 10 },
  { value: "working_set", code: 20 },
  { value: "frequent", code: 30 },
  { value: "rare", code: 40 },
  { value: "restricted", code: 45 },
];

export function BatteryTab({ serial, pkg }: { serial: string; pkg: string }) {
  const { t } = useTranslation("apps");
  const client = useQueryClient();
  const battery = useAppBattery(serial, pkg);
  const refresh = () =>
    client.invalidateQueries({ queryKey: ["app", serial, pkg] });
  const bucket = useMutation({
    mutationFn: (b: StandbyBucket) =>
      setStandbyBucket({ serial, package: pkg, bucket: b }),
    onError,
    onSettled: refresh,
  });
  const unrestricted = useMutation({
    mutationFn: (v: boolean) =>
      setBatteryUnrestricted({ serial, package: pkg, unrestricted: v }),
    onError,
    onSettled: refresh,
  });
  const background = useMutation({
    mutationFn: (allow: boolean) =>
      setAppOp({
        serial,
        package: pkg,
        op: "RUN_ANY_IN_BACKGROUND",
        mode: allow ? "allow" : "ignore",
        uidScope: false,
      }),
    onError,
    onSettled: refresh,
  });

  if (battery.isPending)
    return <Skeleton className="h-40 max-w-[640px] rounded-[10px]" />;
  if (battery.error)
    return <div className="text-error">{errorMessage(battery.error)}</div>;
  const b = battery.data;
  const current = BUCKETS.find((x) => x.code === b.standbyBucket)?.value;

  return (
    <div className="flex max-w-[640px] flex-col gap-3">
      <Panel title={t("battery.title")}>
        <Row
          label={t("battery.unrestricted")}
          hint={t("battery.unrestrictedHint")}
        >
          <Switch
            checked={b.unrestricted}
            disabled={unrestricted.isPending}
            onCheckedChange={(v) => unrestricted.mutate(v)}
            aria-label={t("battery.unrestricted")}
          />
        </Row>
        <Row
          label={t("battery.background")}
          hint={t("battery.backgroundHint")}
          border
        >
          <Switch
            checked={b.background !== "ignore" && b.background !== "deny"}
            disabled={background.isPending}
            onCheckedChange={(v) => background.mutate(v)}
            aria-label={t("battery.background")}
          />
        </Row>
        <Row label={t("battery.bucket")} hint={t("battery.bucketHint")} border>
          {b.standbyBucket === 5 ? (
            <span className="text-small text-muted-foreground">
              {t("battery.buckets.exempted")}
            </span>
          ) : (
            <Select
              value={current ?? null}
              onValueChange={(v) => v && bucket.mutate(v as StandbyBucket)}
            >
              <SelectTrigger size="sm" className="min-w-36">
                <SelectValue placeholder={b.standbyBucket ?? "—"}>
                  {(v: StandbyBucket | null) =>
                    v ? t(`battery.buckets.${v}`) : "—"
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {BUCKETS.map((x) => (
                  <SelectItem key={x.value} value={x.value}>
                    {t(`battery.buckets.${x.value}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </Row>
      </Panel>
      <p className="text-small text-muted-foreground m-0">
        {t("battery.networkNote")}
      </p>
    </div>
  );
}

function Row({
  label,
  hint,
  border,
  children,
}: {
  label: string;
  hint: string;
  border?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-3.5 py-2.5",
        border && "border-t",
      )}
    >
      <span className="min-w-0">
        <span className="block">{label}</span>
        <span className="text-small text-muted-foreground block">{hint}</span>
      </span>
      {children}
    </div>
  );
}

const MODES: OpMode[] = ["allow", "ignore", "deny", "default", "foreground"];

export function AppOpsTab({
  serial,
  details,
}: {
  serial: string;
  details: AppDetails;
}) {
  const { t } = useTranslation("apps");
  const client = useQueryClient();
  const ops = useAppOps(serial, details.package, details.uid);
  const [showUid, setShowUid] = useState(false);
  const set = useMutation({
    mutationFn: (a: { op: string; mode: OpMode; uid: boolean }) =>
      setAppOp({
        serial,
        package: details.package,
        op: a.op,
        mode: a.mode,
        uidScope: a.uid,
      }),
    onError,
    onSettled: () =>
      client.invalidateQueries({
        queryKey: ["app", serial, details.package, "ops"],
      }),
  });

  if (ops.isPending) return <Skeleton className="h-60 rounded-[10px]" />;
  if (ops.error)
    return <div className="text-error">{errorMessage(ops.error)}</div>;

  const table = (entries: AppOpEntry[], uid: boolean) => (
    <Panel
      title={uid ? t("ops.uidTitle") : t("ops.packageTitle")}
      aside={
        <span className="text-muted-foreground tabular-nums">
          {entries.length}
        </span>
      }
    >
      {entries.length === 0 ? (
        <div className="text-muted-foreground px-3.5 py-6 text-center">
          {t("ops.none")}
        </div>
      ) : (
        entries.map((e, i) => (
          <div
            key={e.op}
            className={cn(
              "grid min-h-10 grid-cols-[minmax(0,1fr)_minmax(0,200px)_140px] items-center gap-3 px-3.5 py-1",
              i > 0 && "border-t",
            )}
          >
            <span className="flex min-w-0 items-center gap-2">
              <span className="selectable truncate font-mono text-[12px]">
                {e.op}
              </span>
              {e.running && (
                <span className="text-success text-caption">
                  {t("ops.running")}
                </span>
              )}
            </span>
            <span className="text-small text-muted-foreground truncate tabular-nums">
              {e.lastAccess
                ? t("ops.lastAccess", { time: e.lastAccess.replace(/^\+/, "") })
                : e.lastReject
                  ? t("ops.lastReject", {
                      time: e.lastReject.replace(/^\+/, ""),
                    })
                  : ""}
            </span>
            <Select
              value={e.mode}
              onValueChange={(v) =>
                v && set.mutate({ op: e.op, mode: v as OpMode, uid })
              }
            >
              <SelectTrigger size="sm" className="w-full">
                <SelectValue>
                  {(v: string) => t(`opMode.${v}`, { defaultValue: v })}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {MODES.map((m) => (
                  <SelectItem key={m} value={m}>
                    {t(`opMode.${m}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ))
      )}
    </Panel>
  );

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {table(ops.data.package, false)}
      {ops.data.uid.length > 0 && (
        <div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setShowUid((v) => !v)}
          >
            {showUid
              ? t("ops.hideUid")
              : t("ops.showUid", { count: ops.data.uid.length })}
          </Button>
        </div>
      )}
      {showUid && table(ops.data.uid, true)}
    </div>
  );
}
