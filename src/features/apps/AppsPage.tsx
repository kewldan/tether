import { Smartphone, Upload } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { useNavigation } from "@/app/navigation";
import { Page } from "@/components/layout/Page";
import { Button } from "@/components/ui/button";
import { deviceName } from "@/features/devices/naming";
import { useDeviceInfo } from "@/features/devices/queries";
import { useReadySerial, useSelectedDevice } from "@/features/devices/store";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { AppDetailView } from "./detail/AppDetailView";
import { ApkInstallHost } from "./install/ApkInstallHost";
import { pickAndInstall } from "./install/openInstaller";
import { AppsList } from "./list/AppsList";
import { useApps, useMetaLoader, useVisibleApps } from "./queries";
import { useAppMeta } from "./store";
import { useAppActions, useConfirm } from "./useAppActions";

/** Apps (09 · Apps list) and app details (10 · App details). */
export default function AppsPage() {
  const { t } = useTranslation("apps");
  const { t: tc } = useTranslation();
  const device = useSelectedDevice();
  const serial = useReadySerial();
  const info = useDeviceInfo(serial);
  const name = device ? deviceName(device, info.data) : tc("sidebar.noDevice");
  const params = useNavigation((s) => s.params);
  const navigate = useNavigation((s) => s.navigate);
  const openPackage = params.package ?? null;

  const apps = useApps(serial);
  useMetaLoader(serial, apps.data);
  const meta = useAppMeta(serial);
  const { rows, counts } = useVisibleApps(apps.data, meta);
  const actions = useAppActions(serial, name);
  const confirm = useConfirm((s) => s.request);
  const ask = useConfirm((s) => s.ask);

  const installButton = (
    <Button size="sm" onClick={() => void pickAndInstall()}>
      <Upload />
      {t("install.button")}
    </Button>
  );

  let body: ReactNode;
  if (!serial || !actions) {
    body = (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <span className="bg-selected text-secondary-foreground flex size-10 items-center justify-center rounded-[10px]">
          <Smartphone className="size-5" aria-hidden />
        </span>
        <div className="font-semibold">
          {device ? t("noDevice.notReady", { name }) : t("noDevice.title")}
        </div>
        <div className="text-small text-secondary-foreground max-w-sm">
          {device ? tc(`state.${device.state.kind}`) : t("noDevice.body")}
        </div>
      </div>
    );
  } else if (openPackage) {
    return (
      <>
        <AppDetailView
          serial={serial}
          deviceName={name}
          pkg={openPackage}
          summary={apps.data?.find((a) => a.package === openPackage)}
          order={rows.map((r) => r.package)}
          meta={meta[openPackage]}
          actions={actions}
          onBack={() => navigate("apps")}
          onSelect={(pkg) => navigate("apps", { package: pkg })}
        />
        <ConfirmDialog request={confirm} onClose={() => ask(null)} />
        <ApkInstallHost />
      </>
    );
  } else {
    body = (
      <AppsList
        apps={apps.data}
        rows={rows}
        counts={counts}
        meta={meta}
        loading={apps.isPending}
        error={apps.error}
        onRetry={() => void apps.refetch()}
        onOpen={(pkg) => navigate("apps", { package: pkg })}
        actions={actions}
      />
    );
  }

  return (
    <Page
      title={tc("nav.apps")}
      parent={device ? { label: name } : undefined}
      actions={installButton}
      body="fill"
    >
      {body}
      <ConfirmDialog request={confirm} onClose={() => ask(null)} />
      <ApkInstallHost />
    </Page>
  );
}
