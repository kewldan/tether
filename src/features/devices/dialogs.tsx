import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useKnownDevices } from "@/features/devices/known";
import { CopyButton } from "@/features/onboarding/parts";
import type { Device } from "@/lib/tauri";

export const DEVICE_SETUP_URL =
  "https://developer.android.com/studio/run/device";

/** Local alias; empty clears it. Never changes anything on the device. */
export function RenameDialog({
  device,
  fallback,
  onClose,
}: {
  device: Device | null;
  fallback: string;
  onClose: () => void;
}) {
  const { t } = useTranslation("devices");
  const alias = useKnownDevices((s) =>
    device ? s.aliases[device.serial] : undefined,
  );
  const [name, setName] = useState("");
  useEffect(() => setName(alias ?? fallback), [alias, fallback]);

  const save = () => {
    if (device) useKnownDevices.getState().setAlias(device.serial, name);
    onClose();
  };

  return (
    <Dialog open={device !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("rename.title")}</DialogTitle>
          <DialogDescription>{t("rename.text")}</DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          value={name}
          placeholder={fallback}
          aria-label={t("rename.label")}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
        />
        <DialogFooter>
          {alias && (
            <Button
              variant="ghost"
              className="mr-auto"
              onClick={() => {
                if (device)
                  useKnownDevices.getState().setAlias(device.serial, null);
                onClose();
              }}
            >
              {t("rename.reset")}
            </Button>
          )}
          <Button variant="outline" onClick={onClose}>
            {t("common:actions.cancel")}
          </Button>
          <Button onClick={save}>{t("rename.save")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Copyable commands that install udev rules (Linux "no permissions"). */
export function UdevDialog({
  open,
  vendor,
  onClose,
}: {
  open: boolean;
  /** USB vendor id, e.g. `18d1`, if known. */
  vendor?: string | null;
  onClose: () => void;
}) {
  const { t } = useTranslation("devices");
  const id = vendor ?? "18d1";
  const rule = `SUBSYSTEM=="usb", ATTR{idVendor}=="${id}", MODE="0660", GROUP="plugdev", TAG+="uaccess"`;
  const commands = [
    {
      label: t("udev.package"),
      cmd: "sudo apt install android-sdk-platform-tools-common   # Debian/Ubuntu\nsudo dnf install android-tools   # Fedora\nsudo pacman -S android-udev   # Arch",
    },
    {
      label: t("udev.rule"),
      cmd: `echo '${rule}' | sudo tee /etc/udev/rules.d/51-android.rules\nsudo udevadm control --reload-rules && sudo udevadm trigger`,
    },
  ];
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>{t("udev.title")}</DialogTitle>
          <DialogDescription>{t("udev.text")}</DialogDescription>
        </DialogHeader>
        {commands.map((c) => (
          <div key={c.label} className="flex flex-col gap-1.5">
            <div className="text-small font-medium">{c.label}</div>
            <div className="bg-sidebar flex items-start gap-2 rounded-md border py-1.5 pr-1.5 pl-3">
              <pre className="selectable text-small min-w-0 flex-1 overflow-x-auto py-1 font-mono whitespace-pre">
                {c.cmd}
              </pre>
              <CopyButton text={c.cmd} label={t("common:actions.copy")} />
            </div>
          </div>
        ))}
        <p className="text-small text-secondary-foreground">
          {t("udev.replug")}
        </p>
        <DialogFooter>
          <Button
            variant="ghost"
            className="mr-auto"
            onClick={() => void openUrl(DEVICE_SETUP_URL)}
          >
            {t("learnMore")}
          </Button>
          <Button onClick={onClose}>{t("udev.done")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** How to reset the phone's list of trusted computers, then retry. */
export function RevokeDialog({
  open,
  onRetry,
  onClose,
}: {
  open: boolean;
  onRetry: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("devices");
  const b = { b: <b className="text-foreground font-semibold" /> };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>{t("revoke.title")}</DialogTitle>
          <DialogDescription>{t("revoke.text")}</DialogDescription>
        </DialogHeader>
        <ol className="text-secondary-foreground flex list-decimal flex-col gap-1.5 pl-5">
          <li>
            <Trans t={t} i18nKey="revoke.step1" components={b} />
          </li>
          <li>
            <Trans t={t} i18nKey="revoke.step2" components={b} />
          </li>
          <li>{t("revoke.step3")}</li>
        </ol>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("common:actions.cancel")}
          </Button>
          <Button
            onClick={() => {
              onRetry();
              onClose();
            }}
          >
            {t("card.retry")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
