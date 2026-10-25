import { Search, X } from "lucide-react";
import type { ReactNode, RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { LEVELS, type Level } from "../api";
import { compactCount, LEVEL_TEXT } from "../format";

/** Small toggle inside the search field (Highlight, .*, Aa). */
function FieldToggle({
  pressed,
  onClick,
  label,
  className,
  children,
}: {
  pressed: boolean;
  onClick: () => void;
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      size="xs"
      aria-pressed={pressed}
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "h-[22px] px-1.5",
        pressed && "bg-brand/15 text-brand hover:bg-brand/15 hover:text-brand",
        className,
      )}
    >
      {children}
    </Button>
  );
}

export function SearchBox({
  inputRef,
  query,
  regex,
  matchCase,
  highlight,
  invalid,
  matches,
  onChange,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  query: string;
  regex: boolean;
  matchCase: boolean;
  highlight: boolean;
  invalid: boolean;
  matches: number | null;
  onChange: (patch: {
    query?: string;
    regex?: boolean;
    matchCase?: boolean;
    highlight?: boolean;
  }) => void;
}) {
  const { t, i18n } = useTranslation("logcat");
  return (
    <div
      className={cn(
        "border-input bg-background text-muted-foreground focus-within:border-ring flex h-7 w-[300px] min-w-0 items-center gap-2 rounded-[7px] border pr-[3px] pl-2.5",
        invalid && "border-destructive focus-within:border-destructive",
      )}
    >
      <Search className="size-3.5 flex-none" aria-hidden />
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => onChange({ query: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === "Escape" && query) {
            e.stopPropagation();
            onChange({ query: "" });
          }
        }}
        placeholder={t("search.placeholder")}
        aria-label={t("search.label")}
        aria-invalid={invalid || undefined}
        title={invalid ? t("search.invalid") : undefined}
        spellCheck={false}
        className="text-foreground placeholder:text-muted-foreground text-small min-w-0 flex-1 bg-transparent font-mono outline-none"
      />
      {matches !== null && query && !invalid && (
        <span className="num text-caption flex-none">
          {compactCount(matches, i18n.language)}
        </span>
      )}
      <FieldToggle
        pressed={highlight}
        label={t("search.highlightHint")}
        onClick={() => onChange({ highlight: !highlight })}
      >
        {t("search.highlight")}
      </FieldToggle>
      <FieldToggle
        pressed={regex}
        label={t("search.regex")}
        onClick={() => onChange({ regex: !regex })}
        className="font-mono"
      >
        .*
      </FieldToggle>
      <FieldToggle
        pressed={matchCase}
        label={t("search.matchCase")}
        onClick={() => onChange({ matchCase: !matchCase })}
      >
        Aa
      </FieldToggle>
    </div>
  );
}

export function LevelFilter({
  levels,
  counts,
  onChange,
}: {
  levels: Record<Level, boolean>;
  counts: Record<Level, number>;
  onChange: (levels: Record<Level, boolean>) => void;
}) {
  const { t, i18n } = useTranslation("logcat");
  return (
    <fieldset
      aria-label={t("levels.label")}
      title={t("levels.hint")}
      className="bg-selected flex flex-none gap-0.5 rounded-md p-0.5"
    >
      {LEVELS.map((level, index) => {
        const on = levels[level];
        return (
          <button
            key={level}
            type="button"
            aria-pressed={on}
            aria-label={t(on ? "levels.hide" : "levels.show", {
              level: t(`levels.${level}`),
            })}
            onClick={(e) => {
              if (e.shiftKey) {
                // This level and everything more severe.
                const next = { ...levels };
                LEVELS.forEach((l, i) => {
                  next[l] = i >= index;
                });
                onChange(next);
              } else {
                onChange({ ...levels, [level]: !on });
              }
            }}
            className={cn(
              "focus-visible:outline-ring inline-flex h-6 min-w-7 items-center justify-center gap-1 rounded-sm px-1.5 font-mono text-[11px] font-bold outline-none focus-visible:outline-2",
              on
                ? level === "F"
                  ? "bg-log-f text-primary-foreground"
                  : cn("bg-card shadow-sm", LEVEL_TEXT[level])
                : "text-muted-foreground line-through",
            )}
          >
            {level}
            <span className="num text-[10px] font-medium opacity-70">
              {compactCount(counts[level], i18n.language)}
            </span>
          </button>
        );
      })}
    </fieldset>
  );
}

/** Removable filter chip: package, included and excluded tags. */
export function Chip({
  tone = "default",
  icon,
  label,
  removeLabel,
  title,
  onRemove,
}: {
  tone?: "brand" | "default" | "muted";
  icon?: ReactNode;
  label: ReactNode;
  removeLabel: string;
  title?: string;
  onRemove: () => void;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex h-[22px] max-w-[280px] flex-none items-center gap-1 rounded-sm pr-1 pl-2 font-mono text-[11px] font-medium",
        tone === "brand" && "bg-brand/15 text-brand",
        tone === "default" && "bg-selected text-foreground",
        tone === "muted" && "bg-selected text-muted-foreground",
      )}
    >
      {icon}
      <span className="truncate">{label}</span>
      <button
        type="button"
        aria-label={removeLabel}
        onClick={onRemove}
        className="text-muted-foreground hover:text-foreground focus-visible:outline-ring flex size-4 flex-none items-center justify-center rounded-[3px] outline-none focus-visible:outline-2"
      >
        <X className="size-2.5" aria-hidden />
      </button>
    </span>
  );
}
