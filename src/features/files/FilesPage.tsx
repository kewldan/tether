import { Ellipsis, FolderPlus, Smartphone, Upload } from "lucide-react";
import {
  type KeyboardEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { useNavigation } from "@/app/navigation";
import { Page } from "@/components/layout/Page";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { deviceName } from "@/features/devices/naming";
import { useDeviceInfo } from "@/features/devices/queries";
import { useReadySerial, useSelectedDevice } from "@/features/devices/store";
import { hasMod } from "@/lib/platform";

import { type FileEntry, isDirLike } from "./api";
import { DropOverlay } from "./components/DropOverlay";
import { type FileDialog, FileDialogs } from "./components/FileDialogs";
import { FileGrid } from "./components/FileGrid";
import { FileMenu } from "./components/FileMenu";
import { FileTable } from "./components/FileTable";
import { ListState } from "./components/ListState";
import { PathBar } from "./components/PathBar";
import { Places } from "./components/Places";
import { PreviewPanel } from "./components/PreviewPanel";
import { TransferQueue } from "./components/TransferQueue";
import { visibleEntries } from "./model";
import { basename, parent } from "./paths";
import { useListing } from "./queries";
import { HOME, useBrowser, useFilesPrefs } from "./store";
import { onTransferFinished } from "./transfers";
import { useDropUpload } from "./useDropUpload";
import { useFileActions } from "./useFileActions";

export default function FilesPage() {
  const { t } = useTranslation("files");
  const serial = useReadySerial();
  const device = useSelectedDevice();

  if (!serial) {
    return (
      <Page title={t("common:nav.files")}>
        <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-3 text-center">
          <Smartphone className="size-8" aria-hidden />
          <p className="text-foreground font-medium">
            {device ? t("noDevice.notReady") : t("noDevice.title")}
          </p>
          <p className="text-small max-w-sm">{t("noDevice.body")}</p>
        </div>
      </Page>
    );
  }
  return <FilesBrowser key={serial} serial={serial} />;
}

function FilesBrowser({ serial }: { serial: string }) {
  const { t } = useTranslation("files");
  const device = useSelectedDevice();
  const { data: info } = useDeviceInfo(serial);
  const name = device ? deviceName(device, info) : serial;
  const navParams = useNavigation((s) => s.params);

  const path = useBrowser((s) => s.path);
  const go = useBrowser((s) => s.go);
  const selected = useBrowser((s) => s.selected);
  const anchor = useBrowser((s) => s.anchor);
  const setSelected = useBrowser((s) => s.setSelected);
  const query = useBrowser((s) => s.query);
  const showHidden = useFilesPrefs((s) => s.showHidden);
  const sort = useFilesPrefs((s) => s.sort);
  const view = useFilesPrefs((s) => s.view);
  const downloadDir = useFilesPrefs((s) => s.downloadDir);

  const actions = useFileActions(serial);
  const [dialog, setDialog] = useState<FileDialog | null>(null);
  const [menuTarget, setMenuTarget] = useState<FileEntry[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Start where the user left off on this device, or where another page
  // pointed us (`navigate("files", { path })`).
  useEffect(() => {
    const prefs = useFilesPrefs.getState();
    useBrowser
      .getState()
      .reset(navParams.path ?? prefs.lastPath[serial] ?? HOME);
  }, [serial, navParams.path]);
  useEffect(
    () =>
      useBrowser.subscribe((s, prev) => {
        if (s.path !== prev.path)
          useFilesPrefs.getState().rememberPath(serial, s.path);
      }),
    [serial],
  );

  const listing = useListing(serial, path);
  const all = listing.data?.entries ?? [];
  const entries = useMemo(
    () => visibleEntries(all, { showHidden, query, sort }),
    [all, showHidden, query, sort],
  );
  const selection = useMemo(
    () => entries.filter((e) => selected.has(e.path)),
    [entries, selected],
  );
  const existing = useMemo(() => new Set(all.map((e) => e.name)), [all]);

  // Refresh after uploads into this device finish.
  const refresh = actions.refresh;
  useEffect(
    () =>
      onTransferFinished((tr) => {
        if (tr.serial === serial && tr.direction === "push") refresh();
      }),
    [serial, refresh],
  );

  const drop = useDropUpload(dialog === null, (paths) =>
    actions.upload(paths, path),
  );

  const open = useCallback(
    (entry: FileEntry) => {
      if (isDirLike(entry)) go(entry.path);
      else void actions.download([entry]);
    },
    [go, actions],
  );

  const select = useCallback(
    (paths: string[], cursor: string | null) =>
      setSelected(new Set(paths), cursor),
    [setSelected],
  );

  const onRowClick = useCallback(
    (entry: FileEntry, e: MouseEvent) => {
      if (e.shiftKey && anchor) {
        const a = entries.findIndex((x) => x.path === anchor);
        const b = entries.findIndex((x) => x.path === entry.path);
        if (a >= 0 && b >= 0) {
          const [from, to] = a < b ? [a, b] : [b, a];
          setSelected(
            new Set(entries.slice(from, to + 1).map((x) => x.path)),
            anchor,
          );
          return;
        }
      }
      if (e.metaKey || e.ctrlKey) {
        const next = new Set(selected);
        if (next.has(entry.path)) next.delete(entry.path);
        else next.add(entry.path);
        setSelected(next, entry.path);
        return;
      }
      select([entry.path], entry.path);
    },
    [anchor, entries, selected, select, setSelected],
  );

  const onToggle = useCallback(
    (entry: FileEntry) => {
      const next = new Set(selected);
      if (next.has(entry.path)) next.delete(entry.path);
      else next.add(entry.path);
      setSelected(next, entry.path);
    },
    [selected, setSelected],
  );

  const onToggleAll = useCallback(() => {
    if (selection.length === entries.length) select([], null);
    else
      select(
        entries.map((e) => e.path),
        anchor,
      );
  }, [selection.length, entries, select, anchor]);

  // Shortcuts that work anywhere on the page (not while typing or in a
  // dialog).
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (dialog) return;
      const el = e.target as HTMLElement | null;
      if (el?.closest("input, textarea, [role=dialog], [role=menu]")) return;
      const key = e.key.toLowerCase();
      const mod = hasMod(e);
      const target = selection;
      if (mod && !e.shiftKey && key === "s") {
        e.preventDefault();
        if (target.length > 0) void actions.download(target);
      } else if (mod && e.shiftKey && key === "c") {
        e.preventDefault();
        void actions.copyPath(
          target.length ? target.map((x) => x.path) : [path],
        );
      } else if (mod && e.shiftKey && key === "n") {
        e.preventDefault();
        setDialog({ type: "mkdir", dir: path });
      } else if (mod && key === "r") {
        e.preventDefault();
        actions.refresh();
      } else if (mod && key === "f") {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (mod && key === "[") {
        e.preventDefault();
        useBrowser.getState().goBack();
      } else if (mod && key === "]") {
        e.preventDefault();
        useBrowser.getState().goForward();
      } else if ((mod || e.altKey) && e.key === "ArrowUp") {
        e.preventDefault();
        go(parent(path));
      } else if (mod && e.shiftKey && key === ".") {
        e.preventDefault();
        useFilesPrefs.getState().toggleHidden();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dialog, selection, actions, path, go]);

  // List navigation, only while the list has focus.
  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (hasMod(e) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      select(
        entries.map((x) => x.path),
        anchor,
      );
      return;
    }
    const index = anchor ? entries.findIndex((x) => x.path === anchor) : -1;
    const moveTo = (i: number) => {
      const next = entries[Math.max(0, Math.min(entries.length - 1, i))];
      if (!next) return;
      e.preventDefault();
      if (e.shiftKey && anchor) {
        const sel = new Set(selected);
        sel.add(next.path);
        setSelected(sel, next.path);
      } else {
        select([next.path], next.path);
      }
    };
    switch (e.key) {
      case "ArrowDown":
        if (hasMod(e) && selection[0]) {
          e.preventDefault();
          open(selection[0]);
        } else moveTo(index + 1);
        break;
      case "ArrowUp":
        if (!hasMod(e) && !e.altKey) moveTo(index < 0 ? 0 : index - 1);
        break;
      case "ArrowRight":
        if (view === "grid") moveTo(index + 1);
        break;
      case "ArrowLeft":
        if (view === "grid") moveTo(index - 1);
        break;
      case "Home":
        moveTo(0);
        break;
      case "End":
        moveTo(entries.length - 1);
        break;
      case "Enter":
        if (selection.length === 1 && selection[0]) {
          e.preventDefault();
          open(selection[0]);
        } else if (selection.length > 1) {
          e.preventDefault();
          void actions.download(selection);
        }
        break;
      case "Backspace":
      case "Delete":
        if (selection.length > 0) {
          e.preventDefault();
          setDialog({ type: "delete", entries: selection });
        }
        break;
      case "F2":
        if (selection.length === 1 && selection[0]) {
          e.preventDefault();
          setDialog({ type: "rename", entry: selection[0] });
        }
        break;
      case "Escape":
        if (selected.size > 0) {
          e.preventDefault();
          select([], null);
        }
        break;
    }
  };

  const onContextMenuCapture = (e: MouseEvent<HTMLDivElement>) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>("[data-path]");
    const rowPath = row?.dataset.path;
    if (!rowPath) {
      select([], null);
      setMenuTarget([]);
      return;
    }
    if (selected.has(rowPath)) {
      setMenuTarget(selection);
    } else {
      const entry = entries.find((x) => x.path === rowPath);
      select([rowPath], rowPath);
      setMenuTarget(entry ? [entry] : []);
    }
  };

  const listProps = {
    entries,
    selected,
    focused: anchor,
    scrollRef,
    onRowClick,
    onToggle,
    onToggleAll,
    onOpen: open,
  };

  const body = listing.isPending ? (
    <ListState kind="loading" />
  ) : listing.error ? (
    <ListState
      kind="error"
      error={listing.error}
      onRetry={() => void listing.refetch()}
      onHome={() => go(HOME)}
    />
  ) : listing.data?.denied ? (
    <ListState kind="denied" path={path} onUp={() => go(parent(path))} />
  ) : all.length === 0 ? (
    <ListState
      kind="empty"
      onUpload={() => void actions.pickAndUpload(false)}
    />
  ) : entries.length === 0 ? (
    <ListState
      kind="noMatches"
      query={query}
      hiddenCount={all.length}
      onClear={() => useBrowser.getState().setQuery("")}
      onShowHidden={
        showHidden ? undefined : useFilesPrefs.getState().toggleHidden
      }
    />
  ) : view === "grid" ? (
    <FileGrid {...listProps} serial={serial} />
  ) : (
    <FileTable {...listProps} />
  );

  return (
    <Page
      title={t("common:nav.files")}
      parent={{ label: name }}
      body="fill"
      actions={
        <>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setDialog({ type: "mkdir", dir: path })}
          >
            <FolderPlus />
            {t("actions.newFolder")}
          </Button>
          <Button size="sm" onClick={() => void actions.pickAndUpload(false)}>
            <Upload />
            {t("actions.upload")}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("actions.more")}
                />
              }
            >
              <Ellipsis />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuItem
                onClick={() => void actions.pickAndUpload(true)}
              >
                {t("actions.uploadFolder")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => void actions.chooseDownloadDir()}
              >
                <span className="flex min-w-0 flex-col">
                  {t("actions.downloadFolder")}
                  <span className="text-muted-foreground text-caption truncate font-mono">
                    {downloadDir ?? t("actions.downloadFolderDefault")}
                  </span>
                </span>
              </DropdownMenuItem>
              {downloadDir && (
                <DropdownMenuItem
                  onClick={() => useFilesPrefs.getState().setDownloadDir(null)}
                >
                  {t("actions.downloadFolderReset")}
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuCheckboxItem
                checked={showHidden}
                onCheckedChange={() => useFilesPrefs.getState().toggleHidden()}
              >
                {t("actions.showHidden")}
              </DropdownMenuCheckboxItem>
              <DropdownMenuItem onClick={actions.refresh}>
                {t("actions.refresh")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      }
    >
      <div className="flex min-h-0 flex-1">
        <Places serial={serial} />

        <div className="relative flex min-w-0 flex-1 flex-col">
          <PathBar searchRef={searchRef} />
          <div className="relative min-h-0 flex-1">
            <ContextMenu>
              <ContextMenuTrigger
                ref={scrollRef}
                tabIndex={0}
                aria-label={t("list.label", { name: basename(path) })}
                onKeyDown={onListKey}
                onContextMenuCapture={onContextMenuCapture}
                onClick={(e: MouseEvent<HTMLDivElement>) => {
                  if (!(e.target as HTMLElement).closest("[data-path]"))
                    select([], null);
                }}
                className="focus-visible:outline-ring absolute inset-0 overflow-auto outline-none focus-visible:outline-1 focus-visible:-outline-offset-1"
              >
                {body}
              </ContextMenuTrigger>
              <FileMenu
                target={menuTarget}
                path={path}
                actions={actions}
                onOpen={open}
                onDialog={setDialog}
              />
            </ContextMenu>
            <DropOverlay drop={drop} path={path} />
          </div>
          <TransferQueue serial={serial} onShowFolder={go} />
        </div>

        <PreviewPanel
          serial={serial}
          folderName={basename(path)}
          entries={all}
          selection={selection}
          actions={actions}
          onOpen={open}
          onDelete={(list) => setDialog({ type: "delete", entries: list })}
        />
      </div>

      <FileDialogs
        dialog={dialog}
        onClose={() => setDialog(null)}
        serial={serial}
        deviceName={name}
        existing={existing}
        actions={actions}
      />
    </Page>
  );
}
