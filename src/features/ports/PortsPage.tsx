import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bug,
  ChevronRight,
  Globe,
  Plus,
  RotateCw,
  Webhook,
  X,
} from "lucide-react";
import { type FormEvent, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Page } from "@/components/layout/Page";
import { StatusDot } from "@/components/status/StatusDot";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useReadySerial } from "@/features/devices/store";
import {
  ConfirmDialog,
  errorMessage,
  NeedsDevice,
  Segmented,
  useDeviceCrumb,
} from "@/features/performance/common";
import {
  addPort,
  type Direction,
  freeHostPort,
  type HostPortUsage,
  isAddressInUse,
  knownLabel,
  type PortOwner,
  parseSpec,
  removeAllPorts,
  removePort,
  ruleKey,
  type SpecResult,
  shortSpec,
  tcpPort,
} from "@/features/ports/api";
import {
  portsKey,
  useHostPortUsage,
  usePortRules,
  usePortRulesAutoRestore,
} from "@/features/ports/queries";
import { type SavedRule, usePortsStore } from "@/features/ports/store";
import { isMac } from "@/lib/platform";
import { cn } from "@/lib/utils";

interface Row {
  direction: Direction;
  local: string;
  remote: string;
  label: string | null;
  active: boolean;
  error: string | null;
}

interface Draft {
  direction: Direction;
  from: string;
  to: string;
}

const EMPTY: SavedRule[] = [];

const toSaved = (row: Row): SavedRule => ({
  direction: row.direction,
  local: row.local,
  remote: row.remote,
});
const NO_ERRORS: Record<string, string> = {};

function useHostName() {
  const { t } = useTranslation("ports");
  return isMac ? t("host.mac") : t("host.pc");
}

export default function PortsPage() {
  const { t } = useTranslation("ports");
  const { t: tc } = useTranslation();
  const serial = useReadySerial();
  const crumb = useDeviceCrumb(true);
  usePortRulesAutoRestore();

  if (!serial) return <NeedsDevice title={tc("nav.ports")} />;
  return <PortsBody serial={serial} crumb={crumb} title={t("title")} />;
}

