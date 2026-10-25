import { Upload } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useTranslation } from "react-i18next";

import { spring } from "@/lib/motion";

import { formatBytes } from "../format";
import type { DropState } from "../useDropUpload";

/** Dashed brand drop zone over the list (Files board, "dragging" state). */
export function DropOverlay({
  drop,
  path,
}: {
  drop: DropState | null;
  path: string;
}) {
  const { t } = useTranslation("files");
  const summary = drop?.summary;
  return (
    <AnimatePresence>
      {drop && (
        <motion.div
          key="drop"
          initial={{ opacity: 0, scale: 1 }}
          animate={{ opacity: 1, scale: 1.015 }}
          exit={{ opacity: 0, scale: 1 }}
          transition={spring.snappy}
          className="border-brand bg-brand/15 pointer-events-none absolute inset-2.5 z-30 flex flex-col items-center justify-center gap-2.5 rounded-xl border-[1.5px] border-dashed backdrop-blur-[2px]"
        >
          <Upload className="text-brand size-8" aria-hidden />
          <div className="text-section px-6 text-center font-semibold">
            {t("drop.title")}{" "}
            <span className="font-mono break-all">{path}</span>
          </div>
          <div className="text-secondary-foreground num">
            {summary
              ? [
                  summary.files > 0 &&
                    t("preview.files", { count: summary.files }),
                  summary.folders > 0 &&
                    t("preview.folders", { count: summary.folders }),
                  summary.bytes > 0 && formatBytes(summary.bytes),
                ]
                  .filter(Boolean)
                  .join(" · ")
              : t("drop.items", { count: drop.count })}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
