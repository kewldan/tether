import {
  Camera,
  CircleDot,
  Copy,
  MonitorSmartphone,
  Plug,
  Power,
  Square,
  SquareTerminal,
  Upload,
  Wifi,
} from "lucide-react";
import {
  type ComponentProps,
  forwardRef,
  type ReactNode,
  useEffect,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useNavigation } from "@/app/navigation";
import { deviceTone, StatusDot } from "@/components/status/StatusDot";
import { Badge } from "@/components/ui/badge";
import type { DeviceSnapshot } from "@/features/overview/api";
import { useCaptureActions } from "@/features/overview/captureActions";
import { formatClock } from "@/features/overview/format";
import { RebootMenu } from "@/features/overview/RebootMenu";
import type { Device, DeviceInfo } from "@/lib/tauri";
import { cn } from "@/lib/utils";

const QuickAction = forwardRef<
  HTMLButtonElement,
  ComponentProps<"button"> & {
    icon: ReactNode;
    highlight?: boolean;
  }
>(function QuickAction(
  { icon, highlight, className, children, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      className={cn(
        "bg-card text-small hover:bg-accent focus-visible:outline-ring flex h-16 min-w-0 flex-col items-center justify-center gap-1.5 rounded-[9px] border px-2 font-medium outline-none focus-visible:outline-2 focus-visible:outline-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-[18px]",
        highlight
          ? "border-brand bg-brand/15 [&_svg]:text-brand"
          : "[&_svg]:text-secondary-foreground",
        className,
      )}
      {...props}
    >
      {icon}
      <span className="max-w-full truncate">{children}</span>
    </button>
  );
});

function useTicker(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

export function DeviceHeaderCard({
  device,
  name,
  info,
  snapshot,
  ready,
}: {
  device: Device;
  name: string;
  info: DeviceInfo | undefined;
  snapshot: DeviceSnapshot | undefined;
  ready: boolean;
}) {
  const { t } = useTranslation("overview");
  const { t: tc } = useTranslation();
  const navigate = useNavigation((s) => s.navigate);
  const serial = ready ? device.serial : null;
  const { screenshot, shooting, recording, toggleRecording } =
    useCaptureActions(serial, name);
  const now = useTicker(recording !== null);

  const facts = snapshot?.info ?? info;
  const subtitle = [
    facts?.manufacturer,
    snapshot?.build.device ?? device.device,
    snapshot?.build.soc,
  ]
    .filter(Boolean)
    .join(" · ");
  const TransportIcon = device.transport === "wifi" ? Wifi : Plug;

  const copySerial = () => {
    void navigator.clipboard
      .writeText(device.serial)
      .then(() => toast.success(t("serialCopied")));
  };

  return (
    <section className="bg-card flex flex-wrap items-center gap-[22px] rounded-lg border p-[18px]">
      <div
        aria-hidden
        className="ring-input h-[132px] w-[70px] flex-none rounded-2xl bg-black p-1 ring-1"
      >
        <div className="from-primary/50 via-primary to-brand relative h-full rounded-xl bg-linear-160">
          <span className="absolute top-[5px] left-1/2 size-1.5 -translate-x-1/2 rounded-full bg-black" />
        </div>
      </div>

      <div className="flex min-w-0 flex-[1_1_360px] flex-col gap-2">
        <div className="flex items-center gap-2.5">
          <h1 className="text-[22px] leading-7 font-semibold tracking-[-.01em]">
            {name}
          </h1>
          <Badge
            variant={
              deviceTone(device.state) === "success" ? "success" : "warning"
            }
          >
            <StatusDot tone={deviceTone(device.state)} />
            {tc(`state.${device.state.kind}`)}
          </Badge>
        </div>
        {subtitle && (
          <div className="text-secondary-foreground">{subtitle}</div>
        )}
        <div className="flex flex-wrap gap-1.5">
          <Badge
            render={<button type="button" />}
            className="cursor-pointer font-mono"
            onClick={copySerial}
            aria-label={t("copySerial")}
          >
            {device.serial}
            <Copy aria-hidden />
          </Badge>
          {facts?.androidVersion && (
            <Badge>
              {facts.sdk
                ? `Android ${facts.androidVersion} · SDK ${facts.sdk}`
                : `Android ${facts.androidVersion}`}
            </Badge>
          )}
          {facts?.securityPatch && (
            <Badge>{t("patch", { date: facts.securityPatch })}</Badge>
          )}
          <Badge>
            <TransportIcon aria-hidden />
            {tc(`transport.${device.transport}`)}
          </Badge>
          {snapshot && <Badge>{t(`root.${snapshot.root}`)}</Badge>}
        </div>
        {facts?.fingerprint && (
          <details className="text-small">
            <summary className="text-muted-foreground w-fit cursor-pointer">
              {t("fingerprint")}
            </summary>
            <div className="selectable text-secondary-foreground mt-1 font-mono text-[11px] break-all">
              {facts.fingerprint}
            </div>
          </details>
        )}
      </div>

      <div className="grid grid-cols-3 gap-2 sm:[grid-template-columns:repeat(6,84px)] sm:grid-cols-6">
        <QuickAction
          icon={<Camera />}
          disabled={!ready || shooting}
          onClick={() => void screenshot()}
        >
          {t("actions.screenshot")}
        </QuickAction>
        <QuickAction
          icon={
            recording ? (
              <Square className="fill-error text-error!" />
            ) : (
              <CircleDot />
            )
          }
          disabled={!ready || recording?.stopping}
          aria-pressed={recording !== null}
          onClick={() => void toggleRecording()}
          className={recording ? "border-error/60" : undefined}
        >
          {recording
            ? recording.stopping
              ? t("actions.stopping")
              : t("actions.stop", {
                  time: formatClock(now - recording.startedAt),
                })
            : t("actions.record")}
        </QuickAction>
        <QuickAction
          icon={<MonitorSmartphone />}
          highlight
          disabled={!ready}
          onClick={() => navigate("screen")}
        >
          {t("actions.mirror")}
        </QuickAction>
        <QuickAction
          icon={<Upload />}
          disabled={!ready}
          onClick={() => navigate("apps", { install: "1" })}
        >
          {t("actions.installApk")}
        </QuickAction>
        <QuickAction
          icon={<SquareTerminal />}
          disabled={!ready}
          onClick={() => navigate("shell")}
        >
          {t("actions.shell")}
        </QuickAction>
        <RebootMenu
          serial={serial}
          deviceName={name}
          disabled={!ready}
          trigger={
            <QuickAction icon={<Power />}>{t("actions.reboot")} ▾</QuickAction>
          }
        />
      </div>
    </section>
  );
}
