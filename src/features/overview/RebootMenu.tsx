import {
  Download,
  type LucideIcon,
  Power,
  PowerOff,
  RotateCcw,
  Wrench,
  Zap,
} from "lucide-react";
import { type ReactElement, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { type RebootTarget, rebootDevice } from "@/features/overview/api";
import { recordHistory } from "@/features/overview/history";
import type { AppError } from "@/lib/tauri";

const TARGETS: { target: RebootTarget; icon: LucideIcon }[] = [
  { target: "system", icon: RotateCcw },
  { target: "recovery", icon: Wrench },
  { target: "bootloader", icon: Zap },
  { target: "sideload", icon: Download },
];

/**
 * Reboot menu with confirmation. `trigger` is the menu trigger element
 * (rendered through Base UI's `render` prop); with `split` a primary
 * "Reboot" button sits next to it.
 */
export function RebootMenu({
  serial,
  deviceName,
  trigger,
  split = false,
  disabled = false,
}: {
  serial: string | null;
  deviceName: string;
  trigger: ReactElement;
  split?: boolean;
  disabled?: boolean;
}) {
  const { t } = useTranslation("overview");
  const [pending, setPending] = useState<RebootTarget | null>(null);
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    if (!serial || !pending) return;
    setBusy(true);
    try {
      await rebootDevice(serial, pending);
      recordHistory({ serial, kind: "reboot", label: t(`reboot.${pending}`) });
      toast.info(
        t(pending === "power_off" ? "reboot.poweringOff" : "reboot.started", {
          name: deviceName,
        }),
      );
      setPending(null);
    } catch (error) {
      toast.error(t("reboot.failed"), {
        description: (error as AppError).message ?? String(error),
      });
    } finally {
      setBusy(false);
    }
  };

  const menu = (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={trigger}
        disabled={disabled}
        aria-label={t("reboot.options")}
      />
      <DropdownMenuContent align="end" className="w-56">
        {TARGETS.map(({ target, icon: Icon }) => (
          <DropdownMenuItem key={target} onClick={() => setPending(target)}>
            <Icon />
            {t(`reboot.${target}`)}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onClick={() => setPending("power_off")}
        >
          <PowerOff />
          {t("reboot.power_off")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <>
      {split ? (
        <div className="inline-flex">
          <Button
            variant="outline"
            size="sm"
            className="rounded-r-none"
            disabled={disabled}
            onClick={() => setPending("system")}
          >
            <Power />
            {t("reboot.button")}
          </Button>
          {menu}
        </div>
      ) : (
        menu
      )}
      <AlertDialog
        open={pending !== null}
        onOpenChange={(open) => !open && !busy && setPending(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pending && t(`reboot.confirm.${pending}`, { name: deviceName })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pending === "power_off"
                ? t("reboot.bodyPowerOff")
                : t("reboot.body")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>
              {t("actions.cancel", { ns: "common" })}
            </AlertDialogCancel>
            <Button
              variant={pending === "power_off" ? "destructive" : "default"}
              disabled={busy}
              onClick={() => void confirm()}
            >
              {pending && t(`reboot.${pending}`)}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
