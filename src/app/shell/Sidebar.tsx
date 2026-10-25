import { Loader, PanelLeft, Settings } from "lucide-react";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { useNavigation } from "@/app/navigation";
import { SECTION_IDS, SECTIONS, type SectionId } from "@/app/sections";
import { DeviceSwitcher } from "@/app/shell/DeviceSwitcher";
import { StatusDot } from "@/components/status/StatusDot";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useDevices } from "@/features/devices/store";
import { useLogcatSession } from "@/features/logcat/session";
import { useAdb } from "@/lib/adb";
import { spring } from "@/lib/motion";
import { useSettings } from "@/lib/settings";
import { useTasks } from "@/lib/tasks";
import { cn } from "@/lib/utils";

const DEVICE_SECTIONS = SECTION_IDS.filter(
  (id) => SECTIONS[id].group === "device",
);
const TOOL_SECTIONS = SECTION_IDS.filter(
  (id) => SECTIONS[id].group === "tools",
);

/** 240 px sidebar; collapses to 56 px icons on the smooth spring. */
export function Sidebar() {
  const { t } = useTranslation();
  const collapsed = useSettings((s) => s.sidebarCollapsed);
  const toggle = useSettings((s) => s.toggleSidebar);
  const hasDevice = useDevices((s) => s.selectedSerial !== null);

  return (
    <motion.aside
      initial={false}
      animate={{ width: collapsed ? 56 : 240 }}
      transition={spring.smooth}
      className="bg-sidebar flex flex-none flex-col overflow-hidden border-r px-2 pt-2.5 pb-2"
    >
      <DeviceSwitcher collapsed={collapsed} />
      <nav
        aria-label={t("nav.overview")}
        className="mt-2.5 flex flex-col gap-px"
      >
        {DEVICE_SECTIONS.map((id) => (
          <NavItem
            key={id}
            id={id}
            collapsed={collapsed}
            disabled={!hasDevice}
          />
        ))}
        {collapsed ? (
          <div className="bg-border mx-2 my-2 h-px" />
        ) : (
          <div className="text-caption text-muted-foreground px-2 pt-3.5 pb-1 font-semibold tracking-[.05em] uppercase">
            {t("nav.tools")}
          </div>
        )}
        {TOOL_SECTIONS.map((id) => (
          <NavItem
            key={id}
            id={id}
            collapsed={collapsed}
            disabled={!hasDevice}
          />
        ))}
      </nav>
      <div className="mt-auto flex flex-col gap-1.5">
        <TasksIndicator collapsed={collapsed} />
        <AdbFooter collapsed={collapsed} onToggle={toggle} />
      </div>
    </motion.aside>
  );
}

function NavItem({
  id,
  collapsed,
  disabled,
}: {
  id: SectionId;
  collapsed: boolean;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const active = useNavigation((s) => s.section === id);
  const navigate = useNavigation((s) => s.navigate);
  const Icon = SECTIONS[id].icon;
  const label = t(`nav.${id}`);
  const crashes = useLogcatSession((s) =>
    id === "logcat" ? s.unseenCrashes : 0,
  );

  return (
    <button
      type="button"
      title={collapsed ? label : undefined}
      aria-current={active ? "page" : undefined}
      disabled={disabled}
      onClick={() => navigate(id)}
      className={cn(
        "focus-visible:outline-ring relative flex h-[30px] items-center gap-2.5 rounded-sm px-2 font-medium transition-colors outline-none focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-45",
        active
          ? "bg-selected text-foreground"
          : "text-secondary-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {active && (
        <motion.span
          layoutId="nav-marker"
          transition={spring.snappy}
          className="bg-brand absolute top-[7px] bottom-[7px] -left-2 w-0.5 rounded-full"
        />
      )}
      <Icon className="size-[18px] flex-none" strokeWidth={1.6} aria-hidden />
      <motion.span
        animate={{ opacity: collapsed ? 0 : 1 }}
        transition={{ duration: 0.1 }}
        className="truncate"
      >
        {label}
      </motion.span>
      {crashes > 0 && !collapsed && (
        <Badge variant="error" className="ml-auto h-[18px] tabular-nums">
          {crashes}
        </Badge>
      )}
    </button>
  );
}

function TasksIndicator({ collapsed }: { collapsed: boolean }) {
  const { t } = useTranslation();
  const running = useTasks(
    useShallow((s) => s.tasks.filter((x) => x.status === "running")),
  );
  if (running.length === 0) return null;

  const known = running.filter((x) => x.progress !== null);
  const progress =
    known.length > 0
      ? known.reduce((sum, x) => sum + (x.progress ?? 0), 0) / known.length
      : null;
  const label = t("sidebar.tasks", { count: running.length });

  return (
    <div
      role="status"
      aria-label={label}
      className="bg-card text-small rounded-md border px-2.5 py-2"
    >
      <div className="flex items-center gap-2">
        <Loader className="text-brand size-3.5 animate-spin" aria-hidden />
        {!collapsed && <span className="flex-1 truncate">{label}</span>}
        {!collapsed && progress !== null && (
          <span className="text-muted-foreground tabular-nums">
            {Math.round(progress * 100)}%
          </span>
        )}
      </div>
      {!collapsed && (
        <div className="bg-selected mt-[7px] h-1 overflow-hidden rounded-full">
          <motion.div
            className="bg-primary h-full origin-left rounded-full"
            animate={{ scaleX: progress ?? 0.3 }}
            transition={spring.smooth}
          />
        </div>
      )}
    </div>
  );
}

function AdbFooter({
  collapsed,
  onToggle,
}: {
  collapsed: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const adb = useAdb((s) => s.adb);
  const serverDown = useDevices((s) => s.error !== null);
  const navigate = useNavigation((s) => s.navigate);
  const version = adb.status === "found" ? adb.install.version : null;

  return (
    <div
      className={cn(
        "text-muted-foreground text-small flex items-center gap-2 px-2",
        collapsed ? "h-auto flex-col" : "h-[30px]",
      )}
    >
      {!collapsed && (
        <>
          <StatusDot tone={serverDown ? "error" : "success"} />
          <span className="min-w-0 truncate">
            adb{" "}
            {version && (
              <span className="font-mono tabular-nums">
                {version.split("-")[0]}
              </span>
            )}{" "}
            · {serverDown ? t("sidebar.adbDown") : t("sidebar.adbRunning")}
          </span>
        </>
      )}
      <span className={cn("flex gap-0.5", !collapsed && "ml-auto")}>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={collapsed ? t("sidebar.expand") : t("sidebar.collapse")}
          onClick={onToggle}
        >
          <PanelLeft />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("sidebar.appSettings")}
          onClick={() => navigate("settings")}
        >
          <Settings />
        </Button>
      </span>
    </div>
  );
}
