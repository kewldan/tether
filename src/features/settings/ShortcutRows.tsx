import { RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import type { SettingsRow } from "@/features/settings/rows";
import { isMac } from "@/lib/platform";
import {
  type Combo,
  comboFromEvent,
  comboKeys,
  comboProblem,
  comboText,
  conflictOf,
  DIGITS,
  defaultKeys,
  isCustomized,
  parseCombo,
  SHORTCUT_IDS,
  type ShortcutId,
  useShortcuts,
} from "@/lib/shortcuts";
import { cn } from "@/lib/utils";

type Problem = "needsModifier" | "reserved" | "needsDigit";

/** What the row being edited shows. */
type Edit =
  | {
      id: ShortcutId;
      phase: "recording";
      held: Combo | null;
      problem?: Problem;
    }
  | { id: ShortcutId; phase: "conflict"; combo: Combo; other: ShortcutId };

/** Modifiers currently held, or null for none. */
function heldFrom(e: KeyboardEvent): Combo | null {
  const held = {
    mod: isMac ? e.metaKey : e.ctrlKey,
    ctrl: isMac && e.ctrlKey,
    alt: e.altKey,
    shift: e.shiftKey,
    code: "",
  };
  return held.mod || held.ctrl || held.alt || held.shift ? held : null;
}

/** Keys shown while only modifiers are held: `⌘ ⇧ —`. */
function heldKeys(held: Combo | null): string[] {
  if (!held) return ["—"];
  return [...comboKeys({ ...held, code: "" }).slice(0, -1), "—"];
}

function Keys({ keys, active }: { keys: string[]; active?: boolean }) {
  return (
    <span className="flex gap-[3px]">
      {keys.map((k, i) => (
        <Kbd
          // biome-ignore lint/suspicious/noArrayIndexKey: keycaps can repeat ("—")
          key={i}
          className={cn(active && "border-ring text-brand")}
        >
          {k}
        </Kbd>
      ))}
    </span>
  );
}

/**
 * Settings › Shortcuts: every shortcut from the registry, click the keys to
 * record a new combination. Esc cancels, Backspace clears; a combination
 * another shortcut uses asks before taking it over.
 */
export function useShortcutRows(): SettingsRow[] {
  const { t } = useTranslation("settings");
  const overrides = useShortcuts((s) => s.overrides);
  const bind = useShortcuts((s) => s.bind);
  const reset = useShortcuts((s) => s.reset);
  const resetAll = useShortcuts((s) => s.resetAll);
  const [edit, setEdit] = useState<Edit | null>(null);
  const recordingId = edit?.phase === "recording" ? edit.id : null;

  // Shortcuts stay quiet while a combination is being recorded.
  useEffect(() => {
    useShortcuts.getState().setRecording(recordingId !== null);
    return () => useShortcuts.getState().setRecording(false);
  }, [recordingId]);

  useEffect(() => {
    if (!recordingId) return;
    const id = recordingId;
    const commit = (combo: Combo | null) => {
      const other = combo && conflictOf(id, combo);
      if (combo && other) {
        setEdit({ id, phase: "conflict", combo, other });
        return;
      }
      bind(id, combo);
      setEdit(null);
    };
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.type === "keyup") {
        setEdit((cur) =>
          cur?.phase === "recording" && !cur.problem
            ? { ...cur, held: heldFrom(e) }
            : cur,
        );
        return;
      }
      const plain = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
      if (e.key === "Escape" && plain) return setEdit(null);
      if ((e.key === "Backspace" || e.key === "Delete") && plain) {
        return commit(null);
      }
      const combo = comboFromEvent(e);
      if (!combo) {
        // Only modifiers so far: show them.
        setEdit({ id, phase: "recording", held: heldFrom(e) });
        return;
      }
      let next = combo;
      if (id === "switch") {
        if (!/^(Digit|Numpad)[1-9]$/.test(combo.code)) {
          setEdit({
            id,
            phase: "recording",
            held: null,
            problem: "needsDigit",
          });
          return;
        }
        next = { ...combo, code: DIGITS };
      }
      const problem = comboProblem(next);
      if (problem) {
        setEdit({ id, phase: "recording", held: null, problem });
        return;
      }
      commit(next);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
    };
  }, [recordingId, bind]);

  const label = (id: ShortcutId) => t(`shortcuts.${id}`);

  const rows = SHORTCUT_IDS.map((id): SettingsRow => {
    const keys = overrides[id] ?? defaultKeys(id);
    const combo = parseCombo(keys);
    const mine = edit?.id === id ? edit : null;
    const recording = mine?.phase === "recording";

    let desc: string | undefined;
    if (mine?.phase === "conflict") {
      desc = t("shortcuts.conflict", {
        keys: comboText(mine.combo),
        other: label(mine.other),
      });
    } else if (recording && mine.problem) {
      desc = t(`shortcuts.problem.${mine.problem}`);
    } else if (recording) {
      desc = t(id === "switch" ? "shortcuts.hintDigits" : "shortcuts.hint");
    }

    const control =
      mine?.phase === "conflict" ? (
        <>
          <Button size="sm" variant="ghost" onClick={() => setEdit(null)}>
            {t("common:actions.cancel")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              bind(mine.other, null);
              bind(id, mine.combo);
              setEdit(null);
            }}
          >
            {t("shortcuts.replace")}
          </Button>
        </>
      ) : (
        <>
          {isCustomized(id, overrides) && !recording && (
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={t("shortcuts.reset", { name: label(id) })}
              title={t("shortcuts.resetOne")}
              onClick={() => reset(id)}
            >
              <RotateCcw />
            </Button>
          )}
          <button
            type="button"
            aria-label={t("shortcuts.edit", { name: label(id) })}
            aria-pressed={recording}
            onClick={() =>
              setEdit(recording ? null : { id, phase: "recording", held: null })
            }
            onBlur={() =>
              setEdit((cur) =>
                cur?.id === id && cur.phase === "recording" ? null : cur,
              )
            }
            className={cn(
              "focus-visible:outline-ring flex h-[26px] items-center gap-2 rounded-md px-1.5 outline-none focus-visible:outline-2",
              recording ? "bg-brand/15" : "hover:bg-accent",
            )}
          >
            {recording ? (
              <>
                <span className="text-small text-muted-foreground">
                  {t("shortcuts.press")}
                </span>
                <Keys keys={heldKeys(mine.held)} active />
              </>
            ) : combo ? (
              <Keys keys={comboKeys(combo)} />
            ) : (
              <span className="text-small text-muted-foreground">
                {t("shortcuts.none")}
              </span>
            )}
          </button>
        </>
      );

    return {
      id: `shortcut-${id}`,
      title: label(id),
      desc,
      keywords: combo ? comboKeys(combo).join(" ") : undefined,
      control,
    };
  });

  rows.push({
    id: "shortcut-reset-all",
    title: t("shortcuts.resetAll.title"),
    desc: t("shortcuts.resetAll.desc"),
    control: (
      <Button
        size="sm"
        variant="outline"
        disabled={Object.keys(overrides).length === 0}
        onClick={() => {
          setEdit(null);
          resetAll();
        }}
      >
        {t("shortcuts.resetAll.action")}
      </Button>
    ),
  });
  return rows;
}
