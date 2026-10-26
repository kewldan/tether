import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Strip on top of each pane in two-pane mode: which side it is, and the
 * copy button, placed on the edge that faces the other pane.
 */
export function PaneHeader({
  icon: Icon,
  title,
  detail,
  active,
  actionSide,
  action,
}: {
  icon: LucideIcon;
  title: ReactNode;
  detail?: ReactNode;
  /** The pane keyboard shortcuts go to. */
  active: boolean;
  actionSide: "left" | "right";
  action?: ReactNode;
}) {
  return (
    <div className="bg-sidebar h-row flex flex-none items-center gap-2 border-b px-2">
      {actionSide === "left" && action}
      <div
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2",
          actionSide === "right" ? "pl-1.5" : "pr-1.5",
        )}
      >
        <Icon
          aria-hidden
          className={cn(
            "size-3.5 flex-none",
            active ? "text-brand" : "text-muted-foreground",
          )}
        />
        <span className="text-small flex-none font-semibold">{title}</span>
        {detail && (
          <span className="text-muted-foreground text-caption min-w-0 truncate font-mono">
            {detail}
          </span>
        )}
      </div>
      {actionSide === "right" && action}
    </div>
  );
}
