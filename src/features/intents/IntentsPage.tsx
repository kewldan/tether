import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  Check,
  ChevronDown,
  Link2,
  Plus,
  Star,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Page } from "@/components/layout/Page";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useReadySerial } from "@/features/devices/store";
import {
  deepLinkSpec,
  EXTRA_TYPES,
  type Extra,
  type ExtraType,
  FLAGS,
  type IntentKind,
  type IntentResult,
  type IntentSpec,
  inputKey,
  inputText,
  intentCommand,
  sendIntent,
  shortComponent,
  specLabel,
} from "@/features/intents/api";
import {
  type Favorite,
  type HistoryEntry,
  useIntentsStore,
} from "@/features/intents/store";
import {
  errorMessage,
  monoFieldClass,
  NeedsDevice,
  UnderlineTabs,
  useDeviceCrumb,
} from "@/features/performance/common";
import { cn } from "@/lib/utils";

const COMMON_ACTIONS = [
  "android.intent.action.VIEW",
  "android.intent.action.MAIN",
  "android.intent.action.SEND",
  "android.intent.action.DIAL",
  "android.intent.action.SENDTO",
  "android.settings.SETTINGS",
  "android.settings.APPLICATION_DETAILS_SETTINGS",
];

const COMMON_CATEGORIES = [
  "android.intent.category.BROWSABLE",
  "android.intent.category.DEFAULT",
  "android.intent.category.LAUNCHER",
  "android.intent.category.HOME",
];

const KEYS: { label: string; key: string; aria?: string }[] = [
  { label: "Tab", key: "TAB" },
  { label: "Enter", key: "ENTER" },
  { label: "⌫", key: "DEL", aria: "Backspace" },
  { label: "Esc", key: "ESCAPE" },
  { label: "◀", key: "DPAD_LEFT", aria: "Left" },
  { label: "▶", key: "DPAD_RIGHT", aria: "Right" },
  { label: "Menu", key: "MENU" },
  { label: "Search", key: "SEARCH" },
  { label: "Paste", key: "PASTE" },
  { label: "Wake", key: "WAKEUP" },
];

interface LastRun {
  kind: IntentKind;
  result: IntentResult | null;
  error: string | null;
  ms: number;
}

export default function IntentsPage() {
  const { t } = useTranslation();
  const serial = useReadySerial();
  if (!serial) return <NeedsDevice title={t("nav.intents")} />;
  return <IntentsBody serial={serial} />;
}

function IntentsBody({ serial }: { serial: string }) {
  const { t } = useTranslation("intents");
  const crumb = useDeviceCrumb(true);
  const draft = useIntentsStore((s) => s.draft);
  const setDraft = useIntentsStore((s) => s.setDraft);
  const [busy, setBusy] = useState<IntentKind | null>(null);
  const [last, setLast] = useState<LastRun | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const run = async (kind: IntentKind, spec: IntentSpec) => {
    setBusy(kind);
    const started = performance.now();
    try {
      const result = await sendIntent(serial, kind, spec);
      const ms = Math.round(performance.now() - started);
      setLast({ kind, result, error: null, ms });
      useIntentsStore.getState().record({
        kind,
        spec,
        outcome: result.outcome,
        message: result.outcome === "error" ? failureText(t, result) : null,
      });
    } catch (e) {
      setLast({ kind, result: null, error: errorMessage(e), ms: 0 });
    } finally {
      setBusy(null);
    }
  };

  const load = (kind: IntentKind, spec: IntentSpec, id: string) => {
    setDraft(spec);
    setSelected(id);
    if (kind === "activity" && spec.action === "android.intent.action.VIEW") {
      useIntentsStore.getState().setDeepLink(spec.data);
    }
  };

  return (
    <Page title={t("title")} parent={crumb} body="fill">
      <DeepLinkBar
        busy={busy !== null}
        onOpen={(uri) => run("activity", deepLinkSpec(uri))}
      />
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_320px] overflow-auto">
        <div className="flex min-w-0 flex-col gap-3.5 border-r px-5 py-4">
          <Builder
            serial={serial}
            spec={draft}
            onChange={setDraft}
            busy={busy}
            last={last}
            onRun={(kind) => run(kind, draft)}
          />
          <TypeOnDevice serial={serial} />
        </div>
        <Sidebar selected={selected} onLoad={load} />
      </div>
    </Page>
  );
}

