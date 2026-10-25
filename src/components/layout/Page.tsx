import { cn } from "cn";
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Standard page frame: 52 px header with breadcrumb and actions, then the
 * page body. `body` controls scrolling: "scroll" pads and scrolls,
 * "fill" hands the full remaining area to the page (tables, logcat).
 */
export function Page({
  title,
  parent,
  actions,
  toolbar,
  body = "scroll",
  className,
  children,
}: {
  title: ReactNode;
  parent?: { label: ReactNode; onClick?: () => void };
  actions?: ReactNode;
  /** Optional row under the header (filters, tabs). */
  toolbar?: ReactNode;
  body?: "scroll" | "fill";
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full min-w-0 flex-col">
      <header className="flex h-[52px] flex-none items-center gap-3 border-b px-5">
        <div className="text-muted-foreground flex min-w-0 items-center gap-1.5 whitespace-nowrap">
          {parent && (
            <>
              <button
                type="button"
                className="hover:text-foreground focus-visible:outline-ring truncate rounded-sm outline-none focus-visible:outline-2"
                onClick={parent.onClick}
              >
                {parent.label}
              </button>
              <ChevronRight className="size-3.5 flex-none" aria-hidden />
            </>
          )}
          <h1 className="text-foreground text-section truncate font-semibold">
            {title}
          </h1>
        </div>
        {actions && (
          <div className="ml-auto flex flex-none items-center gap-2">
            {actions}
          </div>
        )}
      </header>
      {toolbar && (
        <div className="flex flex-none items-center gap-2 border-b px-5 py-2">
          {toolbar}
        </div>
      )}
      <div
        className={cn(
          "min-h-0 flex-1",
          body === "scroll" ? "overflow-auto px-5 py-6" : "flex flex-col",
          className,
        )}
      >
        {children}
      </div>
    </div>
  );
}
