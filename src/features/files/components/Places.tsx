import {
  Bookmark,
  Camera,
  Download,
  FileText,
  HardDrive,
  Image,
  type LucideIcon,
  Plus,
  SquareTerminal,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

import { formatBytes } from "../format";
import { basename, isWithin, isWithinLocal } from "../paths";
import { useLocalPlaces, useStorage } from "../queries";
import { useBrowser, useFilesPrefs, useLocalBrowser } from "../store";
import {
  LOCAL_PLACE_ICONS,
  useComputerTitle,
  useLocalPlaceLabel,
} from "./LocalPane";

const FAVORITES: {
  key: string;
  path: string;
  icon: LucideIcon;
  mono?: boolean;
}[] = [
  { key: "internal", path: "/sdcard", icon: HardDrive },
  { key: "dcim", path: "/sdcard/DCIM", icon: Camera },
  { key: "download", path: "/sdcard/Download", icon: Download },
  { key: "pictures", path: "/sdcard/Pictures", icon: Image },
  { key: "documents", path: "/sdcard/Documents", icon: FileText },
  { key: "tmp", path: "/data/local/tmp", icon: SquareTerminal, mono: true },
];

/** The place that best matches the current path (deepest prefix). */
function activePlace(path: string, places: string[]): string | null {
  let best: string | null = null;
  for (const p of places) {
    if (isWithin(path, p) && (best === null || p.length > best.length))
      best = p;
  }
  return best;
}

/** 196 px column: favourites, user bookmarks and storage usage; in
 * two-pane mode the computer's places come first. */
export function Places({
  serial,
  split = false,
  deviceName,
}: {
  serial: string;
  split?: boolean;
  deviceName?: string;
}) {
  const { t } = useTranslation("files");
  const path = useBrowser((s) => s.path);
  const go = useBrowser((s) => s.go);
  const bookmarks = useFilesPrefs((s) => s.bookmarks);
  const addBookmark = useFilesPrefs((s) => s.addBookmark);
  const removeBookmark = useFilesPrefs((s) => s.removeBookmark);
  const { data: storage } = useStorage(serial);

  const active = activePlace(path, [
    ...FAVORITES.map((f) => f.path),
    ...bookmarks.map((b) => b.path),
  ]);
  const bookmarked = bookmarks.some((b) => b.path === path);

  return (
    <nav
      aria-label={t("places.favorites")}
      className="hidden w-[196px] flex-none flex-col gap-px overflow-y-auto border-r px-2 py-2.5 min-[1080px]:flex"
    >
      {split && <ComputerPlaces />}
      <SectionLabel className={split ? "pt-3.5" : undefined}>
        {split && deviceName ? deviceName : t("places.favorites")}
      </SectionLabel>
      {FAVORITES.map((f) => (
        <PlaceItem
          key={f.key}
          icon={f.icon}
          active={active === f.path}
          onClick={() => go(f.path)}
          title={f.path}
        >
          {f.mono ? (
            <span className="text-caption font-mono">{f.path}</span>
          ) : (
            t(`places.${f.key}`)
          )}
        </PlaceItem>
      ))}

      <SectionLabel className="pt-3.5">{t("places.bookmarks")}</SectionLabel>
      {bookmarks.map((b) => (
        <PlaceItem
          key={b.path}
          icon={Bookmark}
          active={active === b.path}
          onClick={() => go(b.path)}
          title={b.path}
          onRemove={() => removeBookmark(b.path)}
          removeLabel={t("places.removeBookmark", { name: b.label })}
        >
          {b.label}
        </PlaceItem>
      ))}
      <button
        type="button"
        disabled={bookmarked}
        onClick={() => addBookmark({ path, label: basename(path) })}
        className="text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-ring text-small flex h-7 items-center gap-2 rounded-sm px-2 font-medium outline-none focus-visible:outline-2 disabled:opacity-50 disabled:hover:bg-transparent"
      >
        <Plus className="size-[15px]" aria-hidden />
        {bookmarked ? t("places.bookmarked") : t("places.addBookmark")}
      </button>

      {storage && storage.total > 0 && (
        <div className="text-muted-foreground text-caption mt-auto p-2">
          {t("places.storage", {
            used: formatBytes(storage.used),
            total: formatBytes(storage.total),
          })}
          <span className="bg-selected mt-1.5 block h-1 overflow-hidden rounded-full">
            <span
              className="bg-primary block h-full rounded-full"
              style={{
                width: `${Math.min(100, (storage.used / storage.total) * 100)}%`,
              }}
            />
          </span>
        </div>
      )}
    </nav>
  );
}

function ComputerPlaces() {
  const { data: places = [] } = useLocalPlaces();
  const path = useLocalBrowser((s) => s.path);
  const go = useLocalBrowser((s) => s.go);
  const label = useLocalPlaceLabel();
  const computer = useComputerTitle();
  let active: string | null = null;
  for (const p of places)
    if (
      path &&
      isWithinLocal(path, p.path) &&
      (active === null || p.path.length > active.length)
    )
      active = p.path;
  return (
    <>
      <SectionLabel>{computer}</SectionLabel>
      {places.map((p) => (
        <PlaceItem
          key={p.path}
          icon={LOCAL_PLACE_ICONS[p.key]}
          active={active === p.path}
          onClick={() => go(p.path)}
          title={p.path}
        >
          {label(p)}
        </PlaceItem>
      ))}
    </>
  );
}

function SectionLabel({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "text-muted-foreground text-caption px-2 pt-1 pb-1.5 font-semibold tracking-[.05em] uppercase",
        className,
      )}
    >
      {children}
    </div>
  );
}

function PlaceItem({
  icon: Icon,
  active,
  onClick,
  title,
  onRemove,
  removeLabel,
  children,
}: {
  icon: LucideIcon;
  active: boolean;
  onClick: () => void;
  title: string;
  onRemove?: () => void;
  removeLabel?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="group/place relative">
      <button
        type="button"
        title={title}
        aria-current={active ? "page" : undefined}
        onClick={onClick}
        className={cn(
          "focus-visible:outline-ring text-small flex h-7 w-full min-w-0 items-center gap-2 rounded-sm px-2 font-medium outline-none focus-visible:outline-2",
          active
            ? "bg-selected text-foreground"
            : "text-secondary-foreground hover:bg-accent hover:text-foreground",
        )}
      >
        <Icon className="size-[15px] flex-none" aria-hidden />
        <span className="truncate">{children}</span>
      </button>
      {onRemove && (
        <button
          type="button"
          aria-label={removeLabel}
          onClick={onRemove}
          className="text-muted-foreground hover:text-foreground focus-visible:outline-ring absolute top-1 right-1 hidden size-5 items-center justify-center rounded-xs outline-none group-hover/place:flex focus-visible:flex focus-visible:outline-2"
        >
          <X className="size-3" aria-hidden />
        </button>
      )}
    </div>
  );
}
