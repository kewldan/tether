import { Columns2, Pencil, Play, Plus, Search, Trash2, X } from "lucide-react";
import {
  type FormEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { useNavigation } from "@/app/navigation";
import { Page } from "@/components/layout/Page";
import { StatusDot } from "@/components/status/StatusDot";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { deviceName } from "@/features/devices/naming";
import { useDevices, useReadySerial } from "@/features/devices/store";
import {
  errorMessage,
  fieldClass,
  monoFieldClass,
  NeedsDevice,
  UnderlineTabs,
  useDeviceCrumb,
} from "@/features/performance/common";
import {
  type CommandOutput,
  execShell,
  fillSnippet,
  snippetParts,
  snippetVars,
} from "@/features/shell/api";
import {
  createSession,
  destroySession,
  getSession,
} from "@/features/shell/sessions";
import {
  type SessionMeta,
  type Snippet,
  useShellStore,
} from "@/features/shell/store";
import { hasMod, modKey } from "@/lib/platform";
import type { Device } from "@/lib/tauri";
import { cn } from "@/lib/utils";

/** Params already turned into a session (navigation params persist). */
let consumedParams: object | null = null;

export default function ShellPage() {
  const { t } = useTranslation();
  const serial = useReadySerial();
  const sessions = useShellStore((s) => s.sessions);
  const params = useNavigation((s) => s.params);

  // Open a tab for `navigate("shell", { cwd })` and on first visit.
  useEffect(() => {
    if (!serial) return;
    if (params.cwd && params !== consumedParams) {
      consumedParams = params;
      createSession(serial, params.cwd);
    } else if (useShellStore.getState().sessions.length === 0) {
      createSession(serial);
    }
  }, [serial, params]);

  // ⌘T: new tab on the selected device.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (hasMod(e) && e.key.toLowerCase() === "t" && serial) {
        e.preventDefault();
        createSession(serial);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [serial]);

  if (!serial && sessions.length === 0) {
    return <NeedsDevice title={t("nav.shell")} />;
  }
  return <ShellBody />;
}

function useDeviceLookup() {
  const devices = useDevices((s) => s.devices);
  return (serial: string): Device | undefined =>
    devices.find((d) => d.serial === serial);
}

