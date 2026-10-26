import { openUrl } from "@tauri-apps/plugin-opener";
import { Copy, Download, X } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  type UpdateCommand,
  updateHow,
  usePlatformToolsUpdate,
} from "@/features/settings/platformTools";
import { useSettings } from "@/lib/settings";

const RELEASE_NOTES =
  "https://developer.android.com/tools/releases/platform-tools";

function CommandLine({ via, command }: UpdateCommand) {
  const { t } = useTranslation("settings");
  return (
    <div className="flex items-center gap-2">
      <span className="text-small text-muted-foreground w-[64px] flex-none">
        {via}
      </span>
      <code className="text-caption bg-background selectable min-w-0 flex-1 truncate rounded-sm border px-2 py-1 font-mono">
        {command}
      </code>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={t("adb.latest.copy")}
        title={t("adb.latest.copy")}
        onClick={() =>
          void navigator.clipboard
            .writeText(command)
            .then(() => toast.success(t("common:actions.copied")))
        }
      >
        <Copy />
      </Button>
    </div>
  );
}

/**
 * Settings › adb: "platform-tools X is available (you have Y)". Tether's
 * own copy updates in place through the license dialog (`onUpdate`); for
 * a system adb it says how to update it where it came from.
 */
export function PlatformToolsNotice({
  onUpdate,
  busy,
}: {
  onUpdate: () => void;
  busy: boolean;
}) {
  const { t } = useTranslation("settings");
  const { install, latest, unseen } = usePlatformToolsUpdate();
  if (!unseen || !install || !latest) return null;
  const how = updateHow(install);
  const current = install.version?.split("-")[0] ?? "?";
  const mono = <span className="font-mono tabular-nums" />;

  return (
    <div className="bg-info/13 mt-2 mb-1.5 flex flex-col gap-2 rounded-md px-3 py-2.5">
      <div className="flex items-center gap-2.5">
        <Download className="text-info size-4 flex-none" aria-hidden />
        <span className="min-w-0 flex-1">
          <Trans
            t={t}
            i18nKey="adb.latest.available"
            values={{ latest, current }}
            components={{ v: mono }}
          />
        </span>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void openUrl(RELEASE_NOTES)}
        >
          {t("adb.latest.notes")}
        </Button>
        {how.kind === "bundled" && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={onUpdate}
          >
            {t("adb.update.update")}
          </Button>
        )}
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={t("adb.latest.dismiss")}
          title={t("adb.latest.dismiss")}
          onClick={() =>
            useSettings.getState().update({ platformToolsDismissed: latest })
          }
        >
          <X />
        </Button>
      </div>
      {how.kind !== "bundled" && (
        <div className="text-small text-secondary-foreground flex flex-col gap-1.5 pl-[26px]">
          <span>{t(`adb.latest.how.${how.kind}`)}</span>
          {how.kind === "commands" &&
            how.commands.map((c) => <CommandLine key={c.via} {...c} />)}
        </div>
      )}
    </div>
  );
}
