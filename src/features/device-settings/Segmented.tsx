import { cn } from "cn";
import { motion } from "motion/react";
import { useId } from "react";

import { spring } from "@/lib/motion";

/**
 * Segmented control (`.seg` in the design): the selected pill slides on
 * the snappy spring.
 */
export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
  disabled,
  stretch = false,
  className,
}: {
  value: T | null;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
  disabled?: boolean;
  stretch?: boolean;
  className?: string;
}) {
  const id = useId();
  return (
    <fieldset
      aria-label={label}
      className={cn(
        "bg-selected m-0 inline-flex min-w-0 flex-none gap-0.5 rounded-md border-0 p-0.5",
        stretch && "flex w-full",
        disabled && "opacity-50",
        className,
      )}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={String(o.value)}
            type="button"
            aria-pressed={active}
            disabled={disabled}
            onClick={() => !active && onChange(o.value)}
            className={cn(
              "text-small focus-visible:outline-ring relative h-6 rounded-sm px-2.5 font-medium whitespace-nowrap outline-none focus-visible:outline-2",
              stretch && "flex-1",
              active
                ? "text-foreground"
                : "text-secondary-foreground hover:text-foreground",
            )}
          >
            {active && (
              <motion.span
                layoutId={`seg-${id}`}
                transition={spring.snappy}
                className="bg-card absolute inset-0 rounded-sm shadow-sm"
              />
            )}
            <span className="relative tabular-nums">{o.label}</span>
          </button>
        );
      })}
    </fieldset>
  );
}