function PortsBody({
  serial,
  crumb,
  title,
}: {
  serial: string;
  crumb: ReturnType<typeof useDeviceCrumb>;
  title: string;
}) {
  const { t } = useTranslation("ports");
  const host = useHostName();
  const queryClient = useQueryClient();
  const { data, isLoading } = usePortRules(serial);
  const saved = usePortsStore((s) => s.saved[serial] ?? EMPTY);
  const errors = usePortsStore((s) => s.errors[serial] ?? NO_ERRORS);
  const [draft, setDraft] = useState<Draft>({
    direction: "forward",
    from: "8081",
    to: "8081",
  });
  const [confirmAll, setConfirmAll] = useState(false);
  const toInput = useRef<HTMLInputElement>(null);

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: portsKey(serial) });

  const rows = (direction: Direction): Row[] => {
    const active = data?.[direction] ?? [];
    const out: Row[] = active.map((r) => {
      const s = saved.find(
        (x) => x.direction === direction && x.local === r.local,
      );
      const known = knownLabel(r);
      return {
        direction,
        local: r.local,
        remote: r.remote,
        label: s?.label ?? (known ? t(known) : null),
        active: true,
        error: null,
      };
    });
    for (const s of saved) {
      if (s.direction !== direction) continue;
      if (out.some((r) => r.local === s.local)) continue;
      const known = knownLabel(s);
      out.push({
        direction,
        local: s.local,
        remote: s.remote,
        label: s.label ?? (known ? t(known) : null),
        active: false,
        error: errors[ruleKey(direction, s.local)] ?? null,
      });
    }
    return out;
  };

  /** Adds a rule, remembering it (with its error) for re-apply. */
  const apply = async (rule: SavedRule, quiet = false) => {
    const { save, setError } = usePortsStore.getState();
    save(serial, rule);
    try {
      await addPort(serial, rule.direction, rule.local, rule.remote);
      setError(serial, rule.direction, rule.local, null);
      if (!quiet) {
        toast.success(
          t("added", {
            from: shortSpec(rule.local),
            to: shortSpec(rule.remote),
          }),
        );
      }
    } catch (e) {
      const message = errorMessage(e);
      setError(serial, rule.direction, rule.local, message);
      if (!isAddressInUse(message)) toast.error(message);
    } finally {
      void refresh();
    }
  };

  const remove = async (row: Row) => {
    usePortsStore.getState().unsave(serial, row.direction, row.local);
    usePortsStore.getState().setError(serial, row.direction, row.local, null);
    if (row.active) {
      try {
        await removePort(serial, row.direction, row.local);
      } catch (e) {
        toast.error(errorMessage(e));
      }
    }
    void refresh();
  };

  const removeAll = async () => {
    usePortsStore.getState().clear(serial);
    try {
      await removeAllPorts(serial);
    } catch (e) {
      toast.error(errorMessage(e));
    }
    void refresh();
  };

  const forwardRows = rows("forward");
  const usage = useHostPortUsage(
    forwardRows.flatMap((r) => tcpPort(r.local) ?? []),
  );

  const total =
    (data?.forward.length ?? 0) + (data?.reverse.length ?? 0) + saved.length;

  return (
    <Page
      title={title}
      parent={crumb}
      className="py-4"
      actions={
        <Button
          variant="ghost"
          size="sm"
          disabled={total === 0}
          onClick={() => setConfirmAll(true)}
        >
          {t("removeAll")}
        </Button>
      }
    >
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="flex min-w-0 flex-col gap-4">
          <AddRule
            draft={draft}
            setDraft={setDraft}
            toInput={toInput}
            onAdd={(rule) => apply(rule)}
          />
          <RulesCard
            direction="forward"
            rows={forwardRows}
            usage={usage}
            loading={isLoading}
            serial={serial}
            onRemove={remove}
            onApply={(row) => apply(toSaved(row), true)}
          />
          <RulesCard
            direction="reverse"
            rows={rows("reverse")}
            loading={isLoading}
            serial={serial}
            onRemove={remove}
            onApply={(row) => apply(toSaved(row), true)}
          />
        </div>
        <Presets
          onApply={(rules) => {
            for (const rule of rules) void apply(rule);
          }}
          onPrefill={(next) => {
            setDraft(next);
            requestAnimationFrame(() => toInput.current?.focus());
          }}
        />
      </div>
      <ConfirmDialog
        open={confirmAll}
        onOpenChange={setConfirmAll}
        title={t("removeAllTitle")}
        description={t("removeAllBody", { host })}
        confirmLabel={t("removeAll")}
        onConfirm={() => void removeAll()}
      />
    </Page>
  );
}

const fieldWrap =
  "border-input bg-background focus-within:border-ring focus-within:ring-ring/25 flex h-7 items-center rounded-[7px] border pl-2 focus-within:ring-3 has-aria-invalid:border-error";

function SpecField({
  value,
  onChange,
  label,
  className,
  invalid,
  inputRef,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  className?: string;
  invalid: boolean;
  inputRef?: React.Ref<HTMLInputElement>;
}) {
  const showPrefix = !value.includes(":");
  return (
    <span className={cn(fieldWrap, className)}>
      {showPrefix && (
        <span className="text-caption text-muted-foreground font-mono">
          tcp:
        </span>
      )}
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        aria-invalid={invalid || undefined}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        className="text-small min-w-0 flex-1 bg-transparent pr-2 font-mono tabular-nums outline-none"
      />
    </span>
  );
}

function specError(
  t: (key: string, o?: Record<string, string>) => string,
  r: SpecResult,
  side: string,
) {
  if (r.ok || r.reason === "empty") return null;
  return t(`invalid.${r.reason}`, { side });
}

