import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { cn } from "cn";
import {
  Download,
  FolderOpen,
  Info,
  Keyboard,
  Loader,
  RefreshCw,
  Search,
  Settings2,
  TerminalSquare,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { useNavigation } from "@/app/navigation";
import { Page } from "@/components/layout/Page";
import { StatusDot } from "@/components/status/StatusDot";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Kbd } from "@/components/ui/kbd";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  downloadPlatformTools,
  type InstallProgress,
  restartServer,
  scanAdb,
  serverStatus,
  setAdbPath,
} from "@/features/onboarding/api";
import { LICENSE_URL } from "@/features/onboarding/NotFoundScreen";
import { tildify } from "@/features/onboarding/parts";
import { pickFile, pickFolder } from "@/features/settings/pickers";
import { Segmented } from "@/features/settings/Segmented";
import { useAdb } from "@/lib/adb";
import { isMac, modKey, os } from "@/lib/platform";
import { type AdbMode, type Language, useSettings } from "@/lib/settings";
import type { AppError } from "@/lib/tauri";

const SECTION_IDS = ["general", "adb", "files", "shortcuts", "about"] as const;
type SectionKey = (typeof SECTION_IDS)[number];
const ICONS: Record<SectionKey, typeof Settings2> = {
  general: Settings2,
  adb: TerminalSquare,
  files: FolderOpen,
  shortcuts: Keyboard,
  about: Info,
};

interface Row {
  id: string;
  title: string;
  desc?: ReactNode;
  /** Extra words that should match the search. */
  keywords?: string;
  control: ReactNode;
}

