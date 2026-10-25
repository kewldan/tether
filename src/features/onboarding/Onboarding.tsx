import { appDataDir, join } from "@tauri-apps/api/path";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { useNavigation } from "@/app/navigation";
import { useConnectSheet } from "@/features/devices/sheetStore";
import { type AdbScan, scanAdb, setAdbPath } from "@/features/onboarding/api";
import { DownloadScreen } from "@/features/onboarding/DownloadScreen";
import { NotFoundScreen } from "@/features/onboarding/NotFoundScreen";
import { PhoneGuide } from "@/features/onboarding/PhoneGuide";
import { SearchScreen } from "@/features/onboarding/SearchScreen";
import { pickFile } from "@/features/settings/pickers";
import { useAdb } from "@/lib/adb";
import { useSettings } from "@/lib/settings";
import type { AdbInstall, AppError } from "@/lib/tauri";

type Screen = "search" | "missing" | "download" | "phone";

/**
 * First-run flow: find adb (or download it), then prepare the phone.
 * `returning` users (onboarding done, adb went missing) only see the
 * "adb not found" part and go straight to the app afterwards.
 */
export function Onboarding({
  returning,
  onFinish,
}: {
  returning: boolean;
  onFinish: () => void;
}) {
  const { t } = useTranslation("onboarding");
  const setAdb = useAdb((s) => s.setAdb);
  const [screen, setScreen] = useState<Screen>(
    returning ? "missing" : "search",
  );
  const [scan, setScan] = useState<AdbScan | null>(null);
  const [installDir, setInstallDir] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);

  const rescan = useCallback((show: Screen = "search") => {
    setScan(null);
    setScreen(show);
    scanAdb()
      .then(setScan)
      .catch(() => setScan({ checks: [], install: null }));
  }, []);

  useEffect(() => {
    rescan(returning ? "missing" : "search");
    appDataDir()
      .then((dir) => join(dir, "platform-tools"))
      .then(setInstallDir)
      .catch(() => setInstallDir(null));
  }, [rescan, returning]);

  const proceed = useCallback(
    (install: AdbInstall) => {
      setAdb({ status: "found", install });
      if (returning) onFinish();
      else setScreen("phone");
    },
    [returning, onFinish, setAdb],
  );

  const onRevealed = useCallback(
    (result: AdbScan) => {
      if (result.install) return;
      setAdb({ status: "missing" });
      setTimeout(() => setScreen((s) => (s === "search" ? "missing" : s)), 500);
    },
    [setAdb],
  );

  // A returning user who installed adb meanwhile: "Check again" finds it.
  useEffect(() => {
    if (screen === "missing" && scan?.install) proceed(scan.install);
  }, [screen, scan, proceed]);

  const choosePath = async () => {
    setChoosing(true);
    try {
      const path = await pickFile(t("choosePathTitle"));
      if (!path) return;
      const install = await setAdbPath(path);
      useSettings.getState().update({ adbMode: "custom", adbCustomPath: path });
      proceed(install);
    } catch (e) {
      const error = e as AppError;
      toast.error(t("choosePathFailed"), { description: error.message });
    } finally {
      setChoosing(false);
    }
  };

  const onDownloadCancel = useCallback(() => setScreen("missing"), []);

  switch (screen) {
    case "search":
      return (
        <SearchScreen
          scan={scan}
          onRevealed={onRevealed}
          onContinue={() => scan?.install && proceed(scan.install)}
          onChooseOther={() => void choosePath()}
        />
      );
    case "missing":
      return (
        <NotFoundScreen
          scan={scan}
          installDir={installDir}
          returning={returning}
          choosing={choosing}
          onDownload={() => setScreen("download")}
          onRetry={() => rescan("missing")}
          onChoosePath={() => void choosePath()}
        />
      );
    case "download":
      return (
        <DownloadScreen
          onCancel={onDownloadCancel}
          nextLabel={returning ? t("download.open") : t("download.next")}
          onReady={(install) => {
            useSettings.getState().update({ adbMode: "bundled" });
            proceed(install);
          }}
        />
      );
    case "phone":
      return (
        <PhoneGuide
          onFinish={onFinish}
          onWifi={() => {
            onFinish();
            useConnectSheet.getState().show("qr");
          }}
          onDiagnose={() => {
            onFinish();
            useNavigation.getState().navigate("diagnostics");
          }}
        />
      );
  }
}
