import { Check, Copy } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Copies `text`; the icon turns into a check for a moment. */
export function CopyButton({
  text,
  label,
  withText = false,
  className,
}: {
  text: string;
  label: string;
  withText?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <Button
      variant={withText ? "outline" : "ghost"}
      size={withText ? "sm" : "icon-sm"}
      aria-label={label}
      onClick={copy}
      className={className}
    >
      {copied ? <Check /> : <Copy />}
      {withText && (copied ? t("actions.copied") : t("actions.copy"))}
    </Button>
  );
}

/** A mono path in a recessed box with a copy button. */
export function PathBox({
  path,
  copyLabel,
  className,
}: {
  path: string;
  copyLabel?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "bg-sidebar text-small flex items-center gap-2 rounded-[7px] border py-1 pr-1 pl-2.5 font-mono",
        className,
      )}
    >
      <span className="selectable min-w-0 flex-1 truncate" title={path}>
        {path}
      </span>
      {copyLabel && <CopyButton text={path} label={copyLabel} />}
    </div>
  );
}

/** "✓ Welcome — 2 Find adb — 3 Prepare phone". */
export function Steps({ current }: { current: 1 | 2 | 3 }) {
  const { t } = useTranslation("onboarding");
  const steps = [t("steps.welcome"), t("steps.findAdb"), t("steps.phone")];
  return (
    <ol className="text-small text-muted-foreground flex flex-wrap items-center gap-2.5">
      {steps.map((label, i) => {
        const n = i + 1;
        const done = n < current;
        const on = n === current;
        return (
          <li key={label} className="flex items-center gap-2.5">
            {i > 0 && (
              <span aria-hidden className="border-input w-7 border-t" />
            )}
            <span
              className={cn("flex items-center gap-2", on && "text-foreground")}
              aria-current={on ? "step" : undefined}
            >
              <b
                className={cn(
                  "text-caption inline-flex size-5 items-center justify-center rounded-full border font-semibold",
                  on && "bg-primary border-primary text-primary-foreground",
                  done && "bg-success/12 text-success border-transparent",
                  !on && !done && "border-input",
                )}
              >
                {done ? "✓" : n}
              </b>
              {label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** Rounded icon tile used by onboarding headers and cards. */
export function IconTile({
  children,
  tone = "neutral",
  size = 36,
  className,
}: {
  children: ReactNode;
  tone?: "neutral" | "brand" | "warning" | "success" | "error" | "info";
  size?: 28 | 32 | 36 | 40 | 56 | 64;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex flex-none items-center justify-center",
        size <= 28 && "size-7 rounded-[7px]",
        size === 32 && "size-8 rounded-full",
        size === 36 && "size-9 rounded-[9px]",
        size === 40 && "size-10 rounded-[10px]",
        size === 56 && "size-14 rounded-full",
        size === 64 && "size-16 rounded-2xl",
        tone === "neutral" && "bg-selected text-secondary-foreground",
        tone === "brand" && "bg-brand/15 text-brand",
        tone === "warning" && "bg-warning/12 text-warning",
        tone === "success" && "bg-success/12 text-success",
        tone === "error" && "bg-error/13 text-error",
        tone === "info" && "bg-info/13 text-info",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Replaces the user's home directory with `~` for display. */
export function tildify(path: string): string {
  return path.replace(/^(\/Users\/[^/]+|\/home\/[^/]+)/, "~");
}
