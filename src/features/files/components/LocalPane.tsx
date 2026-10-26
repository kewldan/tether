import {
  ArrowRight,
  ChevronLeft,
  ChevronUp,
  Copy,
  Download,
  FileText,
  Film,
  FolderOpen,
  HardDrive,
  House,
  Image,
  Laptop,
  type LucideIcon,
  MapPin,
  Monitor,
  Music,
  RefreshCw,
  Search,
  Upload,
  X,
} from "lucide-react";
import {
  Fragment,
  type KeyboardEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { hasMod, modKey, os } from "@/lib/platform";
import { cn } from "@/lib/utils";

import {
  type FileEntry,
  isDirLike,
  type LocalEntry,
  type LocalListing,
  type LocalPlace,
  type LocalPlaceKey,
  resolveLocal,
} from "../api";
import { trackRowDrag, useDrag } from "../dragging";
import { visibleEntries } from "../model";
import { localBasename } from "../paths";
import { useLocalListing, useLocalPlaces, useRefreshLocal } from "../queries";
import { reveal } from "../reveal";
import { useFilesPrefs, useLocalBrowser } from "../store";
import { onTransferFinished, useTransfers } from "../transfers";
import { errorText } from "../useFileActions";
import { useSelection } from "../useSelection";
import { FileTable } from "./FileTable";
import { ListState } from "./ListState";
import { PaneHeader } from "./PaneHeader";

export const LOCAL_PLACE_ICONS: Record<LocalPlaceKey, LucideIcon> = {
  home: House,
  desktop: Monitor,
  documents: FileText,
  downloads: Download,
  pictures: Image,
  videos: Film,
  music: Music,
  volume: HardDrive,
};

/** "Mac", "PC" or "Computer", capitalised for titles. */
export function useComputerTitle() {
  const { t } = useTranslation("files");
  const name = t(`computer.${os}`);
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export function useLocalPlaceLabel() {
  const { t } = useTranslation("files");
  return useCallback(
    (place: LocalPlace) =>
      place.key === "volume" ? place.label : t(`localPlaces.${place.key}`),
    [t],
  );
}

/** The computer side of two-pane mode. */
export function LocalPane({
  serial,
  devicePath,
  active,
  onActivate,
}: {
  serial: string;
  /** Folder the device pane shows: where "Copy →" goes. */
  devicePath: string;
  active: boolean;
  onActivate: () => void;
}) {
  const { t } = useTranslation("files");
  const computer = useComputerTitle();
  const path = useLocalBrowser((s) => s.path);
  const go = useLocalBrowser((s) => s.go);
  const query = useLocalBrowser((s) => s.query);
  const showHidden = useFilesPrefs((s) => s.showHidden);
  const sort = useFilesPrefs((s) => s.sort);
  const enqueue = useTransfers((s) => s.enqueue);
  const refresh = useRefreshLocal();
  const places = useLocalPlaces();
  const home = places.data?.find((p) => p.key === "home")?.path ?? null;
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [menuTarget, setMenuTarget] = useState<FileEntry[]>([]);

  // Start in the last folder (or home), and remember where we go.
  useEffect(() => {
    if (useLocalBrowser.getState().path) return;
    const start = useFilesPrefs.getState().localPath ?? home;
    if (start) useLocalBrowser.getState().reset(start);
  }, [home]);
  useEffect(
    () =>
      useLocalBrowser.subscribe((s, prev) => {
        if (s.path && s.path !== prev.path)
          useFilesPrefs.getState().setLocalPath(s.path);
      }),
    [],
  );

  const listing = useLocalListing(path || null);
  const all = listing.data?.entries;
  const entries = useMemo(
    () =>
      visibleEntries(
        (all ?? []).filter((e) => showHidden || !e.hidden),
        { showHidden, query, sort },
      ) as LocalEntry[],
    [all, showHidden, query, sort],
  );
  const sel = useSelection(entries, useLocalBrowser);
  const { selection, select, dragEntries, navKey } = sel;

  // The remembered folder may be gone: fall back to home once.
  const missing =
    listing.error?.kind === "invalid_input" && home !== null && path !== home;
  useEffect(() => {
    if (missing && home) useLocalBrowser.getState().reset(home);
  }, [missing, home]);

  // Downloads into this folder show up without a manual refresh.
  useEffect(
    () =>
      onTransferFinished((tr) => {
        if (tr.direction === "pull" && tr.target === path) refresh();
      }),
    [path, refresh],
  );

  const copyToDevice = useCallback(
    (list: FileEntry[]) => {
      if (list.length === 0) return;
      enqueue({
        serial,
        direction: "push",
        sources: list.map((e) => e.path),
        target: devicePath,
      });
    },
    [enqueue, serial, devicePath],
  );

  const open = useCallback(
    (entry: FileEntry) => {
      if (isDirLike(entry)) go(entry.path);
      else copyToDevice([entry]);
    },
    [go, copyToDevice],
  );

  const goUp = useCallback(() => {
    const parent = listing.data?.parent;
    if (parent) go(parent);
  }, [listing.data?.parent, go]);

  // Shortcuts while this pane is the active one.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el?.closest("input, textarea, [role=dialog], [role=menu]")) return;
      const key = e.key.toLowerCase();
      const mod = hasMod(e);
      if (mod && key === "r") {
        e.preventDefault();
        refresh();
      } else if (mod && key === "f") {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (mod && key === "[") {
        e.preventDefault();
        useLocalBrowser.getState().goBack();
      } else if (mod && key === "]") {
        e.preventDefault();
        useLocalBrowser.getState().goForward();
      } else if ((mod || e.altKey) && e.key === "ArrowUp") {
        e.preventDefault();
        goUp();
      } else if (mod && e.shiftKey && key === ".") {
        e.preventDefault();
        useFilesPrefs.getState().toggleHidden();
      } else if (mod && e.shiftKey && key === "c") {
        e.preventDefault();
        void copyPaths(
          selection.length ? selection.map((x) => x.path) : [path],
        );
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, refresh, goUp, selection, path]);

  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (navKey(e, "list")) return;
    if (e.key === "ArrowDown" && hasMod(e) && selection[0]) {
      e.preventDefault();
      open(selection[0]);
    } else if (e.key === "Enter" && selection.length > 0) {
      e.preventDefault();
      if (selection.length === 1 && selection[0]) open(selection[0]);
      else copyToDevice(selection);
    }
  };

  const onContextMenuCapture = (e: MouseEvent<HTMLDivElement>) => {
    const rowPath = (e.target as HTMLElement).closest<HTMLElement>(
      "[data-path]",
    )?.dataset.path;
    if (!rowPath) {
      select([], null);
      setMenuTarget([]);
      return;
    }
    if (sel.selected.has(rowPath)) setMenuTarget(selection);
    else {
      const entry = entries.find((x) => x.path === rowPath);
      select([rowPath], rowPath);
      setMenuTarget(entry ? [entry] : []);
    }
  };

  const dropTarget = useDrag((s) =>
    s.target?.pane === "local" ? s.target : null,
  );
  const deviceName = localBasename(devicePath) || devicePath;
  const name = listing.data
    ? (listing.data.crumbs.at(-1)?.name ?? path)
    : localBasename(path);

  const body =
    !path || listing.isPending ? (
      <ListState kind="loading" />
    ) : listing.error ? (
      <ListState
        kind="error"
        error={listing.error}
        onRetry={() => void listing.refetch()}
        onHome={() => home && go(home)}
        homeLabel={t("localPlaces.home")}
      />
    ) : listing.data?.denied ? (
      <ListState
        kind="denied"
        path={path}
        onUp={goUp}
        body={t("twoPane.deniedBody", { path })}
      />
    ) : (all ?? []).length === 0 ? (
      <ListState kind="empty" body={t("twoPane.emptyBody")} />
    ) : entries.length === 0 ? (
      <ListState
        kind="noMatches"
        query={query}
        hiddenCount={(all ?? []).length}
        onClear={() => useLocalBrowser.getState().setQuery("")}
        onShowHidden={
          showHidden ? undefined : useFilesPrefs.getState().toggleHidden
        }
      />
    ) : (
      <FileTable
        compact
        entries={entries}
        selected={sel.selected}
        focused={sel.anchor}
        scrollRef={scrollRef}
        onRowClick={sel.onRowClick}
        onToggle={sel.onToggle}
        onToggleAll={sel.onToggleAll}
        onOpen={open}
        dropDir={dropTarget?.dir}
      />
    );

  return (
    <section
      aria-label={computer}
      data-drop-pane="local"
      data-drop-dir={path || undefined}
      data-drop-name={name}
      onPointerDownCapture={onActivate}
      onFocusCapture={onActivate}
      className="@container relative flex min-w-0 flex-1 flex-col border-r"
    >
      <PaneHeader
        icon={Laptop}
        title={computer}
        detail={path}
        active={active}
        actionSide="right"
        action={
          <CopyButton
            label={t("twoPane.copyToDevice")}
            tip={t("twoPane.copyToTip", { path: devicePath })}
            count={selection.length}
            onClick={() => copyToDevice(selection)}
            direction="right"
          />
        }
      />
      <LocalPathBar
        listing={listing.data}
        path={path}
        places={places.data ?? []}
        searchRef={searchRef}
        onUp={goUp}
      />
      <div className="relative min-h-0 flex-1">
        <ContextMenu>
          <ContextMenuTrigger
            ref={scrollRef}
            tabIndex={0}
            aria-label={t("list.label", { name })}
            onKeyDown={onListKey}
            onContextMenuCapture={onContextMenuCapture}
            onPointerDown={(e) =>
              trackRowDrag(e, (rowPath) => ({
                from: "local",
                serial,
                entries: dragEntries(rowPath),
              }))
            }
            onClick={(e: MouseEvent<HTMLDivElement>) => {
              if (!(e.target as HTMLElement).closest("[data-path]"))
                select([], null);
            }}
            className="focus-visible:outline-ring @container absolute inset-0 overflow-auto outline-none focus-visible:outline-1 focus-visible:-outline-offset-1"
          >
            {body}
          </ContextMenuTrigger>
          <LocalMenu
            target={menuTarget}
            path={path}
            deviceFolder={deviceName}
            onOpen={open}
            onCopy={copyToDevice}
            onRefresh={refresh}
          />
        </ContextMenu>
        <PaneDropHint
          show={dropTarget !== null && dropTarget.dir === path}
          label={t("dragOut.copyTo", { name })}
        />
      </div>
    </section>
  );
}

async function copyPaths(paths: string[]) {
  try {
    await navigator.clipboard.writeText(paths.join("\n"));
  } catch {
    // Clipboard may be unavailable; nothing to report.
  }
}

/** "Copy →" / "← Copy" with the selection count. */
export function CopyButton({
  label,
  tip,
  count,
  onClick,
  direction,
}: {
  label: string;
  tip: string;
  count: number;
  onClick: () => void;
  direction: "left" | "right";
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="outline"
            size="xs"
            disabled={count === 0}
            onClick={onClick}
          />
        }
      >
        {direction === "left" && <ArrowRight className="rotate-180" />}
        {label}
        {count > 0 && (
          <span className="num text-muted-foreground">{count}</span>
        )}
        {direction === "right" && <ArrowRight />}
      </TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  );
}

