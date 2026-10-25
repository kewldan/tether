import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Copy,
  Download,
  Folder,
  Play,
  ScrollText,
  Square,
} from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useNavigation } from "@/app/navigation";
import { Page } from "@/components/layout/Page";
import { StatusDot } from "@/components/status/StatusDot";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { spring } from "@/lib/motion";
import { cn } from "@/lib/utils";
import type { AppMeta, AppSummary } from "../api";
import { AppBadges } from "../components/AppBadges";
import { AppIcon } from "../components/AppIcon";
import { formatBytes, formatDate, formatWhen } from "../format";
import { appName } from "../naming";
import {
  errorMessage,
  useAppComponents,
  useAppDetails,
  useAppStorage,
} from "../queries";
import type { AppActions } from "../useAppActions";
import { ComponentsTab } from "./ComponentsTab";
import { AppOpsTab, BatteryTab, StorageTab } from "./OtherTabs";
import { PermissionsTab } from "./PermissionsTab";
import { LaunchablePanel, PackagePanel, StoragePanel } from "./SidePanels";

type Tab = "permissions" | "components" | "storage" | "battery" | "ops";

/** App details (docs/design/project/AppDetail.dc.html). */
export function AppDetailView({
  serial,
  deviceName,
  pkg,
  summary,
  order,
  meta,
  actions,
  onBack,
  onSelect,
}: {
  serial: string;
  deviceName: string;
  pkg: string;
  summary: AppSummary | undefined;
  order: string[];
  meta: AppMeta | undefined;
  actions: AppActions;
  onBack: () => void;
  onSelect: (pkg: string) => void;
}) {
  const { t, i18n } = useTranslation("apps");
  const { t: tc } = useTranslation();
  const navigate = useNavigation((s) => s.navigate);
  const details = useAppDetails(serial, pkg);
  const storage = useAppStorage(serial, pkg);
  const components = useAppComponents(serial, pkg);
  const [tab, setTab] = useState<Tab>("permissions");
  const app = details.data ?? summary;
  const name = app ? appName(app, meta) : pkg;

  const index = order.indexOf(pkg);
  const prev = index > 0 ? order[index - 1] : null;
  const next = index >= 0 && index < order.length - 1 ? order[index + 1] : null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") return;
      if (e.key === "Escape" && !document.querySelector("[role=dialog]"))
        onBack();
      if (e.altKey && e.key === "ArrowUp" && prev) onSelect(prev);
      if (e.altKey && e.key === "ArrowDown" && next) onSelect(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack, onSelect, prev, next]);

  const crumb = (
    <span className="flex items-center gap-1.5">
      {deviceName}
      <ChevronRight className="size-3.5" aria-hidden />
      {tc("nav.apps")}
    </span>
  );

  const headerActions = (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        disabled={!prev}
        onClick={() => prev && onSelect(prev)}
        aria-label={t("detail.previous")}
      >
        <ChevronUp />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        disabled={!next}
        onClick={() => next && onSelect(next)}
        aria-label={t("detail.next")}
      >
        <ChevronDown />
      </Button>
    </>
  );

  if (details.error && !summary) {
    return (
      <Page
        title={pkg}
        parent={{ label: crumb, onClick: onBack }}
        actions={headerActions}
        body="fill"
      >
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
          <div className="font-semibold">{t("detail.notFound")}</div>
          <div className="text-small text-secondary-foreground">
            {errorMessage(details.error)}
          </div>
          <Button size="sm" variant="outline" onClick={onBack}>
            {t("detail.backToList")}
          </Button>
        </div>
      </Page>
    );
  }

  const d = details.data;
  const runtimeCount = d?.runtimePermissions.length;
  const activityCount = components.data?.components.length;
  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: "permissions", label: t("tabs.permissions"), count: runtimeCount },
    { id: "components", label: t("tabs.components"), count: activityCount },
    { id: "storage", label: t("tabs.storage") },
    { id: "battery", label: t("tabs.battery") },
    { id: "ops", label: t("tabs.ops") },
  ];

  return (
    <Page
      title={name}
      parent={{ label: crumb, onClick: onBack }}
      actions={headerActions}
      body="fill"
    >
      <div className="flex items-start gap-4 border-b px-5 pt-[18px] pb-3.5">
        <AppIcon
          pkg={pkg}
          name={name}
          icon={meta?.icon}
          size="lg"
          dimmed={app?.disabled}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2.5">
            <h2 className="text-title m-0 truncate font-semibold">{name}</h2>
            {d?.pid ? (
              <Badge variant="success">
                <StatusDot tone="success" />
                {t("detail.running", { pid: d.pid })}
              </Badge>
            ) : d ? (
              <Badge>
                <StatusDot tone="neutral" />
                {t("detail.notRunning")}
              </Badge>
            ) : null}
            {app && <AppBadges app={app} splitCount />}
          </div>
          <div className="flex items-center gap-1.5 font-mono text-[12px]">
            <span className="selectable">{pkg}</span>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t("detail.copyPackage")}
              onClick={() =>
                void navigator.clipboard
                  .writeText(pkg)
                  .then(() => toast.success(tc("actions.copied")))
              }
            >
              <Copy />
            </Button>
          </div>
          {app ? (
            <div className="text-small text-muted-foreground flex flex-wrap gap-x-4 gap-y-1">
              <span>
                {t("detail.version")}{" "}
                <span className="text-foreground font-mono">
                  {app.versionName ?? "—"} ({app.versionCode})
                </span>
              </span>
              <span>
                {t("detail.sdk")}{" "}
                <span className="text-foreground tabular-nums">
                  {app.minSdk ?? "—"}
                </span>{" "}
                · {t("detail.target")}{" "}
                <span className="text-foreground tabular-nums">
                  {app.targetSdk ?? "—"}
                </span>
              </span>
              <span>
                {t("detail.installer")}{" "}
                <span className="text-foreground font-mono">
                  {app.installer ??
                    d?.initiatingInstaller ??
                    (app.system ? t("detail.preinstalled") : "—")}
                </span>
              </span>
              <span>
                {t("detail.installed")}{" "}
                <span className="text-foreground tabular-nums">
                  {formatDate(app.firstInstall, i18n.language)}
                </span>{" "}
                · {t("detail.updated")}{" "}
                <span className="text-foreground tabular-nums">
                  {formatWhen(app.lastUpdate, t, i18n.language)}
                </span>
              </span>
              <span>
                APK{" "}
                <span className="text-foreground tabular-nums">
                  {formatBytes(app.size)}
                </span>
                {storage.data?.data != null && (
                  <>
                    {" "}
                    · {t("detail.data")}{" "}
                    <span className="text-foreground tabular-nums">
                      {formatBytes(storage.data.data)}
                    </span>
                  </>
                )}
                {storage.data?.cache != null && (
                  <>
                    {" "}
                    · {t("detail.cache")}{" "}
                    <span className="text-foreground tabular-nums">
                      {formatBytes(storage.data.cache)}
                    </span>
                  </>
                )}
              </span>
            </div>
          ) : (
            <Skeleton className="h-3 w-2/3" />
          )}
        </div>
      </div>

      {app && (
        <div className="flex flex-wrap items-center gap-1.5 border-b px-5 py-2.5">
          <Button
            size="sm"
            disabled={app.disabled || (d ? !d.launcher : !app.launcher)}
            onClick={() => void actions.open(app)}
          >
            <Play className="size-[13px]" />
            {t("actions.open")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void actions.forceStop(app)}
          >
            <Square />
            {t("actions.forceStop")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void actions.clearCache(app)}
          >
            {t("actions.clearCache")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => actions.clearData([app])}
          >
            {t("actions.clearDataEllipsis")}
          </Button>
          <span className="bg-input mx-1 h-[18px] w-px" aria-hidden />
          <Button
            size="sm"
            variant="outline"
            onClick={() => actions.logcat(app)}
          >
            <ScrollText />
            {t("actions.logcatForApp")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              navigate("files", { path: `/sdcard/Android/data/${pkg}` })
            }
          >
            <Folder />
            {t("actions.dataFolder")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void actions.extract([app])}
          >
            <Download />
            {t("actions.extract")}
          </Button>
          <span className="ml-auto" />
          <Button
            size="sm"
            variant="ghost"
            onClick={() => actions.setEnabled([app], app.disabled)}
          >
            {app.disabled ? t("actions.enable") : t("actions.disable")}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => actions.uninstall([app], onBack)}
          >
            {t("actions.uninstallEllipsis")}
          </Button>
        </div>
      )}

      <nav
        aria-label={t("tabs.label")}
        className="flex flex-none gap-[18px] overflow-x-auto border-b px-5"
      >
        {tabs.map((x) => (
          <button
            key={x.id}
            type="button"
            aria-current={tab === x.id ? "page" : undefined}
            onClick={() => setTab(x.id)}
            className={cn(
              "focus-visible:outline-ring relative flex h-[38px] items-center gap-1.5 font-medium whitespace-nowrap outline-none focus-visible:outline-2",
              tab === x.id
                ? "text-foreground"
                : "text-secondary-foreground hover:text-foreground",
            )}
          >
            {x.label}
            {x.count !== undefined && (
              <span className="text-muted-foreground tabular-nums">
                {x.count}
              </span>
            )}
            {tab === x.id && (
              <motion.span
                layoutId="app-detail-tab"
                transition={spring.snappy}
                className="bg-brand absolute inset-x-0 -bottom-px h-0.5"
              />
            )}
          </button>
        ))}
      </nav>

      <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
        {!d ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-8 w-80" />
            <Skeleton className="h-40 rounded-[10px]" />
          </div>
        ) : tab === "permissions" ? (
          <div className="grid grid-cols-[minmax(0,1fr)_340px] items-start gap-4 max-[1100px]:grid-cols-1">
            <PermissionsTab serial={serial} details={d} />
            <div className="flex flex-col gap-3">
              <StoragePanel
                storage={storage.data}
                splits={d.splits.length}
                loading={storage.isPending}
              />
              <LaunchablePanel
                serial={serial}
                pkg={pkg}
                onShowAll={() => setTab("components")}
              />
              <PackagePanel details={d} />
            </div>
          </div>
        ) : tab === "components" ? (
          <ComponentsTab serial={serial} pkg={pkg} />
        ) : tab === "storage" ? (
          <StorageTab serial={serial} details={d} actions={actions} />
        ) : tab === "battery" ? (
          <BatteryTab serial={serial} pkg={pkg} />
        ) : (
          <AppOpsTab serial={serial} details={d} />
        )}
      </div>
    </Page>
  );
}