function AddRule({
  draft,
  setDraft,
  toInput,
  onAdd,
}: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  toInput: React.RefObject<HTMLInputElement | null>;
  onAdd: (rule: SavedRule) => Promise<void>;
}) {
  const { t } = useTranslation("ports");
  const host = useHostName();
  const [busy, setBusy] = useState(false);
  const forward = draft.direction === "forward";
  // Forward listens on this computer; reverse listens on the device.
  const from = parseSpec(draft.from, forward);
  const to = parseSpec(draft.to, !forward);
  const fromSide = forward ? host : t("device");
  const toSide = forward ? t("device") : host;
  const error =
    specError(t, from, fromSide) ?? specError(t, to, toSide) ?? null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!from.ok || !to.ok) return;
    setBusy(true);
    await onAdd({
      direction: draft.direction,
      local: from.spec,
      remote: to.spec,
    });
    setBusy(false);
  };

  return (
    <form
      onSubmit={submit}
      className="bg-card flex flex-col gap-2.5 rounded-lg border p-3.5"
    >
      <div className="font-semibold">{t("addRule")}</div>
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          label={t("direction")}
          value={draft.direction}
          onChange={(direction) => setDraft({ ...draft, direction })}
          options={[
            { value: "forward", label: t("forwardOption", { host }) },
            { value: "reverse", label: t("reverseOption", { host }) },
          ]}
        />
        <SpecField
          className="w-[140px]"
          value={draft.from}
          onChange={(v) => setDraft({ ...draft, from: v })}
          label={forward ? t("hostPort", { host }) : t("devicePort")}
          invalid={!from.ok && from.reason !== "empty"}
        />
        <span className="text-muted-foreground" aria-hidden>
          →
        </span>
        <SpecField
          className="w-[200px]"
          value={draft.to}
          inputRef={toInput}
          onChange={(v) => setDraft({ ...draft, to: v })}
          label={forward ? t("deviceSocket") : t("hostPort", { host })}
          invalid={!to.ok && to.reason !== "empty"}
        />
        <Button type="submit" size="sm" disabled={!from.ok || !to.ok || busy}>
          {t("add")}
        </Button>
      </div>
      {error ? (
        <div className="text-small text-error" role="alert">
          {error}
        </div>
      ) : (
        <div className="text-small text-muted-foreground">
          {forward ? (
            <>
              {t("deviceAccepts")}{" "}
              <span className="font-mono">localabstract:</span>,{" "}
              <span className="font-mono">localfilesystem:</span> {t("and")}{" "}
              <span className="font-mono">jdwp:</span>.
            </>
          ) : (
            t("reverseHint", { host })
          )}
        </div>
      )}
    </form>
  );
}

function RulesCard({
  direction,
  rows,
  usage,
  loading,
  serial,
  onRemove,
  onApply,
}: {
  direction: Direction;
  rows: Row[];
  /** Host-port usage by port (forward rules only). */
  usage?: Map<number, HostPortUsage>;
  loading: boolean;
  serial: string;
  onRemove: (row: Row) => void;
  onApply: (row: Row) => void;
}) {
  const { t } = useTranslation("ports");
  const host = useHostName();
  const portUsage = (row: Row) => {
    const port = tcpPort(row.local);
    return port === null ? undefined : usage?.get(port);
  };
  const forward = direction === "forward";
  const inUse = rows.filter((r) => r.error && isAddressInUse(r.error));

  return (
    <section className="bg-card overflow-hidden rounded-lg border">
      <div className="flex items-center gap-2.5 border-b px-3.5 py-2.5">
        <h2 className="font-semibold">
          {forward ? t("forward") : t("reverse")}
        </h2>
        <span className="text-small text-muted-foreground">
          {forward ? t("forwardSub", { host }) : t("reverseSub", { host })} ·{" "}
          <span className="font-mono">
            {forward ? "adb forward" : "adb reverse"}
          </span>
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr className="text-small text-muted-foreground">
              <Th>{forward ? host : t("device")}</Th>
              <Th className="w-6" />
              <Th>{forward ? t("device") : host}</Th>
              <Th>{t("label")}</Th>
              <Th>{t("status")}</Th>
              <Th className="w-[72px]" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <RuleRow
                key={row.local}
                row={row}
                usage={portUsage(row)}
                serial={serial}
                onRemove={() => onRemove(row)}
                onApply={() => onApply(row)}
              />
            ))}
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={6}
                  className="text-muted-foreground h-16 px-3 text-center"
                >
                  {loading ? t("loading") : t("empty")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {inUse.map((row) => (
        <PortInUse
          key={row.local}
          row={row}
          owner={portUsage(row)?.listener ?? null}
          onUse={(local) => {
            onRemove(row);
            onApply({ ...row, local });
          }}
        />
      ))}
    </section>
  );
}