/** 13 · App settings. */
export default function SettingsPage() {
  const { t } = useTranslation("settings");
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<SectionKey>("general");
  const scroller = useRef<HTMLDivElement>(null);
  const sections: Record<
    SectionKey,
    { title: string; rows: Row[]; extra?: ReactNode }
  > = {
    general: { title: t("general.title"), rows: useGeneralRows() },
    adb: { title: t("adb.title"), rows: useAdbRows(), extra: <AdbBanner /> },
    files: { title: t("files.title"), rows: useFilesRows() },
    shortcuts: { title: t("shortcuts.title"), rows: useShortcutRows() },
    about: { title: t("about.title"), rows: useAboutRows() },
  };

  const q = query.trim().toLowerCase();
  const matches = (r: Row) =>
    !q ||
    `${r.title} ${typeof r.desc === "string" ? r.desc : ""} ${r.keywords ?? ""}`
      .toLowerCase()
      .includes(q);

  // Highlight the section in view.
  useEffect(() => {
    const root = scroller.current;
    if (!root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const top = entries
          .filter((e) => e.isIntersecting)
          .sort(
            (a, b) => a.boundingClientRect.top - b.boundingClientRect.top,
          )[0];
        if (top)
          setActive(top.target.id.replace("settings-", "") as SectionKey);
      },
      { root, rootMargin: "0px 0px -60% 0px" },
    );
    for (const id of SECTION_IDS) {
      const el = root.querySelector(`#settings-${id}`);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, []);

  const jump = (id: SectionKey) => {
    setActive(id);
    scroller.current
      ?.querySelector(`#settings-${id}`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <Page
      title={t("title")}
      body="fill"
      actions={
        <div className="border-input bg-background text-muted-foreground focus-within:border-ring flex h-7 w-[240px] items-center gap-2 rounded-[7px] border px-2.5">
          <Search className="size-3.5 flex-none" aria-hidden />
          <input
            aria-label={t("search")}
            placeholder={t("search")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="text-foreground placeholder:text-muted-foreground text-small min-w-0 flex-1 bg-transparent outline-none"
          />
        </div>
      }
    >
      <div className="flex min-h-0 flex-1">
        <nav
          aria-label={t("sections")}
          className="hidden w-[200px] flex-none flex-col gap-px border-r px-2.5 py-3.5 min-[1100px]:flex"
        >
          {SECTION_IDS.map((id) => {
            const Icon = ICONS[id];
            return (
              <button
                key={id}
                type="button"
                aria-current={active === id ? "true" : undefined}
                onClick={() => jump(id)}
                className={cn(
                  "focus-visible:outline-ring flex h-[30px] items-center gap-2.5 rounded-sm px-2.5 font-medium outline-none focus-visible:outline-2",
                  active === id
                    ? "bg-selected text-foreground"
                    : "text-secondary-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                <Icon className="size-4" aria-hidden />
                {sections[id].title}
              </button>
            );
          })}
        </nav>
        <div ref={scroller} className="min-w-0 flex-1 overflow-auto px-8 py-6">
          <div className="flex max-w-[760px] flex-col gap-8">
            {SECTION_IDS.map((id) => {
              const rows = sections[id].rows.filter(matches);
              if (q && rows.length === 0) return null;
              return (
                <section key={id} id={`settings-${id}`} className="scroll-mt-2">
                  <h2 className="mb-1.5 text-[16px] font-semibold">
                    {sections[id].title}
                  </h2>
                  {!q && sections[id].extra}
                  {rows.map((r) => (
                    <div
                      key={r.id}
                      className={cn(
                        "grid items-center gap-6 border-t py-3.5",
                        id === "shortcuts"
                          ? "grid-cols-[minmax(0,1fr)_auto] py-2"
                          : "grid-cols-[minmax(200px,1fr)_auto]",
                      )}
                    >
                      <div className="min-w-0">
                        <div
                          className={cn(
                            id === "shortcuts" ? "text-small" : "font-medium",
                          )}
                        >
                          {r.title}
                        </div>
                        {r.desc && (
                          <div className="text-small text-muted-foreground mt-0.5 leading-[18px]">
                            {r.desc}
                          </div>
                        )}
                      </div>
                      <div className="flex max-w-[380px] min-w-0 flex-wrap items-center justify-end gap-2">
                        {r.control}
                      </div>
                    </div>
                  ))}
                </section>
              );
            })}
            {q &&
              SECTION_IDS.every((id) => !sections[id].rows.some(matches)) && (
                <p className="text-muted-foreground py-10 text-center">
                  {t("nothing", { query })}
                </p>
              )}
          </div>
        </div>
      </div>
    </Page>
  );
}

function useGeneralRows(): Row[] {
  const { t } = useTranslation("settings");
  const s = useSettings();
  const languages: { value: Language; label: string }[] = [
    { value: "system", label: t("general.language.system") },
    { value: "en", label: "English" },
    { value: "ru", label: "Русский" },
  ];
  return [
    {
      id: "language",
      title: t("general.language.title"),
      desc: t("general.language.desc"),
      keywords: "English Русский",
      control: (
        <Select
          value={s.language}
          items={languages}
          onValueChange={(v) => v && s.setLanguage(v as Language)}
        >
          <SelectTrigger
            className="w-[200px]"
            aria-label={t("general.language.title")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {languages.map((l) => (
              <SelectItem key={l.value} value={l.value}>
                {l.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ),
    },
    {
      id: "theme",
      title: t("general.theme.title"),
      desc: t(isMac ? "general.theme.descMac" : "general.theme.desc"),
      control: (
        <Segmented
          label={t("general.theme.title")}
          value={s.theme}
          onChange={s.setTheme}
          options={(["dark", "light", "system"] as const).map((v) => ({
            value: v,
            label: t(`general.theme.${v}`),
          }))}
        />
      ),
    },
    {
      id: "density",
      title: t("general.density.title"),
      desc: t("general.density.desc"),
      control: (
        <Segmented
          label={t("general.density.title")}
          value={s.density}
          onChange={s.setDensity}
          options={(["comfortable", "compact"] as const).map((v) => ({
            value: v,
            label: t(`general.density.${v}`),
          }))}
        />
      ),
    },
    {
      id: "motion",
      title: t("general.motion.title"),
      desc: t("general.motion.desc"),
      control: (
        <Segmented
          label={t("general.motion.title")}
          value={s.reduceMotion}
          onChange={(reduceMotion) => s.update({ reduceMotion })}
          options={(["system", "on", "off"] as const).map((v) => ({
            value: v,
            label: t(`general.motion.${v}`),
          }))}
        />
      ),
    },
  ];
}

/** Re-runs the adb lookup after the adb settings changed. */
async function relocate() {
  const { install } = await scanAdb();
  useAdb
    .getState()
    .setAdb(install ? { status: "found", install } : { status: "missing" });
  return install;
}

function useAdbRows(): Row[] {
  const { t } = useTranslation("settings");
  const adb = useAdb((s) => s.adb);
  const mode = useSettings((s) => s.adbMode);
  const autoReconnect = useSettings((s) => s.autoReconnect);
  const update = useSettings((s) => s.update);
  const install = adb.status === "found" ? adb.install : null;
  const queryClient = useQueryClient();
  const { data: server } = useQuery({
    queryKey: ["adb-server-status"],
    queryFn: serverStatus,
    refetchInterval: 5000,
  });
  const [restarting, setRestarting] = useState(false);
  const [confirmRestart, setConfirmRestart] = useState(false);

  const chooseCustom = async () => {
    const path = await pickFile(t("adb.pickTitle"));
    if (!path) return;
    try {
      const picked = await setAdbPath(path);
      update({ adbMode: "custom", adbCustomPath: path });
      useAdb.getState().setAdb({ status: "found", install: picked });
      toast.success(t("adb.switched", { version: picked.version ?? "?" }));
    } catch (e) {
      toast.error(t("adb.pickFailed"), {
        description: (e as AppError).message,
      });
    }
  };

  const setMode = async (next: AdbMode) => {
    if (next === "custom") return chooseCustom();
    update({ adbMode: next });
    const found = await relocate();
    if (next === "bundled" && found?.source !== "bundled") {
      toast(t("adb.notDownloaded"));
    }
  };

  const restart = () => {
    setRestarting(true);
    restartServer()
      .then((v) => toast.success(t("adb.restarted", { version: v })))
      .catch((e: AppError) =>
        toast.error(t("adb.restartFailed"), { description: e.message }),
      )
      .finally(() => {
        setRestarting(false);
        void queryClient.invalidateQueries({ queryKey: ["adb-server-status"] });
      });
  };

  const uptime = server?.uptimeSecs
    ? server.uptimeSecs < 3600
      ? t("adb.upMin", {
          count: Math.max(1, Math.round(server.uptimeSecs / 60)),
        })
      : t("adb.upHours", { count: Math.round(server.uptimeSecs / 3600) })
    : null;

  return [
    {
      id: "which",
      title: t("adb.which.title"),
      desc: t("adb.which.desc"),
      control: (
        <Segmented
          label={t("adb.which.title")}
          value={mode}
          onChange={(v) => void setMode(v)}
          options={[
            { value: "bundled", label: t("adb.which.bundled") },
            { value: "system", label: t("adb.which.system") },
            { value: "custom", label: t("adb.which.custom") },
          ]}
        />
      ),
    },
    {
      id: "path",
      title: t("adb.path.title"),
      keywords: install?.path,
      desc: install ? (
        <span
          className="text-caption selectable block truncate font-mono"
          title={install.path}
        >
          {tildify(install.path)}
          {install.version && ` · ${install.version}`}
        </span>
      ) : (
        t("adb.path.none")
      ),
      control: (
        <>
          {install && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void revealItemInDir(install.path)}
            >
              {t("reveal")}
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => void chooseCustom()}
          >
            {t("change")}
          </Button>
        </>
      ),
    },
    {
      id: "server",
      title: t("adb.server.title"),
      keywords: "restart port 5037",
      desc: (
        <span className="flex items-center gap-1.5">
          <StatusDot tone={server?.running ? "success" : "error"} />
          {server?.running
            ? [
                t("adb.server.running"),
                server.version !== null &&
                  t("adb.server.version", { version: server.version }),
                uptime,
              ]
                .filter(Boolean)
                .join(" · ")
            : t("adb.server.down")}
        </span>
      ),
      control: (
        <>
          <span className="border-input text-small text-muted-foreground flex h-[26px] items-center gap-1.5 rounded-md border px-2">
            {t("adb.server.port")}
            <span className="text-foreground font-mono tabular-nums">
              {server?.port ?? 5037}
            </span>
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={restarting || !install}
            onClick={() => setConfirmRestart(true)}
          >
            <RefreshCw className={cn(restarting && "animate-spin")} />
            {t("adb.server.restart")}
          </Button>
          <AlertDialog open={confirmRestart} onOpenChange={setConfirmRestart}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {t("adb.server.confirmTitle")}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {t("adb.server.confirmText")}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>
                  {t("common:actions.cancel")}
                </AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => {
                    setConfirmRestart(false);
                    restart();
                  }}
                >
                  {t("adb.server.restart")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      ),
    },
    {
      id: "reconnect",
      title: t("adb.reconnect.title"),
      desc: t("adb.reconnect.desc"),
      control: (
        <Switch
          aria-label={t("adb.reconnect.title")}
          checked={autoReconnect}
          onCheckedChange={(on) => update({ autoReconnect: on })}
        />
      ),
    },
  ];
}

/** "Update platform-tools" / "Download Tether's copy", with license consent. */
function AdbBanner() {
  const { t } = useTranslation("settings");
  const adb = useAdb((s) => s.adb);
  const bundled = adb.status === "found" && adb.install.source === "bundled";
  const [consent, setConsent] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [progress, setProgress] = useState<InstallProgress | null>(null);

  const start = () => {
    setConsent(false);
    setProgress({ type: "downloading", downloaded: 0, total: null });
    downloadPlatformTools(setProgress)
      .then(async (install) => {
        useSettings.getState().update({ adbMode: "bundled" });
        await relocate();
        toast.success(
          t("adb.update.done", { version: install.version ?? "?" }),
        );
      })
      .catch((e: AppError) => {
        if (e.kind !== "cancelled") {
          toast.error(t("adb.update.failed"), {
            description: e.hint ?? e.message,
          });
        }
      })
      .finally(() => setProgress(null));
  };

  const pct =
    progress?.type === "downloading" && progress.total
      ? Math.round((progress.downloaded / progress.total) * 100)
      : null;

  return (
    <div className="bg-info/13 mt-2 mb-1.5 flex items-center gap-2.5 rounded-md px-3 py-2.5">
      <Download className="text-info size-4 flex-none" aria-hidden />
      <span className="min-w-0 flex-1">
        {progress
          ? progress.type === "extracting"
            ? t("adb.update.extracting")
            : t("adb.update.downloading", { pct: pct ?? "…" })
          : bundled
            ? t("adb.update.bundled", {
                version: adb.install.version?.split("-")[0] ?? "?",
              })
            : t("adb.update.notBundled")}
      </span>
      <Button
        size="sm"
        variant="outline"
        disabled={progress !== null}
        onClick={() => setConsent(true)}
      >
        {progress ? <Loader className="animate-spin" /> : null}
        {bundled ? t("adb.update.update") : t("adb.update.download")}
      </Button>
      <AlertDialog open={consent} onOpenChange={setConsent}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("adb.update.consentTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("adb.update.consentText")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label className="flex cursor-pointer items-start gap-2.5">
            <Checkbox
              className="mt-0.5"
              checked={accepted}
              onCheckedChange={setAccepted}
            />
            <span>
              {t("adb.update.accept")}{" "}
              <button
                type="button"
                className="text-brand hover:underline"
                onClick={(e) => {
                  e.preventDefault();
                  void openUrl(LICENSE_URL);
                }}
              >
                {t("adb.update.license")}
              </button>
            </span>
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction disabled={!accepted} onClick={start}>
              {t("adb.update.download")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function FolderRow({
  value,
  fallback,
  onChange,
  title,
}: {
  value: string | null;
  fallback: string;
  onChange: (v: string | null) => void;
  title: string;
}) {
  const { t } = useTranslation("settings");
  return (
    <>
      <span
        className="text-caption text-muted-foreground min-w-0 truncate font-mono"
        title={value ?? fallback}
      >
        {value ? tildify(value) : fallback}
      </span>
      {value && (
        <Button size="sm" variant="ghost" onClick={() => onChange(null)}>
          {t("files.reset")}
        </Button>
      )}
      <Button
        size="sm"
        variant="outline"
        onClick={async () => {
          const dir = await pickFolder(title, value);
          if (dir) onChange(dir);
        }}
      >
        {t("change")}
      </Button>
    </>
  );
}

function useFilesRows(): Row[] {
  const { t } = useTranslation("settings");
  const captures = useSettings((s) => s.capturesDir);
  const downloads = useSettings((s) => s.downloadsDir);
  const update = useSettings((s) => s.update);
  return [
    {
      id: "captures",
      title: t("files.captures.title"),
      desc: t("files.captures.desc"),
      control: (
        <FolderRow
          title={t("files.captures.title")}
          value={captures}
          fallback={t("files.captures.default")}
          onChange={(capturesDir) => update({ capturesDir })}
        />
      ),
    },
    {
      id: "downloads",
      title: t("files.downloads.title"),
      desc: t("files.downloads.desc"),
      control: (
        <FolderRow
          title={t("files.downloads.title")}
          value={downloads}
          fallback={t("files.downloads.default")}
          onChange={(downloadsDir) => update({ downloadsDir })}
        />
      ),
    },
  ];
}

function Keys({ keys }: { keys: string[] }) {
  return (
    <span className="flex gap-[3px]">
      {keys.map((k) => (
        <Kbd key={k}>{k}</Kbd>
      ))}
    </span>
  );
}

function useShortcutRows(): Row[] {
  const { t } = useTranslation("settings");
  const list: [string, string[]][] = [
    ["palette", [modKey, "K"]],
    ["sidebar", [modKey, "B"]],
    ["switch", [modKey, "1…9"]],
    ["devices", [modKey, "D"]],
    ["wifi", [modKey, "⇧", "W"]],
  ];
  return list.map(([id, keys]) => ({
    id,
    title: t(`shortcuts.${id}`),
    keywords: keys.join(" "),
    control: <Keys keys={keys} />,
  }));
}

function useAboutRows(): Row[] {
  const { t } = useTranslation("settings");
  const navigate = useNavigation((s) => s.navigate);
  const { data: version } = useQuery({
    queryKey: ["app-version"],
    queryFn: () => getVersion(),
    staleTime: Number.POSITIVE_INFINITY,
  });
  return [
    {
      id: "version",
      title: t("about.version.title"),
      desc: t("about.version.desc", { os }),
      control: <span className="font-mono tabular-nums">{version ?? "…"}</span>,
    },
    {
      id: "licenses",
      title: t("about.licenses.title"),
      desc: t("about.licenses.desc"),
      control: (
        <>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void openUrl(LICENSE_URL)}
          >
            {t("about.licenses.sdk")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void openUrl("https://github.com/Genymobile/scrcpy")}
          >
            scrcpy
          </Button>
        </>
      ),
    },
    {
      id: "diagnostics",
      title: t("about.diagnostics.title"),
      desc: t("about.diagnostics.desc"),
      control: (
        <Button
          size="sm"
          variant="outline"
          onClick={() => navigate("diagnostics")}
        >
          {t("about.diagnostics.open")}
        </Button>
      ),
    },
    {
      id: "onboarding",
      title: t("about.onboarding.title"),
      desc: t("about.onboarding.desc"),
      control: (
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            useSettings.getState().update({ onboardingDone: false })
          }
        >
          {t("about.onboarding.run")}
        </Button>
      ),
    },
  ];
}
