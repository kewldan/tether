import { cn } from "cn";
import { motion } from "motion/react";
import { type ReactNode, useId } from "react";

import { spring } from "@/lib/motion";

/** Segmented control (`.seg` on the boards) with a sliding thumb. */
export function Segmented<T extends string>({
  value,
  onChange,
  items,
  label,
}: {
  value: T;
  onChange: (value: T) => void;
  items: { value: T; label: ReactNode; count?: number | null }[];
  label: string;
}) {
  const id = useId();
  return (
    <div
      role="tablist"
      aria-label={label}
      className="bg-selected inline-flex flex-none gap-0.5 rounded-lg p-0.5"
    >
      {items.map((item) => {
        const on = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(item.value)}
            className={cn(
              "text-small focus-visible:outline-ring relative inline-flex h-6 items-center gap-1.5 rounded-md px-2.5 font-medium whitespace-nowrap outline-none focus-visible:outline-2",
              on
                ? "text-foreground"
                : "text-secondary-foreground hover:text-foreground",
            )}
          >
            {on && (
              <motion.span
                layoutId={`seg-${id}`}
                transition={spring.snappy}
                className="bg-card absolute inset-0 rounded-md shadow-sm"
              />
            )}
            <span className="relative">{item.label}</span>
            {item.count !== undefined && item.count !== null && (
              <span className="text-muted-foreground relative tabular-nums">
                {item.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