function Th({
  className,
  children,
}: {
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <th
      className={cn(
        "bg-card h-row border-b px-3 text-left font-medium whitespace-nowrap",
        className,
      )}
    >
      {children}
    </th>
  );
}

function RuleRow({
  row,
  usage,
  serial,
  onRemove,
  onApply,
}: {
  row: Row;
  usage?: HostPortUsage;
  serial: string;
  onRemove: () => void;
  onApply: () => void;
}) {
  const { t } = useTranslation("ports");
  const host = useHostName();
  const inUse = row.error ? isAddressInUse(row.error) : false;
  const cell = "h-row border-b px-3 whitespace-nowrap";

  return (
    <tr
      className={cn(
        "group text-small font-mono",
        row.error ? "bg-error/12" : "hover:bg-accent",
      )}
    >
      <td className={cell}>{row.local}</td>
      <td className={cn(cell, "text-muted-foreground px-0 font-sans")}>→</td>
      <td className={cn(cell, "max-w-[280px] truncate")} title={row.remote}>
        {row.remote}
      </td>
      <td className={cn(cell, "font-sans")}>
        <LabelCell serial={serial} row={row} />
      </td>
      <td className={cn(cell, "font-sans")}>
        {row.active && usage?.connections === 0 ? (
          <Badge title={t("idleHint")}>
            <StatusDot tone="neutral" />
            {t("idle")}
          </Badge>
        ) : row.active ? (
          <Badge variant="success">
            <StatusDot tone="success" />
            {usage
              ? t("activeConns", { count: usage.connections })
              : t("active")}
          </Badge>
        ) : row.error ? (
          <Badge variant="error" title={row.error}>
            <StatusDot tone="error" />
            {inUse
              ? row.direction === "forward"
                ? t("hostPortInUse", { host })
                : t("devicePortInUse")
              : t("failed")}
          </Badge>
        ) : (
          <Badge>
            <StatusDot tone="neutral" />
            {t("inactive")}
          </Badge>
        )}
      </td>
      <td className={cn(cell, "px-1.5 text-right")}>
        <span className="inline-flex gap-0.5">
          {!row.active && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("retry")}
              title={t("retry")}
              onClick={onApply}
            >
              <RotateCw />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("remove")}
            title={t("remove")}
            onClick={onRemove}
          >
            <X />
          </Button>
        </span>
      </td>
    </tr>
  );
}

function LabelCell({ serial, row }: { serial: string; row: Row }) {
  const { t } = useTranslation("ports");
  const [editing, setEditing] = useState(false);
  const commit = (value: string) => {
    const store = usePortsStore.getState();
    const isSaved = (store.saved[serial] ?? []).some(
      (r) => r.direction === row.direction && r.local === row.local,
    );
    if (!isSaved) {
      store.save(serial, {
        direction: row.direction,
        local: row.local,
        remote: row.remote,
      });
    }
    store.setLabel(serial, row.direction, row.local, value.trim());
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        // biome-ignore lint/a11y/noAutofocus: opened by an explicit click
        autoFocus
        defaultValue={row.label ?? ""}
        aria-label={t("label")}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit(e.currentTarget.value);
          if (e.key === "Escape") setEditing(false);
        }}
        className="border-ring bg-background text-small h-6 w-40 rounded-sm border px-1.5 outline-none"
      />
    );
  }
  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className={cn(
        "focus-visible:outline-ring rounded-sm text-left outline-none focus-visible:outline-2",
        row.label
          ? "text-foreground"
          : "text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
      )}
    >
      {row.label ?? t("addLabel")}
    </button>
  );
}

