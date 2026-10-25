import {
  ChevronLeft,
  ChevronUp,
  Eye,
  LayoutGrid,
  List,
  Search,
  X,
} from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { hasMod, modKey } from "@/lib/platform";
import { cn } from "@/lib/utils";

import { basename, parent, resolve, segments } from "../paths";
import { useBrowser, useFilesPrefs } from "../store";
import { Segmented } from "./Segmented";

/** Back / up, breadcrumb that turns into an input, search, hidden, view. */
export function PathBar({
  searchRef,
}: {
  searchRef: React.RefObject<HTMLInputElement | null>;
}) {
  const { t } = useTranslation("files");
  const path = useBrowser((s) => s.path);
  const canBack = useBrowser((s) => s.back.length > 0);
  const go = useBrowser((s) => s.go);
  const goBack = useBrowser((s) => s.goBack);
  const query = useBrowser((s) => s.query);
  const setQuery = useBrowser((s) => s.setQuery);
  const showHidden = useFilesPrefs((s) => s.showHidden);
  const toggleHidden = useFilesPrefs((s) => s.toggleHidden);
  const view = useFilesPrefs((s) => s.view);
  const setView = useFilesPrefs((s) => s.setView);
  const [editing, setEditing] = useState(false);

  // ⌘L edits the path, like a browser address bar.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (hasMod(e) && e.key.toLowerCase() === "l") {
        e.preventDefault();
        setEditing(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="flex flex-none items-center gap-2 border-b px-3.5 py-2.5">
      <IconTip label={t("toolbar.back")} shortcut={`${modKey}[`}>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("toolbar.back")}
          disabled={!canBack}
          onClick={goBack}
        >
          <ChevronLeft />
        </Button>
      </IconTip>
      <IconTip label={t("toolbar.up")} shortcut={`${modKey}↑`}>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("toolbar.up")}
          disabled={path === "/"}
          onClick={() => go(parent(path))}
        >
          <ChevronUp />
        </Button>
      </IconTip>

      {editing ? (
        <PathInput
          path={path}
          onSubmit={(p) => {
            setEditing(false);
            go(p);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <Breadcrumb path={path} onGo={go} onEdit={() => setEditing(true)} />
      )}

      <label className="border-input bg-background focus-within:border-ring text-muted-foreground flex h-7 w-[200px] flex-none items-center gap-2 rounded-[7px] border px-2.5">
        <Search className="size-3.5 flex-none" aria-hidden />
        <input
          ref={searchRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setQuery("");
              e.currentTarget.blur();
            }
          }}
          placeholder={t("toolbar.searchIn", { name: basename(path) })}
          aria-label={t("toolbar.search")}
          className="text-foreground placeholder:text-muted-foreground text-body min-w-0 flex-1 bg-transparent outline-none"
        />
        {query && (
          <button
            type="button"
            aria-label={t("toolbar.clearSearch")}
            onClick={() => setQuery("")}
            className="hover:text-foreground"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        )}
      </label>

      <Button
        variant="ghost"
        size="sm"
        aria-pressed={showHidden}
        onClick={toggleHidden}
        className={cn(showHidden && "bg-selected text-foreground")}
      >
        <Eye />
        {t("toolbar.hidden")}
      </Button>

      <Segmented
        label={t("toolbar.view")}
        value={view}
        onChange={setView}
        options={[
          {
            value: "list",
            ariaLabel: t("toolbar.list"),
            label: <List className="size-3.5" aria-hidden />,
          },
          {
            value: "grid",
            ariaLabel: t("toolbar.grid"),
            label: <LayoutGrid className="size-3.5" aria-hidden />,
          },
        ]}
      />
    </div>
  );
}

function IconTip({
  label,
  shortcut,
  children,
}: {
  label: string;
  shortcut?: string;
  children: React.ReactElement;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent>
        {label}
        {shortcut && (
          <span className="text-muted-foreground ml-2">{shortcut}</span>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

function Breadcrumb({
  path,
  onGo,
  onEdit,
}: {
  path: string;
  onGo: (path: string) => void;
  onEdit: () => void;
}) {
  const { t } = useTranslation("files");
  const parts = segments(path);
  return (
    <nav
      aria-label={t("toolbar.path")}
      className="bg-sidebar text-small flex h-7 min-w-0 flex-1 items-center gap-0.5 overflow-hidden rounded-[7px] border px-1.5 font-mono"
    >
      {parts.map((part, i) => {
        const last = i === parts.length - 1;
        return (
          <Fragment key={part.path}>
            {i > 1 && (
              <span aria-hidden className="text-muted-foreground flex-none">
                /
              </span>
            )}
            <button
              type="button"
              onClick={() => onGo(part.path)}
              aria-current={last ? "location" : undefined}
              title={part.path}
              className={cn(
                "hover:bg-accent hover:text-foreground focus-visible:outline-ring min-w-[3ch] truncate rounded-xs px-1 py-0.5 outline-none focus-visible:outline-2",
                last
                  ? "text-foreground flex-none"
                  : "text-secondary-foreground shrink",
              )}
            >
              {part.name}
            </button>
          </Fragment>
        );
      })}
      <button
        type="button"
        onClick={onEdit}
        aria-label={t("toolbar.editPath")}
        className="h-full min-w-4 flex-1 cursor-text outline-none"
      />
    </nav>
  );
}

function PathInput({
  path,
  onSubmit,
  onCancel,
}: {
  path: string;
  onSubmit: (path: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation("files");
  const ref = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(path);

  useEffect(() => {
    ref.current?.select();
  }, []);

  return (
    <input
      ref={ref}
      value={value}
      spellCheck={false}
      aria-label={t("toolbar.path")}
      onChange={(e) => setValue(e.target.value)}
      onBlur={onCancel}
      onKeyDown={(e) => {
        if (e.key === "Enter") onSubmit(resolve(path, value));
        if (e.key === "Escape") onCancel();
      }}
      className="bg-background border-ring text-foreground text-small h-7 min-w-0 flex-1 rounded-[7px] border px-2.5 font-mono outline-none"
    />
  );
}
