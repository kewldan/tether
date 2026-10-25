import { cn } from "cn";
import {
  File,
  FileArchive,
  FileCode,
  FileText,
  Folder,
  FolderSymlink,
  Image,
  Link2,
  type LucideIcon,
  Music,
  Package,
  ScrollText,
  Video,
} from "lucide-react";

import type { FileEntry } from "../api";
import { type Category, categoryOf } from "../format";

const ICONS: Record<Category, { icon: LucideIcon; className: string }> = {
  folder: { icon: Folder, className: "text-brand" },
  image: { icon: Image, className: "text-chart-1" },
  video: { icon: Video, className: "text-chart-4" },
  audio: { icon: Music, className: "text-chart-2" },
  text: { icon: FileText, className: "text-muted-foreground" },
  code: { icon: FileCode, className: "text-chart-3" },
  archive: { icon: FileArchive, className: "text-chart-5" },
  apk: { icon: Package, className: "text-chart-3" },
  document: { icon: ScrollText, className: "text-chart-2" },
  link: { icon: Link2, className: "text-muted-foreground" },
  other: { icon: File, className: "text-muted-foreground" },
};

export function FileIcon({
  entry,
  className,
}: {
  entry: Pick<FileEntry, "name" | "kind" | "linkToDir">;
  className?: string;
}) {
  const category = categoryOf(entry);
  const { icon, className: tone } = ICONS[category];
  const Icon =
    entry.kind === "symlink" && entry.linkToDir ? FolderSymlink : icon;
  return (
    <Icon
      aria-hidden
      className={cn("size-[15px] flex-none", tone, className)}
      strokeWidth={1.75}
    />
  );
}
