import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Switch } from "@/components/ui/switch";
import type { SettingsRow } from "@/features/settings/rows";
import { isMac } from "@/lib/platform";
import { useSettings } from "@/lib/settings";

const QUERY_KEY = ["autostart-enabled"];

/**
 * Settings › General: "Open at login" (the OS login item is the source of
 * truth) and "Start hidden in the menu bar", which needs the tray icon.
 */
export function useLoginRows(): SettingsRow[] {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
  const trayIcon = useSettings((s) => s.trayIcon);
  const startHidden = useSettings((s) => s.startHidden);
  const update = useSettings((s) => s.update);
  const { data: enabled = false, isPending } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: isEnabled,
    staleTime: Number.POSITIVE_INFINITY,
  });

  const toggle = (on: boolean) => {
    queryClient.setQueryData(QUERY_KEY, on);
    (on ? enable() : disable())
      .catch((e: unknown) => {
        toast.error(t("general.login.failed"), { description: String(e) });
      })
      .finally(
        () => void queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
      );
  };

  const where = isMac ? "menuBar" : "tray";
  return [
    {
      id: "login",
      title: t("general.login.title"),
      desc: t("general.login.desc"),
      keywords: "autostart startup launch boot",
      control: (
        <Switch
          aria-label={t("general.login.title")}
          checked={enabled}
          disabled={isPending}
          onCheckedChange={toggle}
        />
      ),
    },
    {
      id: "start-hidden",
      title: t(`general.hidden.title.${where}`),
      desc: trayIcon
        ? t("general.hidden.desc")
        : t(`general.hidden.needsTray.${where}`),
      keywords: "minimized tray menu bar autostart",
      control: (
        <Switch
          aria-label={t(`general.hidden.title.${where}`)}
          checked={enabled && trayIcon && startHidden}
          disabled={!enabled || !trayIcon}
          onCheckedChange={(on) => update({ startHidden: on })}
        />
      ),
    },
  ];
}

/**
 * A login launch starts with the window hidden; show it unless the user
 * wants Tether to wait in the tray. Mounted once by the app root.
 */
export function useLoginLaunch() {
  useEffect(() => {
    const { startHidden, trayIcon, onboardingDone } = useSettings.getState();
    void invoke<boolean>("login_launch_settle", {
      stayHidden: startHidden && trayIcon && onboardingDone,
    }).catch(() => {});
  }, []);
}