function DeepLinkBar({
  busy,
  onOpen,
}: {
  busy: boolean;
  onOpen: (uri: string) => void;
}) {
  const { t } = useTranslation("intents");
  const deepLink = useIntentsStore((s) => s.deepLink);
  const setDeepLink = useIntentsStore((s) => s.setDeepLink);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (deepLink.trim()) onOpen(deepLink);
  };
  return (
    <form
      onSubmit={submit}
      className="flex flex-none items-center gap-2 border-b px-5 py-3"
    >
      <span className="border-input bg-background focus-within:border-ring focus-within:ring-brand/15 flex h-[34px] flex-1 items-center gap-2 rounded-[7px] border px-2.5 focus-within:ring-3">
        <Link2 className="text-muted-foreground size-4 flex-none" aria-hidden />
        <input
          value={deepLink}
          onChange={(e) => setDeepLink(e.target.value)}
          placeholder={t("deepLinkPlaceholder")}
          aria-label={t("deepLink")}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          className="text-small placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent font-mono outline-none placeholder:font-sans"
        />
      </span>
      <Button
        type="submit"
        className="h-[34px]"
        disabled={!deepLink.trim() || busy}
      >
        {t("openDeepLink")}
        <Kbd className="text-primary-foreground border-primary-foreground/35 bg-transparent">
          ↵
        </Kbd>
      </Button>
    </form>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is passed as children
    <label className="flex min-w-0 flex-col gap-[5px]">
      <span className="text-small text-secondary-foreground font-medium">
        {label}
        {hint && (
          <span className="text-muted-foreground font-normal"> · {hint}</span>
        )}
      </span>
      {children}
    </label>
  );
}

