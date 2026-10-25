import {
  Download,
  Eraser,
  MoreHorizontal,
  Play,
  ScrollText,
  Square,
  ToggleLeft,
  Trash2,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { AppSummary } from "../api";
import type { AppActions } from "../useAppActions";

export function AppRowMenu({
  app,
  actions,
}: {
  app: AppSummary;
  actions: AppActions;
}) {
  const { t } = useTranslation("apps");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="icon-sm" />}
        aria-label={t("list.more")}
        onClick={(e) => e.stopPropagation()}
      >
        <MoreHorizontal />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-52"
        onClick={(e) => e.stopPropagation()}
      >
        <DropdownMenuItem
          disabled={!app.launcher || app.disabled}
          onClick={() => void actions.open(app)}
        >
          <Play />
          {t("actions.open")}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => void actions.forceStop(app)}>
          <Square />
          {t("actions.forceStop")}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => actions.logcat(app)}>
          <ScrollText />
          {t("actions.logcat")}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => void actions.extract([app])}>
          <Download />
          {t("actions.extract")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => actions.setEnabled([app], app.disabled)}
        >
          <ToggleLeft />
          {app.disabled ? t("actions.enable") : t("actions.disable")}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => actions.clearData([app])}>
          <Eraser />
          {t("actions.clearDataEllipsis")}
        </DropdownMenuItem>
        <DropdownMenuItem
          variant="destructive"
          onClick={() => actions.uninstall([app])}
        >
          <Trash2 />
          {t("actions.uninstallEllipsis")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
