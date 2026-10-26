import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import type { DevSettings } from "@/features/device-settings/api";
import {
  applyProfile,
  type DevProfile,
  profileName,
  revertProfile,
} from "@/features/device-settings/profiles";
import type { AppError, Transport } from "@/lib/tauri";

const errorText = (e: unknown) =>
  (e as Partial<AppError>)?.message ?? String(e);

/** Apply / revert a profile on the selected device, with toasts. */
export function useProfileActions(
  serial: string | null,
  transport: Transport,
  settings: DevSettings | undefined,
) {
  const { t } = useTranslation("device-settings");
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const setSettings = (next: DevSettings) =>
    queryClient.setQueryData(["dev-settings", serial], next);

  const revert = async (profile: DevProfile, current = settings) => {
    if (!serial || !current) return;
    setBusy(profile.id);
    try {
      setSettings(await revertProfile(serial, profile, current));
      toast.success(t("profiles.reverted", { name: profileName(profile, t) }));
    } catch (error) {
      toast.error(t("applyFailed"), { description: errorText(error) });
    } finally {
      setBusy(null);
    }
  };

  const apply = async (profile: DevProfile) => {
    if (!serial || !settings) return;
    setBusy(profile.id);
    try {
      const result = await applyProfile(serial, transport, profile, settings);
      setSettings(result.settings);
      const name = profileName(profile, t);
      if (result.failed.length > 0) {
        toast.error(t("profiles.partly", { name }), {
          description: result.failed
            .map((f) => `${f.key}: ${f.message}`)
            .join("\n"),
        });
      } else {
        toast.success(t("profiles.applied", { name }), {
          description:
            result.skipped.length > 0
              ? t("profiles.skipped", { count: result.skipped.length })
              : undefined,
          action:
            result.applied.length > 0
              ? {
                  label: t("profiles.undo"),
                  onClick: () => void revert(profile, result.settings),
                }
              : undefined,
        });
      }
    } catch (error) {
      toast.error(t("applyFailed"), { description: errorText(error) });
    } finally {
      setBusy(null);
    }
  };

  return { apply, revert, busy };
}
