import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import type { AppSummary } from "../api";

/** system · disabled · debuggable · split APK, as on the Apps board. */
export function AppBadges({
  app,
  splitCount,
}: {
  app: AppSummary;
  /** Show the number of splits ("split APK · 4") as in the detail header. */
  splitCount?: boolean;
}) {
  const { t } = useTranslation("apps");
  return (
    <span className="flex items-center gap-1">
      {app.debuggable && <Badge variant="info">{t("badge.debuggable")}</Badge>}
      {app.splits.length > 0 && (
        <Badge>
          {splitCount
            ? t("badge.splitCount", { count: app.splits.length + 1 })
            : t("badge.split")}
        </Badge>
      )}
      {app.system && <Badge>{t("badge.system")}</Badge>}
      {app.updatedSystem && <Badge>{t("badge.updated")}</Badge>}
      {app.disabled && (
        <Badge className="line-through">{t("badge.disabled")}</Badge>
      )}
      {app.suspended && <Badge variant="warning">{t("badge.suspended")}</Badge>}
      {app.testOnly && <Badge variant="warning">{t("badge.testOnly")}</Badge>}
    </span>
  );
}
