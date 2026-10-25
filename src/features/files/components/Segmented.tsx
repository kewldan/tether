import { cn } from "cn";
import { motion } from "motion/react";
import { type ReactNode, useId } from "react";

import { spring } from "@/lib/motion";

/** Segmented control from the design (`.seg`): a sliding thumb on snappy. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: ReactNode; ariaLabel?: string }[];
  label: string;
}) {
  const id = useId();
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="bg-selected inline-flex flex-none gap-0.5 rounded-md p-0.5"
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          // biome-ignore lint/a11y/useSemanticElements: styled radio button
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={o.ariaLabel}
            onClick={() => onChange(o.value)}
            className={cn(
              "focus-visible:outline-ring text-small relative inline-flex h-6 items-center gap-1.5 rounded-sm px-2.5 font-medium whitespace-nowrap outline-none focus-visible:outline-2",
              on ? "text-foreground" : "text-secondary-foreground",
            )}
          >
            {on && (
              <motion.span
                layoutId={`seg-${id}`}
                transition={spring.snappy}
                className="bg-card absolute inset-0 rounded-sm shadow-sm"
              />
            )}
            <span className="relative inline-flex items-center gap-1.5">
              {o.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
