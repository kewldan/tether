import { Copy, LayoutGrid, Loader, MoreHorizontal } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { useNavigation } from "@/app/navigation";
import { Page } from "@/components/layout/Page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import type { DevKey, DevSettings } from "@/features/device-settings/api";
import { useOriginals } from "@/features/device-settings/originals";
import {
  ProfileTile,
  RenameProfileDialog,
  SaveProfileDialog,
} from "@/features/device-settings/ProfileParts";
import {
  BUILTIN_PROFILES,
  canRevert,
  type DevProfile,
  describeProfile,
  isApplied,
  profileName,
  useProfiles,
} from "@/features/device-settings/profiles";
import { useProfileActions } from "@/features/device-settings/useProfileActions";
import { useDeviceName } from "@/features/devices/naming";
import { deviceMarkdown } from "@/features/overview/deviceMarkdown";
import { useDeviceSnapshot } from "@/features/overview/useDeviceSnapshot";
import type { Device } from "@/lib/tauri";

/** P2 · Profiles: saved sets of developer toggles, plus "About device". */
export function ProfilesView({
  device,
  settings,
  modified,
}: {
  device: Device;
  settings: DevSettings | undefined;
  modified: DevKey[];
}) {
  const { t } = useTranslation("device-settings");
  const { t: tc } = useTranslation();
  const navigate = useNavigation((s) => s.navigate);
  const profiles = useProfiles((s) => s.profiles);
  const restoreBuiltins = useProfiles((s) => s.restoreBuiltins);
  const originals = useOriginals((s) => s.bySerial[device.serial]);
  const [saving, setSaving] = useState(false);
  const [renaming, setRenaming] = useState<DevProfile | null>(null);
  const { apply, revert, busy } = useProfileActions(
    device.serial,
    device.transport,
    settings,
  );
  const missingBuiltins = BUILTIN_PROFILES.some(
    (b) => !profiles.some((p) => p.id === b.id),
  );

  const remove = (profile: DevProfile) => {
    const index = useProfiles.getState().profiles.indexOf(profile);
    useProfiles.getState().remove(profile.id);
    toast(t("profiles.deleted", { name: profileName(profile, t) }), {
      action: {
        label: t("profiles.undo"),
        onClick: () =>
          useProfiles.setState((s) => {
            const next = s.profiles.slice();
            next.splice(Math.max(0, index), 0, profile);
            return { profiles: next };
          }),
      },
    });
  };

  return (
    <Page
      title={t("profiles.title")}
      parent={{
        label: tc("nav.device-settings"),
        onClick: () => navigate("device-settings"),
      }}
      actions={
        <Button
          variant="outline"
          size="sm"
          disabled={!settings}
          onClick={() => setSaving(true)}
        >
          {t("profiles.saveCurrent")}
        </Button>
      }
      className="px-5 py-4"
    >
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
        <section className="bg-card overflow-hidden rounded-[10px] border">
          <div className="flex items-center justify-between gap-3 px-3.5 py-3">
            <h2 className="font-semibold">{t("profiles.listTitle")}</h2>
            <button
              type="button"
              className="text-small text-muted-foreground hover:text-foreground flex items-center gap-1.5"
              onClick={() => navigate("multi-device")}
            >
              <LayoutGrid className="size-3.5" aria-hidden />
              {t("profiles.manyDevices")}
            </button>
          </div>
          {profiles.length === 0 && (
            <p className="text-muted-foreground text-small border-t px-3.5 py-6 text-center">
              {t("profiles.empty")}
            </p>
          )}
          {profiles.map((p) => {
            const applied = isApplied(p, settings);
            return (
              <div
                key={p.id}
                className="flex items-start gap-3 border-t px-3.5 py-3"
              >
                <ProfileTile profile={p} applied={applied} />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">
                    {profileName(p, t)}
                  </div>
                  <div className="text-small text-muted-foreground leading-[18px]">
                    {describeProfile(p, t)}
                  </div>
                </div>
                <div className="flex flex-none items-center gap-1.5">
                  {busy === p.id && (
                    <Loader className="text-muted-foreground size-3.5 animate-spin" />
                  )}
                  {applied && (
                    <Badge variant="success">{t("profiles.on")}</Badge>
                  )}
                  {applied && !canRevert(p, originals) ? null : applied ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy !== null}
                      onClick={() => void revert(p)}
                    >
                      {t("profiles.revert")}
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy !== null || !settings}
                      onClick={() => void apply(p)}
                    >
                      {t("profiles.apply")}
                    </Button>
                  )}
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={<Button variant="ghost" size="icon-sm" />}
                      aria-label={t("profiles.more", {
                        name: profileName(p, t),
                      })}
                    >
                      <MoreHorizontal />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-40">
                      <DropdownMenuItem onClick={() => setRenaming(p)}>
                        {t("profiles.rename")}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={() => remove(p)}
                      >
                        {t("profiles.delete")}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            );
          })}
          {missingBuiltins && (
            <div className="border-t px-3.5 py-2">
              <Button size="xs" variant="ghost" onClick={restoreBuiltins}>
                {t("profiles.restoreBuiltins")}
              </Button>
            </div>
          )}
        </section>
        <AboutCard device={device} />
      </div>
      <SaveProfileDialog
        open={saving}
        settings={settings}
        suggested={modified}
        onClose={() => setSaving(false)}
      />
      <RenameProfileDialog
        profile={renaming}
        onClose={() => setRenaming(null)}
      />
    </Page>
  );
}

/** Overview's "Copy device info" Markdown, shown before copying. */
function AboutCard({ device }: { device: Device }) {
  const { t } = useTranslation("device-settings");
  const { t: tc } = useTranslation();
  const { data: snapshot } = useDeviceSnapshot(device.serial);
  const name = useDeviceName(device, snapshot?.info) ?? device.serial;
  const text = snapshot ? deviceMarkdown(device, name, snapshot, tc) : null;
  return (
    <section className="bg-card overflow-hidden rounded-[10px] border">
      <div className="flex items-center justify-between gap-3 border-b px-3.5 py-3">
        <h2 className="font-semibold">{t("about.title")}</h2>
        <Button
          size="sm"
          disabled={!text}
          onClick={() =>
            text &&
            void navigator.clipboard
              .writeText(text)
              .then(() => toast.success(t("about.copied")))
          }
        >
          <Copy />
          {tc("actions.copy")}
        </Button>
      </div>
      {text ? (
        <pre className="selectable text-secondary-foreground p-3.5 font-mono text-[12px] leading-[19px] whitespace-pre-wrap">
          {text}
        </pre>
      ) : (
        <div className="flex flex-col gap-2 p-3.5">
          {Array.from({ length: 6 }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: placeholders
            <Skeleton key={i} className="h-3.5 w-3/4" />
          ))}
        </div>
      )}
    </section>
  );
}