function ShellBody() {
  const { t } = useTranslation("shell");
  const crumb = useDeviceCrumb();
  const sessions = useShellStore((s) => s.sessions);
  const active = useShellStore((s) => s.active);
  const split = useShellStore((s) => s.split);
  const activeMeta = sessions.find((s) => s.uid === active) ?? null;
  const serial = useReadySerial();

  const toggleSplit = () => {
    const store = useShellStore.getState();
    if (store.split) {
      store.setSplit(null);
      return;
    }
    const other = store.sessions.find((s) => s.uid !== store.active);
    if (other) {
      store.setSplit(other.uid);
    } else if (activeMeta) {
      const current = store.active;
      const uid = createSession(activeMeta.serial);
      store.setActive(current);
      store.setSplit(uid);
    }
  };

  const su = () => {
    if (activeMeta) getSession(activeMeta.uid)?.type("su\r");
  };

  return (
    <Page
      title={t("title")}
      parent={crumb}
      body="fill"
      actions={
        <>
          {activeMeta?.user === "root" ? (
            <Badge variant="warning">root</Badge>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              disabled={!activeMeta?.hasSu || activeMeta.status !== "running"}
              onClick={su}
              title={activeMeta?.hasSu ? t("suHint") : undefined}
            >
              {activeMeta?.hasSu === false ? t("suNotRooted") : "su"}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={toggleSplit}
            aria-pressed={split !== null}
            disabled={!activeMeta}
          >
            <Columns2 />
            {split ? t("unsplit") : t("split")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!activeMeta}
            onClick={() => activeMeta && getSession(activeMeta.uid)?.clear()}
          >
            {t("clear")}
            <Kbd>{modKey}K</Kbd>
          </Button>
        </>
      }
    >
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <SessionTabs
            sessions={sessions}
            active={active}
            split={split}
            defaultSerial={serial}
          />
          <div className="bg-background flex min-h-0 flex-1">
            {activeMeta ? (
              <TerminalPane uid={activeMeta.uid} />
            ) : (
              <div className="text-muted-foreground flex flex-1 items-center justify-center">
                {t("noSessions", { mod: modKey })}
              </div>
            )}
            {split && (
              <>
                <div className="bg-border w-px flex-none" />
                <TerminalPane uid={split} />
              </>
            )}
          </div>
          <div className="bg-sidebar text-caption text-muted-foreground flex flex-none items-center gap-2.5 border-t px-3 py-1.5">
            {activeMeta && (
              <span className="font-mono">
                {activeMeta.user} · {activeMeta.cols}×{activeMeta.rows}
              </span>
            )}
            <span className="truncate">{t("footerHint")}</span>
            <span className="ml-auto flex items-center gap-1.5 whitespace-nowrap">
              <Kbd>{modKey}T</Kbd>
              {t("newTab")}
            </span>
          </div>
        </div>
        <SnippetsPanel activeUid={activeMeta?.uid ?? null} />
      </div>
    </Page>
  );
}

function SessionTabs({
  sessions,
  active,
  split,
  defaultSerial,
}: {
  sessions: SessionMeta[];
  active: string | null;
  split: string | null;
  defaultSerial: string | null;
}) {
  const { t } = useTranslation("shell");
  const lookup = useDeviceLookup();
  const devices = useDevices((s) => s.devices).filter(
    (d) => d.state.kind === "device",
  );

  return (
    <div
      role="tablist"
      aria-label={t("sessions")}
      className="bg-sidebar flex flex-none items-center gap-1 overflow-x-auto border-b px-2.5 py-1.5"
    >
      {sessions.map((s) => {
        const on = s.uid === active;
        const device = lookup(s.serial);
        const name = device ? deviceName(device) : s.serial;
        const ended = s.status === "exited" || s.status === "error";
        return (
          <div
            key={s.uid}
            role="tab"
            tabIndex={0}
            aria-selected={on}
            onClick={() => useShellStore.getState().setActive(s.uid)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ")
                useShellStore.getState().setActive(s.uid);
            }}
            onAuxClick={(e) => e.button === 1 && destroySession(s.uid)}
            className={cn(
              "group text-small focus-visible:outline-ring flex h-[30px] flex-none cursor-default items-center gap-2 rounded-[7px] pr-1.5 pl-2.5 whitespace-nowrap outline-none focus-visible:outline-2",
              on
                ? "bg-background text-foreground ring-border ring-1"
                : s.uid === split
                  ? "text-foreground bg-accent"
                  : "text-secondary-foreground hover:bg-accent",
              ended && !on && "text-muted-foreground",
            )}
          >
            <StatusDot
              tone={
                ended
                  ? "neutral"
                  : s.status === "connecting"
                    ? "info"
                    : "success"
              }
            />
            {name}
            <span className="text-muted-foreground">
              · {ended ? t("exited") : s.user}
            </span>
            <Button
              variant="ghost"
              size="icon-xs"
              className={cn(
                "size-5",
                !on && "opacity-0 group-hover:opacity-100 hover:opacity-100",
              )}
              aria-label={t("closeSession")}
              onClick={(e) => {
                e.stopPropagation();
                destroySession(s.uid);
              }}
            >
              <X />
            </Button>
          </div>
        );
      })}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("newSession")}
            />
          }
        >
          <Plus />
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-64">
          <DropdownMenuGroup>
            <DropdownMenuLabel>{t("newSessionOn")}</DropdownMenuLabel>
            {devices.map((d) => (
              <DropdownMenuItem
                key={d.serial}
                onClick={() => createSession(d.serial)}
                className="gap-2.5"
              >
                <StatusDot tone="success" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{deviceName(d)}</span>
                  <span className="text-caption text-muted-foreground block truncate font-mono">
                    {d.serial}
                  </span>
                </span>
                {d.serial === defaultSerial && <Kbd>{modKey}T</Kbd>}
              </DropdownMenuItem>
            ))}
            {devices.length === 0 && (
              <DropdownMenuItem disabled>
                {t("noReadyDevices")}
              </DropdownMenuItem>
            )}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** Hosts a session's terminal element and keeps it fitted. */
function TerminalPane({ uid }: { uid: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const active = useShellStore((s) => s.active === uid);

  useLayoutEffect(() => {
    const container = ref.current;
    const session = getSession(uid);
    if (!container || !session) return;
    session.attach(container);
    const observer = new ResizeObserver(() => session.fitNow());
    observer.observe(container);
    return () => observer.disconnect();
  }, [uid]);

  useEffect(() => {
    if (active) getSession(uid)?.focus();
  }, [active, uid]);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: focusing the pane focuses its terminal
    <div
      className="min-w-0 flex-1 overflow-hidden py-3 pr-1 pl-4"
      onMouseDown={() => {
        if (!active) useShellStore.getState().setActive(uid);
      }}
    >
      <div ref={ref} className="h-full w-full" />
    </div>
  );
}

function SnippetsPanel({ activeUid }: { activeUid: string | null }) {
  const { t } = useTranslation("shell");
  const [tab, setTab] = useState<"snippets" | "history">("snippets");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<Snippet | null>(null);
  const snippets = useShellStore((s) => s.snippets);
  const history = useShellStore((s) => s.history);
  const vars = useShellStore((s) => s.vars);

  const q = query.trim().toLowerCase();
  const shownSnippets = snippets.filter(
    (s) =>
      !q ||
      s.name.toLowerCase().includes(q) ||
      s.command.toLowerCase().includes(q),
  );
  const shownHistory = history.filter((h) => !q || h.toLowerCase().includes(q));

  const type = (text: string) => {
    if (!activeUid) return;
    const session = getSession(activeUid);
    session?.type(text);
    session?.focus();
  };

  const run = (snippet: Snippet) => {
    const missing = snippetVars(snippet.command).filter((v) => !vars[v]);
    if (missing.length > 0) {
      setSelected(snippet.id);
      return;
    }
    type(`${fillSnippet(snippet.command, vars)}\r`);
  };

  const selectedSnippet = snippets.find((s) => s.id === selected) ?? null;

  return (
    <aside
      aria-label={t("snippets")}
      className="flex w-[300px] flex-none flex-col border-l"
    >
      <UnderlineTabs
        label={t("snippets")}
        value={tab}
        onChange={setTab}
        className="px-3.5"
        tabs={[
          { value: "snippets", label: t("snippets") },
          { value: "history", label: t("history") },
        ]}
      />
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-3">
        <div className="border-input bg-background focus-within:border-ring flex h-7 flex-none items-center gap-2 rounded-[7px] border px-2.5">
          <Search className="text-muted-foreground size-3.5" aria-hidden />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={
              tab === "snippets" ? t("searchSnippets") : t("searchHistory")
            }
            aria-label={
              tab === "snippets" ? t("searchSnippets") : t("searchHistory")
            }
            className="text-small placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent outline-none"
          />
        </div>

        {tab === "snippets" ? (
          <>
            {shownSnippets.map((s) =>
              editing?.id === s.id ? (
                <SnippetEditor
                  key={s.id}
                  snippet={editing}
                  onDone={() => setEditing(null)}
                />
              ) : (
                <SnippetCard
                  key={s.id}
                  snippet={s}
                  selected={selected === s.id}
                  canRun={activeUid !== null}
                  onSelect={() => setSelected(selected === s.id ? null : s.id)}
                  onRun={() => run(s)}
                  onEdit={() => setEditing(s)}
                />
              ),
            )}
            {editing && !snippets.some((s) => s.id === editing.id) ? (
              <SnippetEditor
                snippet={editing}
                onDone={() => setEditing(null)}
              />
            ) : (
              <Button
                variant="ghost"
                size="sm"
                className="justify-start"
                onClick={() =>
                  setEditing({ id: crypto.randomUUID(), name: "", command: "" })
                }
              >
                <Plus />
                {t("newSnippet")}
              </Button>
            )}
            {history.length > 0 && !q && (
              <>
                <div className="text-caption text-muted-foreground mt-2 font-semibold tracking-[.05em] uppercase">
                  {t("recent")}
                </div>
                {history.slice(0, 3).map((h) => (
                  <HistoryRow
                    key={h}
                    command={h}
                    onPick={() => type(h)}
                    onRun={() => type(`${h}\r`)}
                  />
                ))}
              </>
            )}
          </>
        ) : shownHistory.length === 0 ? (
          <p className="text-small text-muted-foreground px-1 py-2">
            {t("historyEmpty")}
          </p>
        ) : (
          <>
            {shownHistory.map((h) => (
              <HistoryRow
                key={h}
                command={h}
                onPick={() => type(h)}
                onRun={() => type(`${h}\r`)}
              />
            ))}
            <Button
              variant="ghost"
              size="sm"
              className="mt-1 self-start"
              onClick={() => useShellStore.getState().clearHistory()}
            >
              {t("clearHistory")}
            </Button>
          </>
        )}
      </div>
      <RunOnDevices snippet={selectedSnippet} />
    </aside>
  );
}

function SnippetCard({
  snippet,
  selected,
  canRun,
  onSelect,
  onRun,
  onEdit,
}: {
  snippet: Snippet;
  selected: boolean;
  canRun: boolean;
  onSelect: () => void;
  onRun: () => void;
  onEdit: () => void;
}) {
  const { t } = useTranslation("shell");
  const vars = useShellStore((s) => s.vars);
  const names = snippetVars(snippet.command);
  return (
    // biome-ignore lint/a11y/useSemanticElements: card contains its own buttons and inputs
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (
          e.target === e.currentTarget &&
          (e.key === "Enter" || e.key === " ")
        ) {
          e.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        "bg-card group focus-visible:outline-ring flex flex-col gap-[3px] rounded-md border px-2.5 py-2 outline-none focus-visible:outline-2",
        selected && "border-brand",
      )}
    >
      <div className="flex items-center justify-between gap-1">
        <span className="text-small truncate font-medium">{snippet.name}</span>
        <span className="flex flex-none items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon-xs"
            className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            aria-label={t("editSnippet")}
            onClick={(e) => {
              e.stopPropagation();
              onEdit();
            }}
          >
            <Pencil />
          </Button>
          <Button
            variant="outline"
            size="xs"
            className="h-[22px]"
            disabled={!canRun}
            onClick={(e) => {
              e.stopPropagation();
              onRun();
            }}
          >
            {t("run")}
          </Button>
        </span>
      </div>
      <code className="text-secondary-foreground truncate font-mono text-[11px]">
        {snippetParts(snippet.command).map((p) =>
          p.isVar ? (
            <span
              key={p.at}
              className="text-brand bg-brand/15 rounded-[3px] px-0.5"
            >
              {p.text}
            </span>
          ) : (
            p.text
          ),
        )}
      </code>
      {selected && names.length > 0 && (
        // biome-ignore lint/a11y/noStaticElementInteractions: stops clicks from toggling the card
        // biome-ignore lint/a11y/useKeyWithClickEvents: same
        <div className="mt-1 flex gap-1" onClick={(e) => e.stopPropagation()}>
          {names.map((name) => (
            <Input
              key={name}
              value={vars[name] ?? ""}
              placeholder={name}
              aria-label={name}
              spellCheck={false}
              onChange={(e) =>
                useShellStore.getState().setVar(name, e.target.value)
              }
              onKeyDown={(e) => e.key === "Enter" && onRun()}
              className={cn(
                monoFieldClass,
                "h-6 min-w-0 flex-1 px-1.5 text-[11px] md:text-[11px]",
              )}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SnippetEditor({
  snippet,
  onDone,
}: {
  snippet: Snippet;
  onDone: () => void;
}) {
  const { t } = useTranslation("shell");
  const [name, setName] = useState(snippet.name);
  const [command, setCommand] = useState(snippet.command);
  const exists = useShellStore((s) =>
    s.snippets.some((x) => x.id === snippet.id),
  );

  const save = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !command.trim()) return;
    useShellStore.getState().saveSnippet({
      id: snippet.id,
      name: name.trim(),
      command: command.trim(),
    });
    onDone();
  };

  return (
    <form
      onSubmit={save}
      className="bg-card flex flex-col gap-1.5 rounded-md border px-2.5 py-2"
    >
      <Input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={t("snippetName")}
        aria-label={t("snippetName")}
        className={cn(fieldClass, "h-7")}
      />
      <Textarea
        value={command}
        onChange={(e) => setCommand(e.target.value)}
        placeholder={t("snippetCommand")}
        aria-label={t("snippetCommand")}
        spellCheck={false}
        rows={2}
        className="border-input bg-background dark:bg-background min-h-0 rounded-[7px] px-2 py-1 font-mono text-[11px] md:text-[11px]"
      />
      <p className="text-caption text-muted-foreground">
        {t("snippetVarsHint")}
      </p>
      <div className="flex items-center gap-1.5">
        {exists && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t("deleteSnippet")}
            onClick={() => {
              useShellStore.getState().deleteSnippet(snippet.id);
              onDone();
            }}
          >
            <Trash2 />
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto"
          onClick={onDone}
        >
          {t("cancel")}
        </Button>
        <Button
          type="submit"
          size="sm"
          disabled={!name.trim() || !command.trim()}
        >
          {t("save")}
        </Button>
      </div>
    </form>
  );
}

function HistoryRow({
  command,
  onPick,
  onRun,
}: {
  command: string;
  onPick: () => void;
  onRun: () => void;
}) {
  const { t } = useTranslation("shell");
  return (
    <div className="group hover:bg-accent flex h-[26px] flex-none items-center rounded-md">
      <button
        type="button"
        onClick={onPick}
        title={t("insertHint")}
        className="text-secondary-foreground focus-visible:outline-ring min-w-0 flex-1 truncate px-2 text-left font-mono text-[12px] outline-none focus-visible:outline-2"
      >
        {command}
      </button>
      <Button
        variant="ghost"
        size="icon-xs"
        className="mr-0.5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        aria-label={t("runNow")}
        onClick={onRun}
      >
        <Play />
      </Button>
    </div>
  );
}

interface DeviceResult {
  serial: string;
  output: CommandOutput | null;
  error: string | null;
}

function RunOnDevices({ snippet }: { snippet: Snippet | null }) {
  const { t } = useTranslation("shell");
  const lookup = useDeviceLookup();
  const ready = useDevices((s) => s.devices).filter(
    (d) => d.state.kind === "device",
  );
  const selectedSerial = useReadySerial();
  const stored = useShellStore((s) => s.targets);
  const vars = useShellStore((s) => s.vars);
  const targets = stored.filter((s) => ready.some((d) => d.serial === s));
  const effective =
    targets.length > 0 ? targets : selectedSerial ? [selectedSerial] : [];
  const [results, setResults] = useState<DeviceResult[] | null>(null);
  const [command, setCommand] = useState("");

  const toggle = (serial: string, on: boolean) => {
    const next = on
      ? [...new Set([...effective, serial])]
      : effective.filter((s) => s !== serial);
    useShellStore.getState().setTargets(next);
  };

  const missing = snippet
    ? snippetVars(snippet.command).filter((v) => !vars[v])
    : [];
  const canRun =
    snippet !== null && missing.length === 0 && effective.length > 0;

  const runAll = async () => {
    if (!snippet) return;
    const cmd = fillSnippet(snippet.command, vars);
    setCommand(cmd);
    setResults(
      effective.map((serial) => ({ serial, output: null, error: null })),
    );
    await Promise.all(
      effective.map(async (serial) => {
        let result: DeviceResult;
        try {
          result = {
            serial,
            output: await execShell(serial, cmd),
            error: null,
          };
        } catch (e) {
          result = { serial, output: null, error: errorMessage(e) };
        }
        setResults(
          (prev) =>
            prev?.map((r) => (r.serial === serial ? result : r)) ?? null,
        );
      }),
    );
  };

  const name = (serial: string) => {
    const d = lookup(serial);
    return d ? deviceName(d) : serial;
  };

  return (
    <div className="flex flex-none flex-col gap-2 border-t p-3">
      <div className="text-small flex items-center justify-between gap-2">
        <span className="text-secondary-foreground">{t("runOn")}</span>
        <Popover>
          <PopoverTrigger
            className="focus-visible:outline-ring flex min-w-0 items-center gap-1 rounded-sm outline-none focus-visible:outline-2"
            aria-label={t("chooseDevices")}
          >
            {effective.slice(0, 2).map((s) => (
              <Badge key={s} variant="brand" className="max-w-[96px] truncate">
                {name(s)}
              </Badge>
            ))}
            {effective.length > 2 && <Badge>+{effective.length - 2}</Badge>}
            {effective.length === 0 && <Badge>{t("noDevices")}</Badge>}
          </PopoverTrigger>
          <PopoverContent align="end" className="w-64 gap-1 p-1.5">
            {ready.map((d) => (
              // biome-ignore lint/a11y/noLabelWithoutControl: wraps the checkbox
              <label
                key={d.serial}
                className="hover:bg-accent text-small flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5"
              >
                <Checkbox
                  checked={effective.includes(d.serial)}
                  onCheckedChange={(on) => toggle(d.serial, on)}
                />
                <span className="min-w-0 flex-1 truncate">{deviceName(d)}</span>
                <span className="text-caption text-muted-foreground truncate font-mono">
                  {d.serial}
                </span>
              </label>
            ))}
            {ready.length === 0 && (
              <p className="text-small text-muted-foreground px-2 py-1.5">
                {t("noReadyDevices")}
              </p>
            )}
          </PopoverContent>
        </Popover>
      </div>
      <Button
        variant="outline"
        size="sm"
        className="w-full"
        disabled={!canRun}
        onClick={runAll}
      >
        {snippet
          ? t("runSnippetOn", { count: effective.length })
          : t("selectSnippet")}
      </Button>

      <Dialog
        open={results !== null}
        onOpenChange={(o) => !o && setResults(null)}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{snippet?.name ?? t("results")}</DialogTitle>
            <DialogDescription className="font-mono text-[11px] break-all">
              {command}
            </DialogDescription>
          </DialogHeader>
          <div className="flex max-h-[60vh] flex-col gap-3 overflow-auto">
            {results?.map((r) => (
              <section key={r.serial} className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2">
                  <span className="font-semibold">{name(r.serial)}</span>
                  <span className="text-caption text-muted-foreground font-mono">
                    {r.serial}
                  </span>
                  <span className="ml-auto">
                    <ResultBadge result={r} />
                  </span>
                </div>
                {(r.output || r.error) && (
                  <pre className="bg-sidebar text-small max-h-48 overflow-auto rounded-md border px-2.5 py-2 font-mono whitespace-pre-wrap">
                    {r.error ? (
                      <span className="text-error">{r.error}</span>
                    ) : (
                      <>
                        {r.output?.stdout}
                        {r.output?.stderr && (
                          <span className="text-error">{r.output.stderr}</span>
                        )}
                        {!r.output?.stdout && !r.output?.stderr && (
                          <span className="text-muted-foreground">
                            {t("noOutput")}
                          </span>
                        )}
                      </>
                    )}
                  </pre>
                )}
              </section>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ResultBadge({ result }: { result: DeviceResult }) {
  const { t } = useTranslation("shell");
  if (result.error) {
    return (
      <Badge variant="error">
        <StatusDot tone="error" />
        {t("failed")}
      </Badge>
    );
  }
  if (!result.output) {
    return (
      <Badge variant="info">
        <StatusDot tone="info" />
        {t("running")}
      </Badge>
    );
  }
  const code = result.output.exitCode;
  if (code === null) {
    return (
      <Badge>
        <StatusDot tone="neutral" />
        {t("done")}
      </Badge>
    );
  }
  return code === 0 ? (
    <Badge variant="success">
      <StatusDot tone="success" />
      {t("exitCode", { code })}
    </Badge>
  ) : (
    <Badge variant="error">
      <StatusDot tone="error" />
      {t("exitCode", { code })}
    </Badge>
  );
}
