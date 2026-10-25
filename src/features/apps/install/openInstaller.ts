import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { create } from "zustand";

import { useDevices } from "@/features/devices/store";
import i18n from "@/lib/i18n";
import { isPackageFile, PACKAGE_EXTENSIONS } from "../api";
import { errorMessage } from "../queries";
import { useInstall } from "./installStore";

/** The selected device if it is ready; installs default to it. */
function defaultSerials(): string[] {
  const { devices, selectedSerial } = useDevices.getState();
  const selected = devices.find(
    (d) => d.serial === selectedSerial && d.state.kind === "device",
  );
  return selected ? [selected.serial] : [];
}

/** Opens the install dialog for `paths` (first package file wins). */
export function openInstallerWith(paths: string[]) {
  const packages = paths.filter(isPackageFile);
  if (packages.length === 0) {
    toast.error(i18n.t("apps:install.notPackage"));
    return;
  }
  if (packages.length > 1) {
    toast.info(i18n.t("apps:install.oneAtATime"));
  }
  useInstall.getState().openWith(packages[0], defaultSerials());
}

/** "Install APK…": file picker, then the install dialog. */
export async function pickAndInstall() {
  try {
    const picked = await openDialog({
      multiple: false,
      directory: false,
      title: i18n.t("apps:install.pickTitle"),
      filters: [
        {
          name: i18n.t("apps:install.filterName"),
          extensions: PACKAGE_EXTENSIONS,
        },
      ],
    });
    if (typeof picked === "string") openInstallerWith([picked]);
  } catch (error) {
    toast.error(errorMessage(error));
  }
}

/** Whether package files are being dragged over the window. */
export const useApkDrag = create<{
  dragging: boolean;
  set: (dragging: boolean) => void;
}>()((set) => ({ dragging: false, set: (dragging) => set({ dragging }) }));
