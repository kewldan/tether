import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { useNavigation } from "@/app/navigation";
import type { AppError } from "@/lib/tauri";

import {
  chmodPaths,
  defaultDownloadDir,
  deletePaths,
  type FileEntry,
  isDirLike,
  makeDir,
  renamePath,
} from "./api";
import { join, parent } from "./paths";
import { useRefreshFiles } from "./queries";
import { useBrowser, useFilesPrefs } from "./store";
import { useTransfers } from "./transfers";

export function errorText(error: unknown): string {
  const e = error as Partial<AppError> | undefined;
  return e?.message ?? String(error);
}

async function pickFolder(title: string): Promise<string | null> {
  const picked = await open({ directory: true, multiple: false, title });
  return typeof picked === "string" ? picked : null;
}

/** Everything the toolbar, menus, keyboard and preview panel can do. */
export function useFileActions(serial: string) {
  const { t } = useTranslation("files");
  const refresh = useRefreshFiles(serial);
  const enqueue = useTransfers((s) => s.enqueue);
  const navigate = useNavigation((s) => s.navigate);

  const downloadDir = useCallback(async () => {
    const chosen = useFilesPrefs.getState().downloadDir;
    return chosen ?? (await defaultDownloadDir());
  }, []);

  const download = useCallback(
    async (entries: FileEntry[], target?: string) => {
      if (entries.length === 0) return;
      const dir = target ?? (await downloadDir());
      enqueue({
        serial,
        direction: "pull",
        sources: entries.map((e) => e.path),
        target: dir,
      });
    },
    [downloadDir, enqueue, serial],
  );

  const downloadTo = useCallback(
    async (entries: FileEntry[]) => {
      const dir = await pickFolder(t("dialogs.downloadTo"));
      if (dir) await download(entries, dir);
    },
    [download, t],
  );

  const upload = useCallback(
    (localPaths: string[], remoteDir?: string) => {
      if (localPaths.length === 0) return;
      enqueue({
        serial,
        direction: "push",
        sources: localPaths,
        target: remoteDir ?? useBrowser.getState().path,
      });
    },
    [enqueue, serial],
  );

  const pickAndUpload = useCallback(
    async (folders: boolean) => {
      const picked = await open({
        multiple: true,
        directory: folders,
        title: folders ? t("dialogs.uploadFolders") : t("dialogs.uploadFiles"),
      });
      const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
      upload(paths);
    },
    [t, upload],
  );

  const chooseDownloadDir = useCallback(async () => {
    const dir = await pickFolder(t("dialogs.downloadFolder"));
    if (dir) useFilesPrefs.getState().setDownloadDir(dir);
  }, [t]);

  const copyPath = useCallback(
    async (paths: string[]) => {
      try {
        await navigator.clipboard.writeText(paths.join("\n"));
        toast.success(
          paths.length === 1
            ? t("toast.pathCopied")
            : t("toast.pathsCopied", { count: paths.length }),
        );
      } catch (e) {
        toast.error(errorText(e));
      }
    },
    [t],
  );

  const openInShell = useCallback(
    (entry: FileEntry | null) => {
      const cwd = entry
        ? isDirLike(entry)
          ? entry.path
          : parent(entry.path)
        : useBrowser.getState().path;
      navigate("shell", { cwd });
    },
    [navigate],
  );

  const run = useCallback(
    async (op: () => Promise<void>, success: string) => {
      try {
        await op();
        toast.success(success);
        return true;
      } catch (e) {
        toast.error(errorText(e), {
          description: (e as Partial<AppError>)?.hint ?? undefined,
        });
        return false;
      } finally {
        refresh();
      }
    },
    [refresh],
  );

  const mkdir = useCallback(
    (dir: string, name: string) =>
      run(
        () => makeDir(serial, join(dir, name)),
        t("toast.folderCreated", { name }),
      ),
    [run, serial, t],
  );

  const rename = useCallback(
    (entry: FileEntry, to: string) =>
      run(() => renamePath(serial, entry.path, to), t("toast.renamed")),
    [run, serial, t],
  );

  const move = useCallback(
    async (entries: FileEntry[], dir: string) => {
      const op = async () => {
        for (const e of entries)
          await renamePath(serial, e.path, join(dir, e.name));
      };
      return run(op, t("toast.moved", { count: entries.length }));
    },
    [run, serial, t],
  );

  const remove = useCallback(
    (entries: FileEntry[]) =>
      run(
        () =>
          deletePaths(
            serial,
            entries.map((e) => e.path),
          ),
        t("toast.deleted", { count: entries.length }),
      ),
    [run, serial, t],
  );

  const chmod = useCallback(
    (entries: FileEntry[], mode: string, recursive: boolean) =>
      run(
        () =>
          chmodPaths(
            serial,
            entries.map((e) => e.path),
            mode,
            recursive,
          ),
        t("toast.permissionsChanged"),
      ),
    [run, serial, t],
  );

  return useMemo(
    () => ({
      download,
      downloadTo,
      upload,
      pickAndUpload,
      chooseDownloadDir,
      copyPath,
      openInShell,
      mkdir,
      rename,
      move,
      remove,
      chmod,
      refresh,
    }),
    [
      download,
      downloadTo,
      upload,
      pickAndUpload,
      chooseDownloadDir,
      copyPath,
      openInShell,
      mkdir,
      rename,
      move,
      remove,
      chmod,
      refresh,
    ],
  );
}

export type FileActions = ReturnType<typeof useFileActions>;
