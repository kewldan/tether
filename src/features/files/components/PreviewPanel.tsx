import type { TFunction } from "i18next";
import { Copy, Download, FolderOpen, Loader2, Trash2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { type FileEntry, type ImageDetails, isDirLike } from "../api";
import {
  categoryOf,
  extension,
  formatBytes,
  formatCoordinates,
  formatExposure,
  formatFullDate,
  formatTaken,
  imageMime,
  trimNumber,
} from "../format";
import { totalSize } from "../model";
import { useExif, usePreview } from "../queries";
import type { FileActions } from "../useFileActions";
import { FileIcon } from "./FileIcon";

/** 300 px right column: preview + facts for the selection. */
export function PreviewPanel({
  serial,
  folderName,
  entries,
  selection,
  actions,
  onOpen,
  onDelete,
  split = false,
}: {
  /** Two-pane mode: the panes need the room, so it shows only when wide. */
  split?: boolean;
  serial: string;
  folderName: string;
  /** All entries of the folder (for the summary). */
  entries: FileEntry[];
  selection: FileEntry[];
  actions: FileActions;
  onOpen: (entry: FileEntry) => void;
  onDelete: (entries: FileEntry[]) => void;
}) {
  return (
    <aside
      aria-label="Preview"
      className={cn(
        "hidden w-[300px] flex-none flex-col overflow-y-auto border-l p-3.5",
        split ? "min-[1680px]:flex" : "min-[1200px]:flex",
      )}
    >
      {selection.length === 1 ? (
        <Single
          serial={serial}
          entry={selection[0] as FileEntry}
          actions={actions}
          onOpen={onOpen}
          onDelete={onDelete}
        />
      ) : selection.length > 1 ? (
        <Multiple selection={selection} actions={actions} onDelete={onDelete} />
      ) : (
        <FolderSummary name={folderName} entries={entries} />
      )}
    </aside>
  );
}

function Single({
  serial,
  entry,
  actions,
  onOpen,
  onDelete,
}: {
  serial: string;
  entry: FileEntry;
  actions: FileActions;
  onOpen: (entry: FileEntry) => void;
  onDelete: (entries: FileEntry[]) => void;
}) {
  const { t, i18n } = useTranslation("files");
  const dir = isDirLike(entry);
  const { data: preview, isLoading } = usePreview(serial, dir ? null : entry);
  const { data: exif } = useExif(serial, dir ? null : entry);
  const [dims, setDims] = useState<{
    path: string;
    w: number;
    h: number;
  } | null>(null);
  const size = dims?.path === entry.path ? dims : null;

  return (
    <div className="flex flex-col gap-3">
      <div className="bg-sidebar flex aspect-[4/3] items-center justify-center overflow-hidden rounded-lg">
        {preview?.type === "image" ? (
          <img
            src={preview.url}
            alt={entry.name}
            draggable={false}
            onLoad={(e) =>
              setDims({
                path: entry.path,
                w: e.currentTarget.naturalWidth,
                h: e.currentTarget.naturalHeight,
              })
            }
            className="size-full object-contain"
          />
        ) : preview?.type === "text" ? (
          <pre className="selectable text-secondary-foreground text-caption size-full overflow-auto p-2.5 font-mono leading-4 break-all whitespace-pre-wrap">
            {preview.text}
            {preview.truncated && (
              <span className="text-muted-foreground block pt-1">
                {t("preview.truncated")}
              </span>
            )}
          </pre>
        ) : isLoading ? (
          <Loader2
            className="text-muted-foreground size-5 animate-spin"
            aria-label={t("preview.loading")}
          />
        ) : (
          <FileIcon entry={entry} className="size-12" />
        )}
      </div>

      <div>
        <div className="selectable font-semibold break-all">{entry.name}</div>
        <div className="text-muted-foreground text-small">
          {describe(entry, t)}
        </div>
      </div>

      <dl className="text-small grid grid-cols-[90px_minmax(0,1fr)] gap-x-2.5 gap-y-[5px]">
        {size ? (
          <Fact label={t("preview.dimensions")}>
            <span className="num">
              {size.w} × {size.h}
            </span>
          </Fact>
        ) : exif?.width && exif.height ? (
          <Fact label={t("preview.dimensions")}>
            <span className="num">
              {exif.width} × {exif.height}
            </span>
          </Fact>
        ) : null}
        {exif && <ExifFacts exif={exif} />}
        <Fact label={t("preview.modified")}>
          <span className="num">
            {formatFullDate(entry.mtime, i18n.language)}
          </span>
        </Fact>
        {entry.owner && (
          <Fact label={t("preview.owner")}>
            <span className="font-mono">
              {entry.owner} {entry.group}
            </span>
          </Fact>
        )}
        <Fact label={t("preview.permissions")}>
          <span className="font-mono">{entry.permissions}</span>
        </Fact>
        <Fact label={t("preview.path")}>
          <span
            className="selectable block truncate font-mono"
            style={{ direction: "rtl", textAlign: "left" }}
            title={entry.path}
          >
            <bdi>{entry.path}</bdi>
          </span>
        </Fact>
      </dl>

      <div className="flex items-center gap-2">
        {dir ? (
          <Button
            variant="outline"
            size="sm"
            className="flex-1"
            onClick={() => onOpen(entry)}
          >
            <FolderOpen />
            {t("actions.open")}
          </Button>
        ) : null}
        <Button
          variant="outline"
          size="sm"
          className="flex-1"
          onClick={() => void actions.download([entry])}
        >
          <Download />
          {t("actions.download")}
        </Button>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label={t("actions.copyPath")}
          onClick={() => void actions.copyPath([entry.path])}
        >
          <Copy />
        </Button>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label={t("actions.delete")}
          onClick={() => onDelete([entry])}
        >
          <Trash2 />
        </Button>
      </div>
    </div>
  );
}

function describe(entry: FileEntry, t: TFunction<"files">) {
  if (isDirLike(entry)) {
    return entry.kind === "symlink" ? t("kind.folderLink") : t("kind.folder");
  }
  if (entry.kind === "symlink") return t("kind.link");
  const category = categoryOf(entry);
  const ext = extension(entry.name).toUpperCase();
  const type =
    category === "image" && imageMime(entry.name)
      ? t("kind.image", { ext })
      : ext
        ? t(`kind.${category}`, { ext })
        : t("kind.file");
  return `${type} · ${formatBytes(entry.size)}`;
}

function Multiple({
  selection,
  actions,
  onDelete,
}: {
  selection: FileEntry[];
  actions: FileActions;
  onDelete: (entries: FileEntry[]) => void;
}) {
  const { t } = useTranslation("files");
  const folders = selection.filter(isDirLike).length;
  return (
    <div className="flex flex-col gap-3">
      <div className="bg-sidebar relative flex aspect-[4/3] items-center justify-center rounded-lg">
        {selection.slice(0, 3).map((e, i) => (
          <div
            key={e.path}
            className="bg-card absolute flex size-20 items-center justify-center rounded-lg border shadow-sm"
            style={{
              transform: `translate(${(i - 1) * 18}px, ${(i - 1) * -6}px) rotate(${(i - 1) * 6}deg)`,
            }}
          >
            <FileIcon entry={e} className="size-8" />
          </div>
        ))}
      </div>
      <div>
        <div className="font-semibold">
          {t("preview.selected", { count: selection.length })}
        </div>
        <div className="text-muted-foreground text-small">
          {folders > 0
            ? t("preview.selectedWithFolders", {
                size: formatBytes(totalSize(selection)),
                count: folders,
              })
            : formatBytes(totalSize(selection))}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="flex-1"
          onClick={() => void actions.download(selection)}
        >
          <Download />
          {t("actions.downloadCount", { count: selection.length })}
        </Button>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label={t("actions.copyPath")}
          onClick={() => void actions.copyPath(selection.map((e) => e.path))}
        >
          <Copy />
        </Button>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label={t("actions.delete")}
          onClick={() => onDelete(selection)}
        >
          <Trash2 />
        </Button>
      </div>
    </div>
  );
}

function FolderSummary({
  name,
  entries,
}: {
  name: string;
  entries: FileEntry[];
}) {
  const { t } = useTranslation("files");
  const folders = entries.filter(isDirLike).length;
  const files = entries.length - folders;
  return (
    <div className="flex flex-col gap-3">
      <div className="bg-sidebar flex aspect-[4/3] items-center justify-center rounded-lg">
        <FileIcon
          entry={{ name, kind: "dir", linkToDir: false }}
          className="size-12"
        />
      </div>
      <div>
        <div className="font-semibold break-all">{name}</div>
        <div className="text-muted-foreground text-small">
          {t("preview.summary", {
            folders: t("preview.folders", { count: folders }),
            files: t("preview.files", { count: files }),
          })}
          {files > 0 && ` · ${formatBytes(totalSize(entries))}`}
        </div>
      </div>
      <p className="text-muted-foreground text-small">{t("preview.hint")}</p>
    </div>
  );
}

/** "Google Pixel 8 Pro", without repeating a make the model already has. */
function cameraName(exif: ImageDetails): string | null {
  const { make, model } = exif;
  if (!model) return make;
  if (!make || model.toLowerCase().startsWith(make.toLowerCase())) return model;
  return `${make} ${model}`;
}

function ExifFacts({ exif }: { exif: ImageDetails }) {
  const { t, i18n } = useTranslation("files");
  const camera = cameraName(exif);
  const exposure = [
    exif.exposure ? formatExposure(exif.exposure) : null,
    exif.fNumber ? `f/${trimNumber(exif.fNumber)}` : null,
    exif.iso ? `ISO ${exif.iso}` : null,
    exif.focalLength
      ? `${trimNumber(exif.focalLength)} mm${
          exif.focalLength35mm && exif.focalLength35mm !== exif.focalLength
            ? ` (${exif.focalLength35mm} mm)`
            : ""
        }`
      : null,
  ].filter(Boolean);
  const coordinates =
    exif.latitude !== null && exif.longitude !== null
      ? formatCoordinates(exif.latitude, exif.longitude)
      : null;

  const copyCoordinates = async () => {
    if (!coordinates) return;
    try {
      await navigator.clipboard.writeText(coordinates);
      toast.success(t("preview.locationCopied"));
    } catch (e) {
      toast.error(String(e));
    }
  };

  return (
    <>
      {exif.taken && (
        <Fact label={t("preview.taken")}>
          <span
            className="num"
            title={exif.offset ? `UTC${exif.offset}` : undefined}
          >
            {formatTaken(exif.taken, i18n.language)}
          </span>
        </Fact>
      )}
      {camera && (
        <Fact label={t("preview.camera")}>
          <span className="selectable block truncate" title={camera}>
            {camera}
          </span>
        </Fact>
      )}
      {exif.lens && (
        <Fact label={t("preview.lens")}>
          <span className="selectable block truncate" title={exif.lens}>
            {exif.lens}
          </span>
        </Fact>
      )}
      {exposure.length > 0 && (
        <Fact label={t("preview.exposure")}>
          <span className="num">{exposure.join(" · ")}</span>
        </Fact>
      )}
      {coordinates && (
        <Fact label={t("preview.location")}>
          <span className="flex min-w-0 items-center gap-1">
            <span
              className="selectable num min-w-0 truncate font-mono"
              title={
                exif.altitude !== null
                  ? `${coordinates} · ${t("preview.altitude", {
                      value: Math.round(exif.altitude),
                    })}`
                  : coordinates
              }
            >
              {coordinates}
            </span>
            <Button
              variant="ghost"
              size="icon-xs"
              className="-my-1 flex-none"
              aria-label={t("preview.copyLocation")}
              title={t("preview.copyLocation")}
              onClick={() => void copyCoordinates()}
            >
              <Copy />
            </Button>
          </span>
        </Fact>
      )}
    </>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="m-0 min-w-0">{children}</dd>
    </>
  );
}
