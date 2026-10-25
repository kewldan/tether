import { cn } from "cn";
import { motion } from "motion/react";
import { type KeyboardEvent, type ReactNode, useId, useRef } from "react";

import { spring } from "@/lib/motion";

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  /** Accessible name when `label` is an icon. */
  ariaLabel?: string;
}

/**
 * Segmented control (radio group) from Components.dc.html: 24 px items on
 * a `selected` track, the thumb slides on the snappy spring.
 */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  className,
  itemClassName,
}: {
  value: T;
  onChange: (value: T) => void;
  options: SegmentedOption<T>[];
  label: string;
  className?: string;
  itemClassName?: string;
}) {
  const id = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const onKeyDown = (e: KeyboardEvent, index: number) => {
    const step =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? 1
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? -1
          : 0;
    if (!step) return;
    e.preventDefault();
    const next = (index + step + options.length) % options.length;
    onChange(options[next].value);
    refs.current[next]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn(
        "bg-selected inline-flex flex-none gap-0.5 rounded-md p-0.5",
        className,
      )}
    >
      {options.map((o, i) => {
        const on = o.value === value;
        return (
          // biome-ignore lint/a11y/useSemanticElements: styled segmented radio
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={o.ariaLabel}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cn(
              "text-small focus-visible:outline-ring relative inline-flex h-6 items-center justify-center gap-1.5 rounded-sm px-2.5 font-medium whitespace-nowrap outline-none focus-visible:outline-2",
              on
                ? "text-foreground"
                : "text-secondary-foreground hover:text-foreground",
              itemClassName,
            )}
          >
            {on && (
              <motion.span
                layoutId={id}
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
