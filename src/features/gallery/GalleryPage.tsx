import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { cn } from "cn";
import { Camera, ChevronDown, Copy, Images, Play, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Page } from "@/components/layout/Page";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Segmented } from "@/features/device-settings/Segmented";
import { deviceName } from "@/features/devices/naming";
import { useDeviceInfo } from "@/features/devices/queries";
import { useSelectedDevice } from "@/features/devices/store";
import {
  type Capture,
  type CaptureKind,
  captureSrc,
  deleteCapture,
  listCaptures,
} from "@/features/gallery/api";
import {
  CAPTURES_QUERY,
  useCaptureActions,
} from "@/features/overview/captureActions";
import {
  type DayBucket,
  dayBucket,
  formatBytes,
  formatWhen,
} from "@/features/overview/format";
import { os } from "@/lib/platform";
import type { AppError } from "@/lib/tauri";

type KindFilter = "all" | CaptureKind;
const ALL_DEVICES = "\u0000all";

function errorText(error: unknown) {
  return (error as Partial<AppError>)?.message ?? String(error);
}

export default function GalleryPage() {
  const { t, i18n } = useTranslation("gallery");
  const { t: tc } = useTranslation();
  const queryClient = useQueryClient();
  const device = useSelectedDevice();
  const ready = device?.state.kind === "device";
  const { data: info } = useDeviceInfo(ready ? device.serial : null);
  const name = device ? deviceName(device, info) : "";
  const { screenshot, shooting } = useCaptureActions(
    ready ? device.serial : null,
    name,
  );

  const { data, error, isPending } = useQuery({
    queryKey: CAPTURES_QUERY,
    queryFn: listCaptures,
  });
  const [kind, setKind] = useState<KindFilter>("all");
  const [deviceFilter, setDeviceFilter] = useState(ALL_DEVICES);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Capture | null>(null);

  const captures = data?.captures ?? [];
  const devices = useMemo(
    () =>
      [...new Set(captures.map((c) => c.device).filter(Boolean))] as string[],
    [captures],
  );
  const visible = captures.filter(
    (c) =>
      (kind === "all" || c.kind === kind) &&
      (deviceFilter === ALL_DEVICES || c.device === deviceFilter),
  );
  const selected =
    visible.find((c) => c.path === selectedPath) ?? visible[0] ?? null;

  const groups = useMemo(() => {
    const order: DayBucket[] = ["today", "yesterday", "earlier"];
    return order
      .map((bucket) => ({
        bucket,
        items: visible.filter((c) => dayBucket(c.modified) === bucket),
      }))
      .filter((g) => g.items.length > 0);
  }, [visible]);

  const remove = useMutation({
    mutationFn: (c: Capture) => deleteCapture(c.path),
    onSuccess: (_, c) => {
      toast.success(t("deleted", { name: c.name }));
      void queryClient.invalidateQueries({ queryKey: CAPTURES_QUERY });
    },
    onError: (e) =>
      toast.error(t("deleteFailed"), { description: errorText(e) }),
  });

  // Keyboard: arrows move the selection, Delete asks to delete it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, [role=dialog], [role=menu]"))
        return;
      if (!selected) return;
      const i = visible.indexOf(selected);
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        const next = visible[Math.min(i + 1, visible.length - 1)];
        if (next) setSelectedPath(next.path);
        e.preventDefault();
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        const prev = visible[Math.max(i - 1, 0)];
        if (prev) setSelectedPath(prev.path);
        e.preventDefault();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        setConfirmDelete(selected);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, visible]);

  return (
    <Page
      title={
        <span className="flex items-center gap-2">
          {tc("nav.gallery")}
          {data && <Badge className="tabular-nums">{captures.length}</Badge>}
        </span>
      }
      parent={device ? { label: name } : undefined}
      body="fill"
      actions={
        <>
          <Segmented<KindFilter>
            label={t("filter.kind")}
            value={kind}
            onChange={setKind}
            options={[
              { value: "all", label: t("filter.all") },
              { value: "screenshot", label: t("filter.screenshots") },
              { value: "recording", label: t("filter.recordings") },
            ]}
          />
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="outline" size="sm" />}
            >
              {deviceFilter === ALL_DEVICES
                ? t("filter.allDevices")
                : deviceFilter}
              <ChevronDown />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuRadioGroup
                value={deviceFilter}
                onValueChange={(v) => setDeviceFilter(v as string)}
              >
                <DropdownMenuRadioItem value={ALL_DEVICES}>
                  {t("filter.allDevices")}
                </DropdownMenuRadioItem>
                {devices.length > 0 && <DropdownMenuSeparator />}
                {devices.map((d) => (
                  <DropdownMenuRadioItem key={d} value={d}>
                    {d}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            size="sm"
            disabled={!ready || shooting}
            onClick={() => void screenshot()}
          >
            <Camera />
            {t("screenshot")}
          </Button>
        </>
      }
    >
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-auto px-5 py-4">
          {error ? (
            <p className="text-error">{errorText(error)}</p>
          ) : isPending ? (
            <Grid>
              {Array.from({ length: 10 }, (_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: placeholders
                <Skeleton key={i} className="aspect-[9/19] rounded-lg" />
              ))}
            </Grid>
          ) : visible.length === 0 ? (
            <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-3 text-center">
              <Images className="size-8" aria-hidden />
              <p className="max-w-sm">
                {captures.length === 0
                  ? t("empty", { dir: data?.dir ?? "" })
                  : t("emptyFiltered")}
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-5">
              {groups.map((g) => (
                <section key={g.bucket}>
                  <h2 className="text-caption text-muted-foreground mb-2.5 font-semibold tracking-[.05em] uppercase">
                    {t(`day.${g.bucket}`)}
                  </h2>
                  <Grid>
                    {g.items.map((c) => (
                      <Tile
                        key={c.path}
                        capture={c}
                        selected={c.path === selected?.path}
                        when={formatWhen(c.modified, i18n.language)}
                        onSelect={() => setSelectedPath(c.path)}
                      />
                    ))}
                  </Grid>
                </section>
              ))}
            </div>
          )}
        </div>
        {selected && (
          <Detail
            capture={selected}
            onDelete={() => setConfirmDelete(selected)}
          />
        )}
      </div>

      <AlertDialog
        open={confirmDelete !== null}
        onOpenChange={(open) => !open && setConfirmDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("deleteTitle", { name: confirmDelete?.name })}
            </AlertDialogTitle>
            <AlertDialogDescription>{t("deleteBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tc("actions.cancel")}</AlertDialogCancel>
            <Button
              variant="destructive"
              onClick={() => {
                if (confirmDelete) remove.mutate(confirmDelete);
                setConfirmDelete(null);
              }}
            >
              {t("delete")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Page>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(124px,1fr))] gap-3">
      {children}
    </div>
  );
}

function Thumb({
  capture,
  className,
}: {
  capture: Capture;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const src = captureSrc(capture.path);
  if (failed) {
    return <div className={cn("bg-selected", className)} />;
  }
  return capture.kind === "screenshot" ? (
    <img
      src={src}
      alt=""
      loading="lazy"
      draggable={false}
      onError={() => setFailed(true)}
      className={cn("object-cover object-top", className)}
    />
  ) : (
    <video
      src={src}
      preload="metadata"
      muted
      onError={() => setFailed(true)}
      className={cn("bg-black object-cover", className)}
    />
  );
}

function Tile({
  capture,
  selected,
  when,
  onSelect,
}: {
  capture: Capture;
  selected: boolean;
  when: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={capture.name}
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        "bg-card focus-visible:outline-ring flex flex-col overflow-hidden rounded-lg border text-left outline-none focus-visible:outline-2 focus-visible:outline-offset-2",
        selected && "border-brand ring-brand ring-1",
      )}
    >
      <span className="relative block aspect-[9/16] overflow-hidden">
        <Thumb capture={capture} className="absolute inset-0 size-full" />
        {capture.kind === "recording" && (
          <span className="absolute inset-0 flex items-center justify-center">
            <span className="flex size-[30px] items-center justify-center rounded-full bg-black/55 text-white">
              <Play className="size-3.5 fill-current" aria-hidden />
            </span>
          </span>
        )}
      </span>
      <span className="flex min-w-0 flex-col gap-px px-[9px] py-[7px]">
        <span className="text-small truncate font-medium">{capture.name}</span>
        <span className="text-caption text-muted-foreground truncate">
          {[capture.device, when].filter(Boolean).join(" · ")}
        </span>
      </span>
    </button>
  );
}

async function copyImage(capture: Capture) {
  const blob = await fetch(captureSrc(capture.path)).then((r) => r.blob());
  const type = blob.type.startsWith("image/") ? blob.type : "image/png";
  await navigator.clipboard.write([new ClipboardItem({ [type]: blob })]);
}

function Detail({
  capture,
  onDelete,
}: {
  capture: Capture;
  onDelete: () => void;
}) {
  const { t, i18n } = useTranslation("gallery");
  const isVideo = capture.kind === "recording";

  const copy = () => {
    const done = isVideo
      ? navigator.clipboard.writeText(capture.path)
      : copyImage(capture);
    void done
      .then(() => toast.success(isVideo ? t("pathCopied") : t("imageCopied")))
      .catch((e) => toast.error(t("copyFailed"), { description: String(e) }));
  };

  return (
    <aside
      aria-label={t("selected")}
      className="flex w-[420px] flex-none flex-col border-l max-xl:w-[340px]"
    >
      <div className="flex items-center gap-2 border-b px-3.5 py-2.5">
        <span className="min-w-0 flex-1 truncate font-semibold">
          {capture.name}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={isVideo ? t("copyPath") : t("copyImage")}
          title={isVideo ? t("copyPath") : t("copyImage")}
          onClick={copy}
        >
          <Copy />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            void revealItemInDir(capture.path).catch((e) =>
              toast.error(String(e)),
            )
          }
        >
          {t(`reveal.${os}`)}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("delete")}
          title={t("delete")}
          onClick={onDelete}
        >
          <Trash2 />
        </Button>
      </div>
      <div className="bg-sidebar flex min-h-0 flex-1 items-center justify-center p-4">
        {isVideo ? (
          // biome-ignore lint/a11y/useMediaCaption: screenrecord has no audio track
          <video
            key={capture.path}
            src={captureSrc(capture.path)}
            controls
            className="ring-input max-h-full max-w-full rounded-[14px] bg-black ring-1"
          />
        ) : (
          <img
            key={capture.path}
            src={captureSrc(capture.path)}
            alt={capture.name}
            draggable={false}
            className="ring-input max-h-full max-w-full rounded-[14px] object-contain ring-1"
          />
        )}
      </div>
      <div className="text-small text-muted-foreground flex items-center gap-3 border-t px-3.5 py-2">
        {capture.width && capture.height && (
          <span className="tabular-nums">
            {capture.width} × {capture.height}
          </span>
        )}
        {capture.device && <span className="truncate">{capture.device}</span>}
        <span className="whitespace-nowrap">
          {formatWhen(capture.modified, i18n.language)}
        </span>
        <span className="ml-auto tabular-nums">
          {formatBytes(capture.sizeBytes)}
        </span>
      </div>
    </aside>
  );
}
