import { TriangleAlert } from "lucide-react";
import { toast } from "sonner";

import { StatusDot, type Tone } from "@/components/status/StatusDot";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const POP =
  "bg-popover text-popover-foreground border-input w-(--width) rounded-lg border shadow-lg";

interface ToastAction {
  label: string;
  onClick: () => void;
}

/** One-line status toast: dot + text (+ a ghost action), P2 board. */
export function showStatusToast(
  tone: Tone,
  text: string,
  action?: ToastAction,
) {
  toast.custom(
    (id) => (
      <div
        className={cn(POP, "flex items-center gap-2.5 px-3 py-2.5")}
        role="status"
      >
        <StatusDot tone={tone} />
        <span className="text-small min-w-0 flex-1">{text}</span>
        {action && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              toast.dismiss(id);
              action.onClick();
            }}
          >
            {action.label}
          </Button>
        )}
      </div>
    ),
    { duration: 5000 },
  );
}

/** Crash toast: title, exception line, "Open in Logcat" and "Copy trace". */
export function showCrashToast(props: {
  title: string;
  detail: string | null;
  open: ToastAction;
  copy: ToastAction | null;
}) {
  toast.custom(
    (id) => (
      <div
        className={cn(POP, "border-error flex items-start gap-2.5 p-3")}
        role="alert"
      >
        <TriangleAlert
          className="text-error mt-0.5 size-4 flex-none"
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <div className="font-semibold">{props.title}</div>
          {props.detail && (
            <div className="text-caption text-muted-foreground truncate font-mono">
              {props.detail}
            </div>
          )}
          <div className="mt-2 flex gap-1.5">
            <Button
              size="sm"
              onClick={() => {
                toast.dismiss(id);
                props.open.onClick();
              }}
            >
              {props.open.label}
            </Button>
            {props.copy && (
              <Button size="sm" variant="ghost" onClick={props.copy.onClick}>
                {props.copy.label}
              </Button>
            )}
          </div>
        </div>
      </div>
    ),
    { duration: 10_000 },
  );
}
