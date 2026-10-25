import { Ban, Copy, Filter, ListCollapse, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { modKey } from "@/lib/platform";
import { cn } from "@/lib/utils";

import type { LogLine } from "../buffer";
import type { PackageScope } from "../filter";
import { LEVEL_TEXT } from "../format";
import { logBuffer } from "../session";
import { activePreset, useLogcatUi } from "../store";
import { usePresetName } from "./Menus";

/** Right panel for the clicked line (Logcat board, 320 px). */
export function LineDetails({
  line,
  scope,
  onClose,
  onFilterTag,
  onExcludeTag,
  onAround,
  onCopy,
}: {
  line: LogLine;
  scope: PackageScope | null;
  onClose: () => void;
  onFilterTag: (tag: string) => void;
  onExcludeTag: (tag: string) => void;
  onAround: (line: LogLine) => void;
  onCopy: (line: LogLine) => void;
}) {
  const { t } = useTranslation("logcat");
  const presets = useLogcatUi((s) => s.presets);
  const filter = useLogcatUi((s) => s.filter);
  const applyPreset = useLogcatUi((s) => s.applyPreset);
  const presetName = usePresetName();
  const active = activePreset(presets, filter);

  const process =
    logBuffer.processes.get(line.pid) ??
    (line.crash?.pid === line.pid ? line.crash.process : null) ??
    (scope &&
    (scope.pids.has(line.pid) ||
      (scope.uid !== null &&
        scope.uid >= 10_000 &&
        line.uid === `${scope.uid}`))
      ? scope.name
      : null);

  const facts: [string, string][] = [
    [t("details.time"), `${line.date} ${line.time}`],
    [t("details.pidTid"), `${line.pid} · ${line.tid}`],
    [t("details.uid"), line.uid],
    [t("details.levelTag"), `${line.level} · ${line.tag}`],
    [t("details.process"), process ?? t("details.unknown")],
  ];

  return (
    <aside
      aria-label={t("details.title")}
      className="flex w-80 flex-none flex-col gap-2.5 overflow-auto border-l px-4 py-3.5"
    >
      <div className="flex items-center justify-between">
        <span className="font-semibold">{t("details.title")}</span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("details.close")}
          onClick={onClose}
        >
          <X />
        </Button>
      </div>
      <div
        className={cn(
          "selectable bg-sidebar text-small max-h-64 flex-none overflow-auto rounded-md border p-2.5 font-mono leading-[19px] break-words whitespace-pre-wrap",
          line.level === "V" || line.level === "D" || line.level === "I"
            ? "text-foreground"
            : LEVEL_TEXT[line.level === "F" ? "E" : line.level],
        )}
      >
        {line.message}
      </div>
      <dl className="m-0">
        {facts.map(([k, v]) => (
          <div key={k}>
            <dt className="text-muted-foreground text-caption">{k}</dt>
            <dd className="selectable num text-small mb-2 truncate font-mono">
              {v}
            </dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-col gap-1.5">
        <Button
          variant="outline"
          size="sm"
          className="justify-start"
          onClick={() => onFilterTag(line.tag)}
        >
          <Filter aria-hidden />
          <span className="truncate">
            {t("details.filterTag", { tag: line.tag })}
          </span>
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="justify-start"
          onClick={() => onExcludeTag(line.tag)}
        >
          <Ban aria-hidden />
          {t("details.excludeTag")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="justify-start"
          onClick={() => onAround(line)}
        >
          <ListCollapse aria-hidden />
          {t("details.around")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="justify-start"
          onClick={() => onCopy(line)}
        >
          <Copy aria-hidden />
          {t("details.copyLine")}
          <Kbd className="ml-auto">{modKey}C</Kbd>
        </Button>
      </div>
      <div className="mt-auto pt-2">
        <div className="text-caption text-muted-foreground mb-1.5 font-semibold tracking-wide uppercase">
          {t("details.presets")}
        </div>
        <div className="text-small flex flex-col gap-0.5">
          {presets.map((p, i) => (
            <button
              key={p.id}
              type="button"
              onClick={() => applyPreset(p.id)}
              className={cn(
                "hover:bg-accent focus-visible:outline-ring flex h-7 items-center rounded-sm px-2 text-left outline-none focus-visible:outline-2",
                p.id === active?.id
                  ? "bg-selected text-foreground"
                  : "text-muted-foreground",
              )}
            >
              <span className="truncate">{presetName(p)}</span>
              {i < 9 && (
                <Kbd className="ml-auto">
                  {modKey}
                  {i + 1}
                </Kbd>
              )}
            </button>
          ))}
        </div>
      </div>
    </aside>
  );
}