/** Dashed outline over a pane that a drag would copy into. */
export function PaneDropHint({
  show,
  label,
}: {
  show: boolean;
  label: string;
}) {
  if (!show) return null;
  return (
    <div className="border-brand bg-brand/10 pointer-events-none absolute inset-1.5 z-30 flex items-end justify-center rounded-lg border-[1.5px] border-dashed pb-4">
      <span className="bg-popover text-small rounded-md border px-2.5 py-1 font-medium shadow-md">
        {label}
      </span>
    </div>
  );
}

function LocalPathBar({
  listing,
  path,
  places,
  searchRef,
  onUp,
}: {
  listing: LocalListing | undefined;
  path: string;
  places: LocalPlace[];
  searchRef: React.RefObject<HTMLInputElement | null>;
  onUp: () => void;
}) {
  const { t } = useTranslation("files");
  const go = useLocalBrowser((s) => s.go);
  const goBack = useLocalBrowser((s) => s.goBack);
  const canBack = useLocalBrowser((s) => s.back.length > 0);
  const query = useLocalBrowser((s) => s.query);
  const setQuery = useLocalBrowser((s) => s.setQuery);
  const placeLabel = useLocalPlaceLabel();
  const [editing, setEditing] = useState(false);
  const crumbs = listing?.crumbs ?? (path ? [{ name: path, path }] : []);

  return (
    <div className="flex flex-none items-center gap-2 border-b px-3.5 py-2.5">
      <Tip label={t("toolbar.back")} shortcut={`${modKey}[`}>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("toolbar.back")}
          disabled={!canBack}
          onClick={goBack}
        >
          <ChevronLeft />
        </Button>
      </Tip>
      <Tip label={t("toolbar.up")} shortcut={`${modKey}↑`}>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("toolbar.up")}
          disabled={!listing?.parent}
          onClick={onUp}
        >
          <ChevronUp />
        </Button>
      </Tip>
      {/* Favourites live in the side column; below 1080 px it is hidden. */}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("twoPane.places")}
              className="min-[1080px]:hidden"
            />
          }
        >
          <MapPin />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          {places.map((p) => {
            const Icon = LOCAL_PLACE_ICONS[p.key];
            return (
              <DropdownMenuItem key={p.path} onClick={() => go(p.path)}>
                <Icon />
                <span className="truncate">{placeLabel(p)}</span>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>

      {editing ? (
        <LocalPathInput
          path={path}
          onSubmit={async (value) => {
            setEditing(false);
            try {
              go(await resolveLocal(path, value));
            } catch {
              // An invalid path shows up as the listing error.
            }
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <nav
          aria-label={t("toolbar.path")}
          className="bg-sidebar text-small flex h-7 min-w-0 flex-[3_1_0%] items-center justify-end gap-0.5 overflow-hidden rounded-[7px] border px-1.5 font-mono"
        >
          {crumbs.map((part, i) => {
            const last = i === crumbs.length - 1;
            const isRoot = i === 0;
            return (
              <Fragment key={part.path}>
                {i > 1 && (
                  <span aria-hidden className="text-muted-foreground flex-none">
                    {part.path.includes("\\") ? "\\" : "/"}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => go(part.path)}
                  aria-current={last ? "location" : undefined}
                  title={part.path}
                  className={cn(
                    "hover:bg-accent hover:text-foreground focus-visible:outline-ring min-w-[3ch] truncate rounded-xs px-1 py-0.5 outline-none focus-visible:outline-2",
                    last
                      ? "text-foreground min-w-[4ch] shrink-[0.05]"
                      : isRoot
                        ? "text-secondary-foreground flex-none"
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
            onClick={() => setEditing(true)}
            aria-label={t("toolbar.editPath")}
            className="h-full min-w-4 flex-1 cursor-text outline-none"
          />
        </nav>
      )}

      <label className="border-input bg-background focus-within:border-ring text-muted-foreground flex h-7 max-w-[200px] min-w-24 flex-[2_1_0%] items-center gap-2 rounded-[7px] border px-2.5">
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
          placeholder={t("toolbar.search")}
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
    </div>
  );
}

function LocalPathInput({
  path,
  onSubmit,
  onCancel,
}: {
  path: string;
  onSubmit: (value: string) => void;
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
        if (e.key === "Enter") onSubmit(value);
        if (e.key === "Escape") onCancel();
      }}
      className="bg-background border-ring text-foreground text-small h-7 min-w-0 flex-[3_1_0%] rounded-[7px] border px-2.5 font-mono outline-none"
    />
  );
}

function Tip({
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

function LocalMenu({
  target,
  path,
  deviceFolder,
  onOpen,
  onCopy,
  onRefresh,
}: {
  target: FileEntry[];
  path: string;
  deviceFolder: string;
  onOpen: (entry: FileEntry) => void;
  onCopy: (entries: FileEntry[]) => void;
  onRefresh: () => void;
}) {
  const { t } = useTranslation("files");
  const single = target.length === 1 ? (target[0] as FileEntry) : null;
  const copy = (paths: string[]) =>
    navigator.clipboard
      .writeText(paths.join("\n"))
      .catch((e: unknown) => console.warn(errorText(e)));

  if (target.length === 0) {
    return (
      <ContextMenuContent className="w-60">
        <ContextMenuItem onClick={() => reveal(path)}>
          <FolderOpen />
          {t(`twoPane.reveal.${os}`)}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => void copy([path])}>
          <Copy />
          {t("actions.copyFolderPath")}
        </ContextMenuItem>
        <ContextMenuItem onClick={onRefresh}>
          <RefreshCw />
          {t("actions.refresh")}
        </ContextMenuItem>
      </ContextMenuContent>
    );
  }

  return (
    <ContextMenuContent className="w-60">
      <div className="text-muted-foreground text-caption truncate px-2 py-1">
        {single ? single.name : t("dialogs.items", { count: target.length })}
      </div>
      {single && isDirLike(single) && (
        <ContextMenuItem onClick={() => onOpen(single)}>
          <FolderOpen />
          {t("actions.open")}
        </ContextMenuItem>
      )}
      <ContextMenuItem onClick={() => onCopy(target)}>
        <Upload />
        <span className="truncate">
          {t("twoPane.copyToFolder", { name: deviceFolder })}
        </span>
      </ContextMenuItem>
      <ContextMenuSeparator />
      {single && (
        <ContextMenuItem onClick={() => reveal(single.path)}>
          <FolderOpen />
          {t(`twoPane.reveal.${os}`)}
        </ContextMenuItem>
      )}
      <ContextMenuItem onClick={() => void copy(target.map((e) => e.path))}>
        <Copy />
        {t("actions.copyPath")}
      </ContextMenuItem>
    </ContextMenuContent>
  );
}
