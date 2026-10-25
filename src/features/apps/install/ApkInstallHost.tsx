import { useQueryClient } from "@tanstack/react-query";
import { Upload } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { create } from "zustand";
import { deviceName } from "@/features/devices/naming";
import { useDeviceInfo } from "@/features/devices/queries";
import { useSelectedDevice } from "@/features/devices/store";
import { fade, spring } from "@/lib/motion";
import { appsKey } from "../queries";
import { InstallDialog } from "./InstallDialog";
import { useInstall } from "./installStore";
import { useApkDrag } from "./openInstaller";
import { useApkDrop } from "./useApkDrop";

// Several hosts may be mounted (the Apps page and the app shell); only the
// first one renders, so there is exactly one dialog and one drop listener.
const useHosts = create<{ ids: number[] }>()(() => ({ ids: [] }));
let nextHost = 0;

function usePrimaryHost() {
  const [id] = useState(() => ++nextHost);
  useEffect(() => {
    useHosts.setState((s) => ({ ids: [...s.ids, id] }));
    return () =>
      useHosts.setState((s) => ({ ids: s.ids.filter((x) => x !== id) }));
  }, [id]);
  return useHosts((s) => s.ids[0] === id);
}

/**
 * Global APK install support: the install dialog, the window-wide drop
 * listener for `.apk/.apks/.xapk` and the "Drop to install" overlay.
 * Mount it once in the app shell; the Apps page mounts one as well and
 * the duplicates stay inert.
 */
export function ApkInstallHost() {
  const primary = usePrimaryHost();
  const client = useQueryClient();
  useApkDrop(primary);

  useEffect(() => {
    if (!primary) return;
    useInstall.setState({
      onInstalled: (serial) => {
        void client.invalidateQueries({ queryKey: appsKey(serial) });
        void client.invalidateQueries({ queryKey: ["app", serial] });
      },
    });
  }, [primary, client]);

  if (!primary) return null;
  return (
    <>
      <InstallDialog />
      <DropOverlay />
    </>
  );
}

function DropOverlay() {
  const { t } = useTranslation("apps");
  const dragging = useApkDrag((s) => s.dragging);
  const device = useSelectedDevice();
  const info = useDeviceInfo(
    device?.state.kind === "device" ? device.serial : null,
  );
  const target = device ? deviceName(device, info.data) : null;

  return (
    <AnimatePresence>
      {dragging && (
        <motion.div
          key="apk-drop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={fade}
          className="bg-background/70 pointer-events-none fixed inset-0 z-[60] flex items-center justify-center p-10"
        >
          <motion.div
            initial={{ scale: 0.96 }}
            animate={{ scale: 1 }}
            exit={{ scale: 0.96 }}
            transition={spring.bouncy}
            className="border-brand bg-brand/15 flex w-full max-w-[560px] flex-col items-center gap-2 rounded-xl border-[1.5px] border-dashed px-5 py-8 text-center"
          >
            <Upload className="text-brand size-7" aria-hidden />
            <div className="font-semibold">
              {target
                ? t("drop.title", { device: target })
                : t("drop.titleNoDevice")}
            </div>
            <div className="text-small text-secondary-foreground">
              {t("drop.hint")}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
