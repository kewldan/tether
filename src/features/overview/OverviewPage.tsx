import { cn } from "cn";
import { ChevronDown, Copy, Smartphone } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { useNavigation } from "@/app/navigation";
import { Page } from "@/components/layout/Page";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { deviceName } from "@/features/devices/naming";
import { useDeviceInfo } from "@/features/devices/queries";
import { useSelectedDevice } from "@/features/devices/store";
import { DeviceHeaderCard } from "@/features/overview/DeviceHeaderCard";
import { deviceMarkdown } from "@/features/overview/deviceMarkdown";
import {
  BatteryCard,
  CpuCard,
  DisplayCard,
  MemoryCard,
  NetworkCard,
  StorageCard,
  UptimeCard,
} from "@/features/overview/MetricCards";
import { RebootMenu } from "@/features/overview/RebootMenu";
import { RecentCard } from "@/features/overview/RecentCard";
import { useDeviceSnapshot } from "@/features/overview/useDeviceSnapshot";
import type { AppError } from "@/lib/tauri";

export default function OverviewPage() {
  const { t } = useTranslation("overview");
  const { t: tc } = useTranslation();
  const navigate = useNavigation((s) => s.navigate);
  const device = useSelectedDevice();
  const ready = device?.state.kind === "device";
  const { data: info } = useDeviceInfo(ready ? device.serial : null);
  const {
    data: snapshot,
    error,
    isPending,
  } = useDeviceSnapshot(device?.serial ?? null, { live: ready });

  if (!device) {
    return (
      <Page title={tc("nav.overview")}>
        <EmptyState
          title={t("noDevice.title")}
          body={t("noDevice.body")}
          action={
            <Button variant="outline" onClick={() => navigate("devices")}>
              {t("noDevice.devices")}
            </Button>
          }
        />
      </Page>
    );
  }

  const name = deviceName(device, snapshot?.info ?? info);
  const offline = !ready;

  const copyInfo = () => {
    if (!snapshot) return;
    void navigator.clipboard
      .writeText(deviceMarkdown(device, name, snapshot, tc))
      .then(() => toast.success(t("infoCopied")));
  };

  const actions = (
    <>
      <Button variant="ghost" size="sm" disabled={!snapshot} onClick={copyInfo}>
        <Copy />
        {t("copyInfo")}
      </Button>
      <RebootMenu
        serial={ready ? device.serial : null}
        deviceName={name}
        split
        disabled={!ready}
        trigger={
          <Button
            variant="outline"
            size="icon-sm"
            className="rounded-l-none border-l-0"
          >
            <ChevronDown />
          </Button>
        }
      />
    </>
  );

  if (offline && !snapshot) {
    return (
      <Page
        title={tc("nav.overview")}
        parent={{ label: name }}
        actions={actions}
      >
        <EmptyState
          title={t("notReady.title", { name })}
          body={t("notReady.body", {
            state: tc(`state.${device.state.kind}`).toLowerCase(),
          })}
          action={
            <Button variant="outline" onClick={() => navigate("diagnostics")}>
              {t("notReady.cantSee")}
            </Button>
          }
        />
      </Page>
    );
  }

  return (
    <Page
      title={tc("nav.overview")}
      parent={{ label: name }}
      actions={actions}
      body="fill"
    >
      {offline && snapshot && (
        <div
          role="status"
          className="bg-error/13 flex flex-none items-center gap-3 border-b px-5 py-2.5"
        >
          <span
            aria-hidden
            className="bg-error size-2.5 flex-none rounded-full"
          />
          <p className="min-w-0 flex-1">
            <span className="font-semibold">
              {t("disconnected.title", { name })}
            </span>
            <span className="text-secondary-foreground">
              {t("disconnected.body", {
                time: new Date(snapshot.takenAt).toLocaleTimeString(),
              })}
            </span>
          </p>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate("diagnostics")}
          >
            {t("disconnected.cantSee")}
          </Button>
        </div>
      )}
      <div
        aria-hidden={offline || undefined}
        className={cn(
          "flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-5",
          offline && "pointer-events-none opacity-50 saturate-[.2]",
        )}
      >
        <DeviceHeaderCard
          device={device}
          name={name}
          info={info}
          snapshot={snapshot}
          ready={ready}
        />
        {error && !snapshot ? (
          <div className="bg-error/13 rounded-lg border px-4 py-3">
            <div className="font-semibold">{t("loadFailed")}</div>
            <div className="text-secondary-foreground text-small">
              {(error as unknown as AppError).message ?? String(error)}
            </div>
          </div>
        ) : isPending || !snapshot ? (
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            {Array.from({ length: 8 }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: placeholders
              <Skeleton key={i} className="h-[178px] rounded-lg" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <BatteryCard serial={device.serial} snapshot={snapshot} />
            <StorageCard snapshot={snapshot} />
            <MemoryCard serial={device.serial} snapshot={snapshot} />
            <CpuCard snapshot={snapshot} />
            <DisplayCard snapshot={snapshot} />
            <NetworkCard snapshot={snapshot} />
            <UptimeCard snapshot={snapshot} />
            <RecentCard serial={device.serial} deviceName={name} />
          </div>
        )}
      </div>
    </Page>
  );
}

function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
      <Smartphone className="text-muted-foreground size-8" aria-hidden />
      <div className="text-section font-semibold">{title}</div>
      <p className="text-muted-foreground max-w-sm">{body}</p>
      {action}
    </div>
  );
}