function PortInUse({
  row,
  owner,
  onUse,
}: {
  row: Row;
  owner: PortOwner | null;
  onUse: (local: string) => void;
}) {
  const { t } = useTranslation("ports");
  const host = useHostName();
  const port = tcpPort(row.local);
  const forward = row.direction === "forward";
  const { data: suggestion } = useQuery({
    queryKey: ["ports-free", port],
    queryFn: () => freeHostPort((port ?? 8000) + 1),
    enabled: forward && port !== null,
    staleTime: 10_000,
  });

  return (
    <div className="bg-error/12 text-small flex items-center gap-2 border-t px-3.5 py-2">
      <span>
        {!forward ? (
          t("inUseDevice", { port: shortSpec(row.local) })
        ) : owner ? (
          <Trans
            t={t}
            i18nKey={owner.name ? "inUseHostBy" : "inUseHostByPid"}
            values={{ port, host, name: owner.name, pid: owner.pid }}
            components={{ b: <b className="font-semibold" /> }}
          />
        ) : (
          t("inUseHost", { port, host })
        )}
      </span>
      {forward && suggestion != null && (
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          onClick={() => onUse(`tcp:${suggestion}`)}
        >
          {t("useInstead", { port: suggestion })}
        </Button>
      )}
    </div>
  );
}

interface Preset {
  id: string;
  icon: React.ReactNode;
  tone: string;
  title: string;
  detail: string;
  rules?: SavedRule[];
  prefill?: Draft;
}

function Presets({
  onApply,
  onPrefill,
}: {
  onApply: (rules: SavedRule[]) => void;
  onPrefill: (draft: Draft) => void;
}) {
  const { t } = useTranslation("ports");
  const presets: Preset[] = [
    {
      id: "metro",
      icon: <span className="text-caption font-bold">RN</span>,
      tone: "text-chart-1",
      title: t("labels.metro"),
      detail: "reverse tcp:8081",
      rules: [
        {
          direction: "reverse",
          local: "tcp:8081",
          remote: "tcp:8081",
          label: t("labels.metro"),
        },
      ],
    },
    {
      id: "devtools",
      icon: <Globe className="size-4" aria-hidden />,
      tone: "text-chart-2",
      title: t("labels.chromeDevtools"),
      detail: "forward 9222 → devtools",
      rules: [
        {
          direction: "forward",
          local: "tcp:9222",
          remote: "localabstract:chrome_devtools_remote",
          label: t("labels.chromeDevtools"),
        },
      ],
    },
    {
      id: "jdwp",
      icon: <Bug className="size-4" aria-hidden />,
      tone: "text-chart-3",
      title: t("labels.javaDebugger"),
      detail: "forward 5005 → jdwp:<pid>",
      prefill: { direction: "forward", from: "5005", to: "jdwp:" },
    },
    {
      id: "flipper",
      icon: <Webhook className="size-4" aria-hidden />,
      tone: "text-chart-4",
      title: t("labels.flipper"),
      detail: "reverse 8088, 8089",
      rules: ["tcp:8088", "tcp:8089"].map((p) => ({
        direction: "reverse" as const,
        local: p,
        remote: p,
        label: t("labels.flipper"),
      })),
    },
  ];

  return (
    <aside className="flex flex-col gap-2" aria-label={t("presets")}>
      <div className="text-caption text-muted-foreground font-semibold tracking-[.05em] uppercase">
        {t("presets")}
      </div>
      {presets.map((p) => (
        <button
          key={p.id}
          type="button"
          onClick={() =>
            p.rules ? onApply(p.rules) : p.prefill && onPrefill(p.prefill)
          }
          className="bg-card hover:bg-accent focus-visible:outline-ring ease-spring-snappy flex w-full items-center gap-2.5 rounded-[9px] border px-3 py-2.5 text-left transition-[background-color,transform] duration-[340ms] outline-none focus-visible:outline-2 active:scale-[.985]"
        >
          <span
            className={cn(
              "bg-selected flex size-[30px] flex-none items-center justify-center rounded-[7px]",
              p.tone,
            )}
          >
            {p.icon}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block font-medium">{p.title}</span>
            <span className="text-caption text-muted-foreground block truncate font-mono">
              {p.detail}
            </span>
          </span>
          {p.rules ? (
            <Plus className="text-muted-foreground size-4" aria-hidden />
          ) : (
            <ChevronRight
              className="text-muted-foreground size-4"
              aria-hidden
            />
          )}
        </button>
      ))}
      <p className="text-small text-muted-foreground mt-1.5">
        {t("reapplied")}
      </p>
    </aside>
  );
}
