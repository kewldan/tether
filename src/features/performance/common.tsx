/**
 * Small pieces shared by the Shell, Ports, Intents and Performance pages:
 * the segmented control, the "needs a device" state, the breadcrumb
 * parent and the Tether text-field look.
 */
import { cn } from "cn";
import { ChevronRight, Smartphone } from "lucide-react";
import { motion } from "motion/react";
import { type ReactNode, useId } from "react";
import { useTranslation } from "react-i18next";

import { useNavigation } from "@/app/navigation";
import { Page } from "@/components/layout/Page";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { deviceName } from "@/features/devices/naming";
import { useDeviceInfo } from "@/features/devices/queries";
import { useSelectedDevice } from "@/features/devices/store";
import { spring } from "@/lib/motion";

/** Tether text field (Components board: 30 px, radius 7, `--border2`). */
export const fieldClass =
  "border-input bg-background dark:bg-background text-body placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/25 aria-invalid:border-error aria-invalid:ring-error/20 h-[30px] rounded-[7px] px-2.5 md:text-body";

/** Same field in the mono font, for ports, URIs and commands. */
export const monoFieldClass = cn(
  fieldClass,
  "text-small md:text-small font-mono",
);

/** Segmented control with a sliding thumb (snappy shared layout). */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  className,
}: {
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (value: T) => void;
  label: string;
  className?: string;
}) {
  const id = useId();
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn(
        "bg-selected inline-flex flex-none gap-0.5 rounded-md p-0.5",
        className,
      )}
    >
      {options.map((option) => {
        const on = option.value === value;
        return (
          // biome-ignore lint/a11y/useSemanticElements: segmented control, styled buttons with radio semantics
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(option.value)}
            className={cn(
              "text-small focus-visible:outline-ring relative inline-flex h-6 items-center gap-1.5 rounded-sm px-2.5 font-medium whitespace-nowrap outline-none focus-visible:outline-2",
              on
                ? "text-foreground"
                : "text-secondary-foreground hover:text-foreground",
            )}
          >
            {on && (
              <motion.span
                layoutId={`seg-${id}`}
                transition={spring.snappy}
                className="bg-card absolute inset-0 rounded-sm shadow-sm"
              />
            )}
            <span className="relative">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Underline tabs (Shell snippets, Intents history) with a sliding marker. */
export function UnderlineTabs<T extends string>({
  value,
  tabs,
  onChange,
  label,
  className,
}: {
  value: T;
  tabs: { value: T; label: ReactNode }[];
  onChange: (value: T) => void;
  label: string;
  className?: string;
}) {
  const id = useId();
  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn("flex flex-none gap-3.5 border-b", className)}
    >
      {tabs.map((tab) => {
        const on = tab.value === value;
        return (
          <button
            key={tab.value}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(tab.value)}
            className={cn(
              "focus-visible:outline-ring relative -mb-px flex h-[38px] items-center gap-1.5 font-medium whitespace-nowrap outline-none focus-visible:outline-2",
              on
                ? "text-foreground"
                : "text-secondary-foreground hover:text-foreground",
            )}
          >
            {tab.label}
            {on && (
              <motion.span
                layoutId={`tab-${id}`}
                transition={spring.snappy}
                className="bg-brand absolute inset-x-0 bottom-0 h-0.5"
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Breadcrumb parent: "<device>" or "<device> › Tools". */
export function useDeviceCrumb(tools = false) {
  const { t } = useTranslation();
  const device = useSelectedDevice();
  const navigate = useNavigation((s) => s.navigate);
  const { data: info } = useDeviceInfo(
    device?.state.kind === "device" ? device.serial : null,
  );
  if (!device) return undefined;
  const name = deviceName(device, info);
  return {
    label: tools ? (
      <span className="flex items-center gap-1.5">
        {name}
        <ChevronRight className="size-3.5 flex-none" aria-hidden />
        {t("nav.tools")}
      </span>
    ) : (
      name
    ),
    onClick: () => navigate("overview"),
  };
}

/** Page body for when no ready device is selected. */
export function NeedsDevice({ title }: { title: ReactNode }) {
  const { t } = useTranslation();
  const device = useSelectedDevice();
  const navigate = useNavigation((s) => s.navigate);
  return (
    <Page title={title}>
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <span className="bg-selected text-secondary-foreground flex size-10 items-center justify-center rounded-lg">
          <Smartphone className="size-5" aria-hidden />
        </span>
        <div>
          <p className="font-semibold">
            {device
              ? t("needsDevice.unavailable", { name: deviceName(device) })
              : t("needsDevice.title")}
          </p>
          <p className="text-muted-foreground mt-1 max-w-sm">
            {t("needsDevice.body")}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => navigate("devices")}>
          {t("sidebar.allDevices")}
        </Button>
      </div>
    </Page>
  );
}

/** Controlled confirmation for destructive actions. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel: ReactNode;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description && (
            <AlertDialogDescription>{description}</AlertDialogDescription>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("actions.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => {
              onConfirm();
              onOpenChange(false);
            }}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Human error text from a rejected `invoke`. */
export function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}