function Builder({
  serial,
  spec,
  onChange,
  busy,
  last,
  onRun,
}: {
  serial: string;
  spec: IntentSpec;
  onChange: (spec: IntentSpec) => void;
  busy: IntentKind | null;
  last: LastRun | null;
  onRun: (kind: IntentKind) => void;
}) {
  const { t } = useTranslation("intents");
  const set = (patch: Partial<IntentSpec>) => onChange({ ...spec, ...patch });
  const command = useQuery({
    queryKey: ["intent-command", spec, serial],
    queryFn: () => intentCommand("activity", spec, serial),
    placeholderData: keepPreviousData,
    retry: false,
  });
  // Nothing to run yet: show a hint instead of the backend's validation error.
  const empty =
    !spec.action.trim() && !spec.data.trim() && !spec.component.trim();
  const invalid = empty
    ? t("commandHint")
    : command.isError
      ? errorMessage(command.error)
      : null;

  const copy = async () => {
    if (!command.data || invalid) return;
    await navigator.clipboard.writeText(command.data.adb);
    toast.success(t("copied"));
  };

  const setExtra = (i: number, patch: Partial<Extra>) =>
    set({
      extras: spec.extras.map((e, j) => (j === i ? { ...e, ...patch } : e)),
    });

  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[14px] font-semibold">{t("builder")}</h2>
        <span className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            onClick={copy}
            disabled={!command.data || !!invalid}
          >
            {t("copyAdb")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!!invalid}
            onClick={() => {
              useIntentsStore.getState().addFavorite("activity", spec);
              toast.success(t("savedFavorite"));
            }}
          >
            {t("saveFavorite")}
          </Button>
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label={t("action")}>
          <Input
            className={monoFieldClass}
            value={spec.action}
            list="tether-intent-actions"
            spellCheck={false}
            onChange={(e) => set({ action: e.target.value })}
          />
          <datalist id="tether-intent-actions">
            {COMMON_ACTIONS.map((a) => (
              <option key={a} value={a} />
            ))}
          </datalist>
        </Field>
        <Field label={t("data")}>
          <Input
            className={monoFieldClass}
            value={spec.data}
            spellCheck={false}
            onChange={(e) => set({ data: e.target.value })}
          />
        </Field>
        <Field label={t("category")}>
          <Input
            className={monoFieldClass}
            value={spec.categories.join(" ")}
            list="tether-intent-categories"
            spellCheck={false}
            onChange={(e) =>
              set({ categories: e.target.value.split(/[\s,]+/) })
            }
            onBlur={() =>
              set({ categories: spec.categories.filter((c) => c.trim()) })
            }
          />
          <datalist id="tether-intent-categories">
            {COMMON_CATEGORIES.map((a) => (
              <option key={a} value={a} />
            ))}
          </datalist>
        </Field>
        <Field label={t("component")} hint={t("optional")}>
          <Input
            className={monoFieldClass}
            value={spec.component}
            placeholder="com.example/.MainActivity"
            spellCheck={false}
            onChange={(e) => set({ component: e.target.value })}
          />
        </Field>
        <Field label={t("mimeType")} hint={t("optional")}>
          <Input
            className={monoFieldClass}
            value={spec.mimeType}
            placeholder="image/*"
            spellCheck={false}
            onChange={(e) => set({ mimeType: e.target.value })}
          />
        </Field>
      </div>

      <div className="flex flex-col gap-[5px]">
        <span className="text-small text-secondary-foreground font-medium">
          {t("extras")}
        </span>
        <div className="flex flex-col gap-1.5">
          {spec.extras.map((extra, i) => (
            <ExtraRow
              // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity besides position
              key={i}
              extra={extra}
              onChange={(patch) => setExtra(i, patch)}
              onRemove={() =>
                set({ extras: spec.extras.filter((_, j) => j !== i) })
              }
            />
          ))}
          <Button
            variant="ghost"
            size="sm"
            className="self-start"
            onClick={() =>
              set({
                extras: [
                  ...spec.extras,
                  { key: "", type: "string", value: "" },
                ],
              })
            }
          >
            <Plus />
            {t("addExtra")}
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-[5px]">
        <span className="text-small text-secondary-foreground font-medium">
          {t("flags")}
        </span>
        <div className="flex flex-wrap gap-1.5">
          {FLAGS.map((flag) => {
            const on = spec.flags.includes(flag);
            return (
              <button
                key={flag}
                type="button"
                aria-pressed={on}
                onClick={() =>
                  set({
                    flags: on
                      ? spec.flags.filter((f) => f !== flag)
                      : [...spec.flags, flag],
                  })
                }
                className={cn(
                  "text-caption focus-visible:outline-ring h-6 rounded-md border px-2 font-mono font-medium outline-none focus-visible:outline-2",
                  on
                    ? "border-brand text-brand bg-brand/15"
                    : "border-input bg-background text-secondary-foreground hover:text-foreground",
                )}
              >
                {flag}
              </button>
            );
          })}
        </div>
      </div>

      <div
        className={cn(
          "bg-sidebar rounded-md border px-3 py-2.5 font-mono text-[11.5px] leading-[18px] break-all whitespace-pre-wrap",
          empty
            ? "text-muted-foreground"
            : invalid
              ? "text-error"
              : "text-secondary-foreground",
        )}
        aria-live="polite"
      >
        {invalid ?? command.data?.device ?? " "}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          onClick={() => onRun("activity")}
          disabled={!!invalid || busy !== null}
        >
          {t("startActivity")}
        </Button>
        <Button
          variant="outline"
          onClick={() => onRun("broadcast")}
          disabled={!!invalid || busy !== null}
        >
          {t("sendBroadcast")}
        </Button>
        <span className="flex">
          <Button
            variant="outline"
            className="rounded-r-none"
            onClick={() => onRun("service")}
            disabled={!!invalid || busy !== null}
          >
            {t("startService")}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="outline"
                  size="icon"
                  className="-ml-px w-7 rounded-l-none"
                  aria-label={t("moreServices")}
                  disabled={!!invalid || busy !== null}
                />
              }
            >
              <ChevronDown />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem onClick={() => onRun("foreground_service")}>
                {t("startForegroundService")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
        {last && <RunResult last={last} />}
      </div>
    </>
  );
}

