import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { isMac } from "@/lib/platform";
import { useSettings } from "@/lib/settings";

import { ensurePermission, sendSystem } from "./notify";

/** Same shape as a Settings page row. */
interface SettingsRow {
  id: string;
  title: string;
  desc?: ReactNode;
  keywords?: string;
  control: ReactNode;
}

/** "Notifications & menu bar" section of the Settings page. */
export function useNotificationSettings(): {
  title: string;
  rows: SettingsRow[];
} {
  const { t } = useTranslation("notifications");
  const s = useSettings();
  const mac = (key: string) => t(isMac ? `${key}Mac` : key);

  const denied = () =>
    toast.error(t("settings.system.denied"), {
      description: t("settings.system.deniedHint"),
    });

  const setSystem = async (on: boolean) => {
    if (on && !(await ensurePermission(true))) {
      denied();
      return;
    }
    s.update({ systemNotifications: on });
  };

  const test = async () => {
    const sent = await sendSystem({
      title: t("settings.system.testTitle"),
      body: t("settings.system.testBody"),
    });
    if (!sent) denied();
  };

  const toggle = (
    label: string,
    checked: boolean,
    onChange: (on: boolean) => void,
    disabled = false,
  ) => (
    <Switch
      aria-label={label}
      checked={checked}
      disabled={disabled}
      onCheckedChange={onChange}
    />
  );

  return {
    title: t(isMac ? "settings.titleMenuBar" : "settings.titleTray"),
    rows: [
      {
        id: "notify-devices",
        title: t("settings.devices.title"),
        desc: t("settings.devices.desc"),
        control: toggle(t("settings.devices.title"), s.notifyDevices, (on) =>
          s.update({ notifyDevices: on }),
        ),
      },
      {
        id: "notify-crashes",
        title: t("settings.crashes.title"),
        desc: t("settings.crashes.desc"),
        keywords: "logcat ANR",
        control: toggle(t("settings.crashes.title"), s.notifyCrashes, (on) =>
          s.update({ notifyCrashes: on }),
        ),
      },
      {
        id: "notify-system",
        title: t("settings.system.title"),
        desc: t("settings.system.desc"),
        control: (
          <>
            <Button
              size="sm"
              variant="ghost"
              disabled={!s.systemNotifications}
              onClick={() => void test()}
            >
              {t("settings.system.test")}
            </Button>
            {toggle(
              t("settings.system.title"),
              s.systemNotifications,
              (on) => void setSystem(on),
            )}
          </>
        ),
      },
      {
        id: "tray-icon",
        title: mac("settings.tray.title"),
        desc: t("settings.tray.desc"),
        keywords: "tray menu bar",
        control: toggle(mac("settings.tray.title"), s.trayIcon, (on) =>
          s.update({ trayIcon: on }),
        ),
      },
      {
        id: "close-to-tray",
        title: mac("settings.close.title"),
        desc: s.trayIcon
          ? mac("settings.close.desc")
          : t("settings.close.needsIcon"),
        keywords: "tray menu bar hide quit",
        control: toggle(
          mac("settings.close.title"),
          s.trayIcon && s.closeToTray,
          (on) => s.update({ closeToTray: on }),
          !s.trayIcon,
        ),
      },
    ],
  };
}
