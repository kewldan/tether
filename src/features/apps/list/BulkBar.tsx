import { Download, Trash2, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { spring } from "@/lib/motion";
import type { AppSummary } from "../api";
import type { AppActions } from "../useAppActions";

/** Floating bar for the multi-selection (Apps board, bottom center). */
export function BulkBar({
  apps,
  actions,
  onClear,
}: {
  apps: AppSummary[];
  actions: AppActions;
  onClear: () => void;
}) {
  const { t } = useTranslation("apps");
  const allDisabled = apps.length > 0 && apps.every((a) => a.disabled);
  return (
    <AnimatePresence>
      {apps.length > 0 && (
        <motion.div
          role="toolbar"
          aria-label={t("bulk.label")}
          initial={{ opacity: 0, y: 12, x: "-50%" }}
          animate={{ opacity: 1, y: 0, x: "-50%" }}
          exit={{ opacity: 0, y: 12, x: "-50%" }}
          transition={spring.smooth}
          className="bg-popover ring-input absolute bottom-4 left-1/2 z-20 flex items-center gap-1.5 rounded-[10px] py-1.5 pr-1.5 pl-3.5 shadow-lg ring-1"
        >
          <span className="mr-1.5 font-semibold whitespace-nowrap tabular-nums">
            {t("bulk.selected", { count: apps.length })}
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void actions.extract(apps)}
          >
            <Download />
            {t("bulk.extract")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => actions.clearData(apps)}
          >
            {t("actions.clearData")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => actions.setEnabled(apps, allDisabled)}
          >
            {allDisabled ? t("actions.enable") : t("actions.disable")}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => actions.uninstall(apps)}
          >
            <Trash2 />
            {t("actions.uninstall")}
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={onClear}
            aria-label={t("bulk.clear")}
          >
            <X />
          </Button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