function ExtraRow({
  extra,
  onChange,
  onRemove,
}: {
  extra: Extra;
  onChange: (patch: Partial<Extra>) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation("intents");
  const small = cn(monoFieldClass, "h-7");
  return (
    <div className="grid grid-cols-[minmax(0,1.2fr)_120px_minmax(0,1.4fr)_26px] items-center gap-1.5">
      <Input
        className={small}
        value={extra.key}
        placeholder={t("extraKey")}
        aria-label={t("extraKey")}
        spellCheck={false}
        onChange={(e) => onChange({ key: e.target.value })}
      />
      <Select
        value={extra.type}
        items={EXTRA_TYPES.map((v) => ({ value: v, label: t(`types.${v}`) }))}
        onValueChange={(value) => {
          const type = value as ExtraType;
          onChange({
            type,
            value: type === "boolean" ? "true" : extra.value,
          });
        }}
      >
        <SelectTrigger
          size="sm"
          className="border-input bg-background dark:bg-background text-small h-7 w-full rounded-[7px]"
          aria-label={t("extraType")}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {EXTRA_TYPES.map((v) => (
            <SelectItem key={v} value={v}>
              {t(`types.${v}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {extra.type === "boolean" ? (
        <span className="flex h-7 items-center gap-2">
          <Switch
            checked={extra.value === "true"}
            aria-label={t("extraValue")}
            onCheckedChange={(on) => onChange({ value: on ? "true" : "false" })}
          />
          <span className="text-small font-mono">{extra.value || "false"}</span>
        </span>
      ) : extra.type === "null" ? (
        <span className="text-small text-muted-foreground font-mono">null</span>
      ) : (
        <Input
          className={small}
          value={extra.value}
          placeholder={
            extra.type.endsWith("_array") ? "a,b,c" : t("extraValue")
          }
          aria-label={t("extraValue")}
          spellCheck={false}
          onChange={(e) => onChange({ value: e.target.value })}
        />
      )}
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t("removeExtra")}
        onClick={onRemove}
      >
        <X />
      </Button>
    </div>
  );
}

type T = (key: string, options?: Record<string, unknown>) => string;

function failureText(t: T, result: IntentResult): string {
  switch (result.errorKind) {
    case "unresolved":
      return t("errors.unresolved");
    case "not_found":
      return t("errors.notFound");
    case "security":
      return t("errors.security");
    default:
      return result.message ?? t("errors.failed");
  }
}

function successText(t: T, kind: IntentKind, result: IntentResult): string {
  if (kind === "broadcast") {
    return t("result.broadcast", { code: result.broadcastResult ?? 0 });
  }
  if (kind !== "activity") return t("result.service");
  if (result.activity) {
    const name = shortComponent(result.activity);
    return result.totalTimeMs != null
      ? t("result.startedIn", { name, ms: result.totalTimeMs })
      : t("result.startedNamed", { name });
  }
  return t("result.started");
}

function RunResult({ last }: { last: LastRun }) {
  const { t } = useTranslation("intents");
  const [details, setDetails] = useState(false);
  const { result, error, kind } = last;

  let tone = "text-success";
  let icon = <Check className="size-3.5" aria-hidden />;
  let text: string;
  if (error) {
    tone = "text-error";
    icon = <X className="size-3.5" aria-hidden />;
    text = error;
  } else if (result?.outcome === "error") {
    tone = "text-error";
    icon = <X className="size-3.5" aria-hidden />;
    text = failureText(t, result);
  } else if (result?.outcome === "warning") {
    tone = "text-warning";
    icon = <TriangleAlert className="size-3.5" aria-hidden />;
    text = result.message ?? t("result.started");
  } else {
    text = result ? successText(t, kind, result) : "";
  }

  return (
    <span className="ml-auto flex min-w-0 flex-col items-end gap-1">
      <span
        className={cn("text-small flex items-center gap-1.5", tone)}
        role="status"
      >
        {icon}
        <span className="truncate">{text}</span>
        {result?.raw && (
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
            onClick={() => setDetails((d) => !d)}
          >
            {details ? t("hideDetails") : t("details")}
          </button>
        )}
      </span>
      {details && result?.raw && (
        <pre className="bg-sidebar text-caption text-secondary-foreground max-h-40 max-w-full overflow-auto rounded-md border px-2 py-1.5 font-mono whitespace-pre-wrap">
          {result.raw}
        </pre>
      )}
    </span>
  );
}

function TypeOnDevice({ serial }: { serial: string }) {
  const { t } = useTranslation("intents");
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!text) return;
    setSending(true);
    try {
      await inputText(serial, text);
      toast.success(t("textSent"));
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSending(false);
    }
  };

  const key = async (code: string) => {
    try {
      await inputKey(serial, code);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <section className="flex flex-col gap-2.5 border-t pt-3.5">
      <h2 className="text-[14px] font-semibold">{t("typeOnDevice")}</h2>
      <form onSubmit={send} className="flex items-center gap-2">
        <Input
          className={cn(monoFieldClass, "flex-1")}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t("textPlaceholder")}
          aria-label={t("textToSend")}
          spellCheck={false}
        />
        <Button type="submit" variant="outline" disabled={!text || sending}>
          {t("sendText")}
        </Button>
      </form>
      <div className="flex flex-wrap gap-1.5">
        {KEYS.map((k) => (
          <button
            key={k.key}
            type="button"
            aria-label={k.aria}
            title={`KEYCODE_${k.key}`}
            onClick={() => key(k.key)}
            className="border-input bg-card text-small hover:bg-accent focus-visible:outline-ring ease-spring-snappy h-ctl min-w-[46px] rounded-[7px] border border-b-2 px-2.5 font-medium transition-[background-color,transform] duration-[340ms] outline-none focus-visible:outline-2 active:scale-[.97]"
          >
            {k.label}
          </button>
        ))}
      </div>
    </section>
  );
}

function Sidebar({
  selected,
  onLoad,
}: {
  selected: string | null;
  onLoad: (kind: IntentKind, spec: IntentSpec, id: string) => void;
}) {
  const { t } = useTranslation("intents");
  const [tab, setTab] = useState<"history" | "favorites">("history");
  const history = useIntentsStore((s) => s.history);
  const favorites = useIntentsStore((s) => s.favorites);

  return (
    <aside
      className="flex min-w-0 flex-col gap-1 px-3.5 pt-1.5 pb-3.5"
      aria-label={t("history")}
    >
      <div className="mb-2 flex items-center">
        <UnderlineTabs
          label={t("history")}
          value={tab}
          onChange={setTab}
          className="flex-1"
          tabs={[
            { value: "history", label: t("history") },
            {
              value: "favorites",
              label: (
                <>
                  {t("favorites")}
                  {favorites.length > 0 && (
                    <span className="text-muted-foreground tabular-nums">
                      {favorites.length}
                    </span>
                  )}
                </>
              ),
            },
          ]}
        />
      </div>
      {tab === "history" ? (
        history.length === 0 ? (
          <Empty text={t("historyEmpty")} />
        ) : (
          <>
            {history.map((h) => (
              <HistoryRow
                key={h.id}
                entry={h}
                selected={selected === h.id}
                onClick={() => onLoad(h.kind, h.spec, h.id)}
              />
            ))}
            <Button
              variant="ghost"
              size="sm"
              className="mt-2 self-start"
              onClick={() => useIntentsStore.getState().clearHistory()}
            >
              {t("clearHistory")}
            </Button>
          </>
        )
      ) : favorites.length === 0 ? (
        <Empty text={t("favoritesEmpty")} />
      ) : (
        favorites.map((f) => (
          <FavoriteRow
            key={f.id}
            favorite={f}
            selected={selected === f.id}
            onClick={() => onLoad(f.kind, f.spec, f.id)}
          />
        ))
      )}
    </aside>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="text-small text-muted-foreground px-2 py-3">{text}</p>;
}

const rowClass =
  "text-small focus-visible:outline-ring flex h-ctl w-full items-center gap-2 overflow-hidden rounded-sm px-2 text-left font-mono whitespace-nowrap outline-none focus-visible:outline-2";

function HistoryRow({
  entry,
  selected,
  onClick,
}: {
  entry: HistoryEntry;
  selected: boolean;
  onClick: () => void;
}) {
  const label = specLabel(entry.kind, entry.spec);
  return (
    <div>
      <button
        type="button"
        onClick={onClick}
        title={label}
        className={cn(
          rowClass,
          selected
            ? "bg-selected text-foreground"
            : "text-secondary-foreground hover:bg-accent",
        )}
      >
        {entry.outcome === "error" ? (
          <X className="text-error size-[13px] flex-none" aria-hidden />
        ) : (
          <Check className="text-success size-[13px] flex-none" aria-hidden />
        )}
        <span className="truncate">{label}</span>
      </button>
      {entry.message && (
        <div className="text-caption text-muted-foreground truncate pr-2 pb-1 pl-[29px]">
          {entry.message}
        </div>
      )}
    </div>
  );
}

function FavoriteRow({
  favorite,
  selected,
  onClick,
}: {
  favorite: Favorite;
  selected: boolean;
  onClick: () => void;
}) {
  const { t } = useTranslation("intents");
  const label = specLabel(favorite.kind, favorite.spec);
  return (
    <div className="group relative">
      <button
        type="button"
        onClick={onClick}
        title={label}
        className={cn(
          rowClass,
          "pr-8",
          selected
            ? "bg-selected text-foreground"
            : "text-secondary-foreground hover:bg-accent",
        )}
      >
        <Star className="text-brand size-[13px] flex-none" aria-hidden />
        <span className="truncate">{label}</span>
      </button>
      <Button
        variant="ghost"
        size="icon-xs"
        className="absolute top-[3px] right-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        aria-label={t("removeFavorite")}
        onClick={() => useIntentsStore.getState().removeFavorite(favorite.id)}
      >
        <Trash2 />
      </Button>
    </div>
  );
}
