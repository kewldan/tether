import {
  Bookmark,
  Copy,
  Download,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Lock,
  Pencil,
  RefreshCw,
  SquareTerminal,
  Trash2,
  Upload,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { Kbd } from "@/components/ui/kbd";
import { modKey } from "@/lib/platform";

import { type FileEntry, isDirLike } from "../api";
import { basename } from "../paths";
import { useFilesPrefs } from "../store";
import type { FileActions } from "../useFileActions";
import type { FileDialog } from "./FileDialogs";

const isMacKey = modKey === "⌘";
const DELETE_KEY = isMacKey ? "⌫" : "Del";
const SHIFT = isMacKey ? "⇧" : "Shift+";

/** Context menu for the selection, or for the folder when empty. */
export function FileMenu({
  target,
  path,
  actions,
  onOpen,
  onDialog,
  copyTo,
}: {
  /** Two-pane mode: copy into the computer pane's folder. */
  copyTo?: { name: string; run: (entries: FileEntry[]) => void };
  /** Entries the menu acts on; empty → the current folder. */
  target: FileEntry[];
  path: string;
  actions: FileActions;
  onOpen: (entry: FileEntry) => void;
  onDialog: (dialog: FileDialog) => void;
}) {
  const { t } = useTranslation("files");
  const addBookmark = useFilesPrefs((s) => s.addBookmark);
  const single = target.length === 1 ? (target[0] as FileEntry) : null;

  if (target.length === 0) {
    return (
      <ContextMenuContent className="w-60">
        <ContextMenuItem onClick={() => onDialog({ type: "mkdir", dir: path })}>
          <FolderPlus />
          {t("actions.newFolder")}
          <Kbd className="ml-auto">{`${modKey}${SHIFT}N`}</Kbd>
        </ContextMenuItem>
        <ContextMenuItem onClick={() => void actions.pickAndUpload(false)}>
          <Upload />
          {t("actions.uploadFiles")}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => void actions.pickAndUpload(true)}>
          <Upload />
          {t("actions.uploadFolder")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => void actions.copyPath([path])}>
          <Copy />
          {t("actions.copyFolderPath")}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => actions.openInShell(null)}>
          <SquareTerminal />
          {t("actions.openInShell")}
        </ContextMenuItem>
        <ContextMenuItem
          onClick={() => addBookmark({ path, label: basename(path) })}
        >
          <Bookmark />
          {t("places.addBookmark")}
        </ContextMenuItem>
        <ContextMenuItem onClick={actions.refresh}>
          <RefreshCw />
          {t("actions.refresh")}
          <Kbd className="ml-auto">{`${modKey}R`}</Kbd>
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
          <Kbd className="ml-auto">↵</Kbd>
        </ContextMenuItem>
      )}
      {copyTo && (
        <ContextMenuItem onClick={() => copyTo.run(target)}>
          <Download />
          <span className="truncate">
            {t("twoPane.copyToFolder", { name: copyTo.name })}
          </span>
        </ContextMenuItem>
      )}
      <ContextMenuItem onClick={() => void actions.download(target)}>
        <Download />
        {t("actions.download")}
        <Kbd className="ml-auto">{`${modKey}S`}</Kbd>
      </ContextMenuItem>
      <ContextMenuItem onClick={() => void actions.downloadTo(target)}>
        <Download />
        {t("actions.downloadTo")}
      </ContextMenuItem>
      <ContextMenuItem
        disabled={!single}
        onClick={() => single && onDialog({ type: "rename", entry: single })}
      >
        <Pencil />
        {t("actions.rename")}
        <Kbd className="ml-auto">F2</Kbd>
      </ContextMenuItem>
      <ContextMenuItem
        onClick={() => onDialog({ type: "move", entries: target })}
      >
        <FolderInput />
        {t("actions.moveTo")}
      </ContextMenuItem>
      <ContextMenuItem
        onClick={() => void actions.copyPath(target.map((e) => e.path))}
      >
        <Copy />
        {t("actions.copyPath")}
        <Kbd className="ml-auto">{`${modKey}${SHIFT}C`}</Kbd>
      </ContextMenuItem>
      <ContextMenuItem onClick={() => actions.openInShell(single ?? null)}>
        <SquareTerminal />
        {t("actions.openInShell")}
      </ContextMenuItem>
      <ContextMenuItem
        onClick={() => onDialog({ type: "chmod", entries: target })}
      >
        <Lock />
        {t("actions.chmod")}
      </ContextMenuItem>
      <ContextMenuItem onClick={() => onDialog({ type: "mkdir", dir: path })}>
        <FolderPlus />
        {t("actions.newFolderHere")}
      </ContextMenuItem>
      {single && isDirLike(single) && (
        <ContextMenuItem
          onClick={() => addBookmark({ path: single.path, label: single.name })}
        >
          <Bookmark />
          {t("places.addBookmark")}
        </ContextMenuItem>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem
        variant="destructive"
        onClick={() => onDialog({ type: "delete", entries: target })}
      >
        <Trash2 />
        {t("actions.delete")}
        <Kbd className="ml-auto">{DELETE_KEY}</Kbd>
      </ContextMenuItem>
    </ContextMenuContent>
  );
}
