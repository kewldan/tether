import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { useUpdater } from "@/features/updater/store";

const FIRST_CHECK_DELAY = 5_000;
const CHECK_INTERVAL = 6 * 60 * 60_000;
const TOAST_ID = "tether-update";

/**
 * Checks for updates shortly after launch and every few hours, and offers
 * the update in a persistent toast. Only runs in packaged builds inside
 * Tauri — dev builds and the browser preview never check.
 */
export function UpdateNotifier() {
  const { t } = useTranslation("updater");
  const status = useUpdater((s) => s.status);
  const version = useUpdater((s) => s.version);
  const progress = useUpdater((s) => s.progress);

  useEffect(() => {
    if (!import.meta.env.PROD || !("__TAURI_INTERNALS__" in window)) return;
    const run = () => void useUpdater.getState().check();
    const first = setTimeout(run, FIRST_CHECK_DELAY);
    const interval = setInterval(run, CHECK_INTERVAL);
    return () => {
      clearTimeout(first);
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (status === "available" && version) {
      toast(t("available", { version }), {
        id: TOAST_ID,
        description: t("availableHint"),
        duration: Number.POSITIVE_INFINITY,
        action: {
          label: t("install"),
          onClick: () => void useUpdater.getState().install(),
        },
      });
    } else if (status === "downloading") {
      const percent = progress === null ? null : Math.round(progress * 100);
      toast.loading(
        percent === null
          ? t("downloading")
          : t("downloadingPercent", { percent }),
        { id: TOAST_ID, duration: Number.POSITIVE_INFINITY },
      );
    } else if (status === "ready") {
      toast.success(t("restarting"), { id: TOAST_ID });
    } else if (
      status === "error" &&
      toast.getToasts().some((x) => x.id === TOAST_ID)
    ) {
      toast.error(t("failed"), { id: TOAST_ID, duration: 8_000 });
    }
  }, [status, version, progress, t]);

  return null;
}
