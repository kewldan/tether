import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { type FileEntry, isDirLike } from "../api";
import { extension } from "../format";
import { invalidName, isWithin, join, parent, resolve } from "../paths";
import type { FileActions } from "../useFileActions";
import { FolderTree } from "./FolderTree";

export type FileDialog =
  | { type: "mkdir"; dir: string }
  | { type: "rename"; entry: FileEntry }
  | { type: "delete"; entries: FileEntry[] }
  | { type: "chmod"; entries: FileEntry[] }
  | { type: "move"; entries: FileEntry[] };

export function FileDialogs({
  dialog,
  onClose,
  serial,
  deviceName,
  existing,
  actions,
}: {
  dialog: FileDialog | null;
  onClose: () => void;
  serial: string;
  deviceName: string;
  /** Names in the current folder, to catch clashes early. */
  existing: Set<string>;
  actions: FileActions;
}) {
  return (
    <>
      <NameDialog
        open={dialog?.type === "mkdir" || dialog?.type === "rename"}
        dialog={dialog}
        existing={existing}
        onClose={onClose}
        actions={actions}
      />
      <DeleteDialog
        entries={dialog?.type === "delete" ? dialog.entries : null}
        deviceName={deviceName}
        onClose={onClose}
        actions={actions}
      />
      <ChmodDialog
        entries={dialog?.type === "chmod" ? dialog.entries : null}
        onClose={onClose}
        actions={actions}
      />
      <MoveDialog
        serial={serial}
        entries={dialog?.type === "move" ? dialog.entries : null}
        onClose={onClose}
        actions={actions}
      />
    </>
  );
}

