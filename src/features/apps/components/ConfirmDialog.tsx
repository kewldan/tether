import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export interface ConfirmRequest {
  title: ReactNode;
  description: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  /** The user must type this exactly (package name) to enable confirm. */
  typeToConfirm?: string;
  /** Extra controls, e.g. a "keep data" checkbox. */
  extra?: ReactNode;
  onConfirm: () => void;
}

/**
 * The page's single confirmation dialog. Destructive actions confirm here;
 * the most dangerous ones (clear data) require typing the package name.
 */
export function ConfirmDialog({
  request,
  onClose,
}: {
  request: ConfirmRequest | null;
  onClose: () => void;
}) {
  const { t } = useTranslation("apps");
  const [typed, setTyped] = useState("");
  // Keep the last request rendered while the dialog animates out.
  const [shown, setShown] = useState(request);
  useEffect(() => {
    if (request) {
      setShown(request);
      setTyped("");
    }
  }, [request]);

  const r = shown;
  const blocked = r?.typeToConfirm !== undefined && typed !== r.typeToConfirm;

  return (
    <AlertDialog open={request !== null} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent className="flex max-w-[440px] flex-col gap-3.5 p-5 sm:max-w-[440px]">
        {r && (
          <>
            <AlertDialogTitle className="text-[16px] leading-6 font-semibold">
              {r.title}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-secondary-foreground text-body">
              {r.description}
            </AlertDialogDescription>
            {r.typeToConfirm !== undefined && (
              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="apps-type-to-confirm"
                  className="text-small text-secondary-foreground"
                >
                  {t("confirm.typeToConfirm.before")}
                  <span className="text-foreground font-mono">
                    {r.typeToConfirm}
                  </span>
                  {t("confirm.typeToConfirm.after")}
                </label>
                <Input
                  id="apps-type-to-confirm"
                  autoFocus
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  className="font-mono"
                  spellCheck={false}
                  autoComplete="off"
                  aria-label={t("confirm.typeToConfirm.label")}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !blocked) {
                      r.onConfirm();
                      onClose();
                    }
                  }}
                />
              </div>
            )}
            {r.extra}
            <AlertDialogFooter className="m-0 flex-row justify-end gap-2 rounded-none border-0 bg-transparent p-0">
              <AlertDialogCancel variant="ghost">
                {t("common:actions.cancel")}
              </AlertDialogCancel>
              <Button
                variant={r.destructive ? "destructive" : "default"}
                disabled={blocked}
                onClick={() => {
                  r.onConfirm();
                  onClose();
                }}
              >
                {r.confirmLabel}
              </Button>
            </AlertDialogFooter>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}
