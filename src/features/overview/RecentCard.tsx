import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  Bug,
  FileIcon,
  Image,
  type LucideIcon,
  Package,
  PackageX,
  Power,
  SlidersHorizontal,
  SquareTerminal,
  Video,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";

import { useNavigation } from "@/app/navigation";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  type HistoryEntry,
  type HistoryKind,
  useHistory,
} from "@/features/overview/history";

const ICONS: Record<HistoryKind, { icon: LucideIcon; className: string }> = {
  screenshot: { icon: Image, className: "text-chart-1" },
  recording: { icon: Video, className: "text-chart-4" },
  install: { icon: Package, className: "text-success" },
  uninstall: { icon: PackageX, className: "text-muted-foreground" },
  shell: { icon: SquareTerminal, className: "text-muted-foreground" },
  bugreport: { icon: Bug, className: "text-chart-2" },
  reboot: { icon: Power, className: "text-muted-foreground" },
  settings: { icon: SlidersHorizontal, className: "text-muted-foreground" },
  file: { icon: FileIcon, className: "text-chart-3" },
  other: { icon: FileIcon, className: "text-muted-foreground" },
};

const MONO: HistoryKind[] = ["install", "uninstall", "shell", "file"];

/** Re-renders every 30 s so relative times stay fresh. */
function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function useAgo() {
  const { t } = useTranslation("overview");
  const now = useNow();
  return (at: number) => {
    const min = Math.floor((now - at) / 60_000);
    if (min < 1) return t("ago.now");
    if (min < 60) return t("ago.min", { count: min });
    const h = Math.floor(min / 60);
    if (h < 24) return t("ago.hour", { count: h });
    return t("ago.day", { count: Math.floor(h / 24) });
  };
}

function Row({ entry, ago }: { entry: HistoryEntry; ago: string }) {
  const navigate = useNavigation((s) => s.navigate);
  const { icon: Icon, className } = ICONS[entry.kind] ?? ICONS.other;
  const open = () => {
    if (entry.kind === "screenshot" || entry.kind === "recording") {
      navigate("gallery");
    } else if (entry.kind === "bugreport") {
      navigate("bugreport");
    } else if (entry.path) {
      void revealItemInDir(entry.path).catch(() => {});
    }
  };
  return (
    <button
      type="button"
      onClick={open}
      className="hover:bg-accent focus-visible:outline-ring text-small flex h-9 w-full items-center gap-2.5 border-t px-3.5 text-left outline-none focus-visible:outline-2 focus-visible:-outline-offset-2"
    >
      <Icon className={`size-4 flex-none ${className}`} aria-hidden />
      <span
        className={`min-w-0 flex-1 truncate ${MONO.includes(entry.kind) ? "font-mono" : ""}`}
      >
        {entry.label}
      </span>
      <span className="text-muted-foreground flex-none tabular-nums">
        {ago}
      </span>
    </button>
  );
}

export function RecentCard({
  serial,
  deviceName,
}: {
  serial: string;
  deviceName: string;
}) {
  const { t } = useTranslation("overview");
  const ago = useAgo();
  const entries = useHistory(
    useShallow((s) => s.entries.filter((e) => e.serial === serial)),
  );
  const clear = useHistory((s) => s.clear);
  const [open, setOpen] = useState(false);

  return (
    <section className="bg-card flex min-w-0 flex-col overflow-hidden rounded-lg border">
      <div className="flex items-center justify-between px-3.5 py-3">
        <h2 className="font-semibold">{t("recent.title")}</h2>
        {entries.length > 0 && (
          <button
            type="button"
            className="text-brand text-small focus-visible:outline-ring rounded-sm hover:underline focus-visible:outline-2"
            onClick={() => setOpen(true)}
          >
            {t("recent.history")}
          </button>
        )}
      </div>
      {entries.length === 0 ? (
        <p className="text-muted-foreground text-small border-t px-3.5 py-3">
          {t("recent.empty")}
        </p>
      ) : (
        entries
          .slice(0, 4)
          .map((e) => <Row key={e.id} entry={e} ago={ago(e.at)} />)
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="gap-3 sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t("recent.dialogTitle", { name: deviceName })}
            </DialogTitle>
          </DialogHeader>
          <div className="-mx-4 max-h-[50vh] overflow-auto border-b">
            {entries.map((e) => (
              <Row key={e.id} entry={e} ago={ago(e.at)} />
            ))}
          </div>
          <DialogFooter className="border-t-0 bg-transparent pt-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                clear(serial);
                setOpen(false);
              }}
            >
              {t("recent.clear")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