function NameDialog({
  open,
  dialog,
  existing,
  onClose,
  actions,
}: {
  open: boolean;
  dialog: FileDialog | null;
  existing: Set<string>;
  onClose: () => void;
  actions: FileActions;
}) {
  const { t } = useTranslation("files");
  const rename = dialog?.type === "rename" ? dialog.entry : null;
  const dir =
    dialog?.type === "mkdir" ? dialog.dir : rename ? parent(rename.path) : "/";
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setValue(rename ? rename.name : t("dialogs.newFolderName"));
    setBusy(false);
    // Select the name without its extension, like Finder.
    requestAnimationFrame(() => {
      const input = ref.current;
      if (!input) return;
      input.focus();
      const ext = rename && !isDirLike(rename) ? extension(rename.name) : "";
      const end = ext
        ? input.value.length - ext.length - 1
        : input.value.length;
      input.setSelectionRange(0, Math.max(0, end));
    });
  }, [open, rename, t]);

  const name = value.trim();
  // A name with "/" moves the entry (relative to its folder or absolute).
  const target = name.includes("/") ? resolve(dir, name) : join(dir, name);
  const unchanged = rename !== null && name === rename.name;
  const clash = !unchanged && !name.includes("/") && existing.has(name);
  const invalid = invalidName(name);
  const error = invalid ? null : clash ? t("dialogs.exists", { name }) : null;

  const submit = async () => {
    if (invalid || clash || busy) return;
    if (unchanged) return onClose();
    setBusy(true);
    const ok = rename
      ? await actions.rename(rename, target)
      : await actions.mkdir(dir, name);
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {rename ? t("dialogs.renameTitle") : t("dialogs.newFolderTitle")}
            </DialogTitle>
            <DialogDescription className="text-small font-mono break-all">
              {dir}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Input
              ref={ref}
              value={value}
              spellCheck={false}
              aria-invalid={error !== null}
              aria-label={t("dialogs.name")}
              onChange={(e) => setValue(e.target.value)}
            />
            {error && <p className="text-error text-small">{error}</p>}
            {rename && name.includes("/") && !invalid && (
              <p className="text-muted-foreground text-small break-all">
                {t("dialogs.moveHint", { path: target })}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t("common:actions.cancel")}
            </Button>
            <Button type="submit" disabled={invalid || clash || busy}>
              {rename ? t("dialogs.rename") : t("dialogs.create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDialog({
  entries,
  deviceName,
  onClose,
  actions,
}: {
  entries: FileEntry[] | null;
  deviceName: string;
  onClose: () => void;
  actions: FileActions;
}) {
  const { t } = useTranslation("files");
  const [busy, setBusy] = useState(false);
  const list = entries ?? [];
  const first = list[0];
  const folders = list.filter(isDirLike).length;

  return (
    <AlertDialog open={entries !== null} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {list.length === 1 && first
              ? t("dialogs.deleteOne", { name: first.name })
              : t("dialogs.deleteMany", { count: list.length })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t(
              folders > 0 ? "dialogs.deleteBodyFolders" : "dialogs.deleteBody",
              {
                device: deviceName,
              },
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {list.length > 1 && (
          <ul className="bg-sidebar text-small max-h-32 overflow-y-auto rounded-md px-3 py-2 font-mono">
            {list.slice(0, 50).map((e) => (
              <li key={e.path} className="truncate">
                {e.name}
                {isDirLike(e) && "/"}
              </li>
            ))}
            {list.length > 50 && (
              <li className="text-muted-foreground">
                {t("dialogs.andMore", { count: list.length - 50 })}
              </li>
            )}
          </ul>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common:actions.cancel")}</AlertDialogCancel>
          <Button
            variant="destructive"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await actions.remove(list);
              setBusy(false);
              onClose();
            }}
          >
            {t("actions.delete")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

const WHO = ["owner", "group", "others"] as const;
const WHAT = [
  { key: "read", bit: 4 },
  { key: "write", bit: 2 },
  { key: "execute", bit: 1 },
] as const;

function ChmodDialog({
  entries,
  onClose,
  actions,
}: {
  entries: FileEntry[] | null;
  onClose: () => void;
  actions: FileActions;
}) {
  const { t } = useTranslation("files");
  const [mode, setMode] = useState(0o644);
  const [text, setText] = useState("644");
  const [recursive, setRecursive] = useState(false);
  const [busy, setBusy] = useState(false);
  const hasDir = useMemo(() => (entries ?? []).some(isDirLike), [entries]);

  useEffect(() => {
    if (!entries?.[0]) return;
    const m = entries[0].mode & 0o7777;
    setMode(m);
    setText(m.toString(8).padStart(3, "0"));
    setRecursive(false);
    setBusy(false);
  }, [entries]);

  const setBits = (m: number) => {
    setMode(m);
    setText(m.toString(8).padStart(3, "0"));
  };
  const valid = /^[0-7]{3,4}$/.test(text);
  const list = entries ?? [];

  return (
    <Dialog open={entries !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("dialogs.chmodTitle")}</DialogTitle>
          <DialogDescription className="break-all">
            {list.length === 1
              ? list[0]?.name
              : t("dialogs.items", { count: list.length })}
          </DialogDescription>
        </DialogHeader>
        <div className="text-small grid grid-cols-[80px_repeat(3,minmax(0,1fr))] items-center gap-y-2">
          <span />
          {WHAT.map((w) => (
            <span key={w.key} className="text-muted-foreground text-center">
              {t(`dialogs.${w.key}`)}
            </span>
          ))}
          {WHO.map((who, i) => {
            const shift = (2 - i) * 3;
            return (
              <div key={who} className="contents">
                <span className="text-secondary-foreground">
                  {t(`dialogs.${who}`)}
                </span>
                {WHAT.map((w) => {
                  const bit = w.bit << shift;
                  return (
                    <span key={w.key} className="flex justify-center">
                      <Checkbox
                        aria-label={`${t(`dialogs.${who}`)} ${t(`dialogs.${w.key}`)}`}
                        checked={(mode & bit) !== 0}
                        onCheckedChange={(on) =>
                          setBits(on ? mode | bit : mode & ~bit)
                        }
                      />
                    </span>
                  );
                })}
              </div>
            );
          })}
        </div>
        <div className="flex items-center gap-3">
          <Label
            htmlFor="chmod-octal"
            className="text-secondary-foreground text-small"
          >
            {t("dialogs.octal")}
          </Label>
          <Input
            id="chmod-octal"
            value={text}
            maxLength={4}
            aria-invalid={!valid}
            onChange={(e) => {
              setText(e.target.value);
              if (/^[0-7]{3,4}$/.test(e.target.value))
                setMode(Number.parseInt(e.target.value, 8));
            }}
            className="w-20 font-mono"
          />
          {hasDir && (
            <Label className="text-secondary-foreground text-small ml-auto gap-2 font-normal">
              <Checkbox checked={recursive} onCheckedChange={setRecursive} />
              {t("dialogs.recursive")}
            </Label>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("common:actions.cancel")}
          </Button>
          <Button
            disabled={!valid || busy}
            onClick={async () => {
              setBusy(true);
              const ok = await actions.chmod(list, text, recursive);
              setBusy(false);
              if (ok) onClose();
            }}
          >
            {t("dialogs.apply")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MoveDialog({
  serial,
  entries,
  onClose,
  actions,
}: {
  serial: string;
  entries: FileEntry[] | null;
  onClose: () => void;
  actions: FileActions;
}) {
  const { t } = useTranslation("files");
  const [target, setTarget] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const list = entries ?? [];

  useEffect(() => {
    if (entries?.[0]) setTarget(parent(entries[0].path));
    setBusy(false);
  }, [entries]);

  const invalid =
    target === null ||
    list.some((e) => isWithin(target, e.path) || parent(e.path) === target);

  return (
    <Dialog open={entries !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {list.length === 1
              ? t("dialogs.moveOne", { name: list[0]?.name })
              : t("dialogs.moveMany", { count: list.length })}
          </DialogTitle>
          <DialogDescription className="text-small font-mono break-all">
            {target}
          </DialogDescription>
        </DialogHeader>
        <div className="bg-card h-72 overflow-y-auto rounded-lg border p-2">
          <FolderTree serial={serial} selected={target} onSelect={setTarget} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("common:actions.cancel")}
          </Button>
          <Button
            disabled={invalid || busy}
            onClick={async () => {
              if (!target) return;
              setBusy(true);
              const ok = await actions.move(list, target);
              setBusy(false);
              if (ok) onClose();
            }}
          >
            {t("dialogs.moveHere")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
