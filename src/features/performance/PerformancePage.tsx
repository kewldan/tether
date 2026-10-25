import { useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "cn";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  Download,
  Pause,
  Play,
  Search,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Page } from "@/components/layout/Page";
import { StatusDot } from "@/components/status/StatusDot";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useReadySerial } from "@/features/devices/store";
import {
  appPackage,
  type CpuInfo,
  exportCsv,
  killProcess,
  listProcesses,
  type PerfSample,
  type Process,
  SAMPLE_INTERVAL_MS,
  subscribePerf,
  type TimeWindow,
  unsubscribePerf,
  usePerfPrefs,
} from "@/features/performance/api";
import {
  ConfirmDialog,
  errorMessage,
  NeedsDevice,
  Segmented,
  useDeviceCrumb,
} from "@/features/performance/common";
import { LineChart, Swatch } from "@/features/performance/LineChart";
import type { AppError } from "@/lib/tauri";

const KEEP_MS = 300_000;

export default function PerformancePage() {
  const { t } = useTranslation();
  const serial = useReadySerial();
  if (!serial) return <NeedsDevice title={t("nav.performance")} />;
  return <PerformanceBody key={serial} serial={serial} />;
}

function usePerfStream(serial: string, pkg: string | null, paused: boolean) {
  const [samples, setSamples] = useState<PerfSample[]>([]);
  const [cpu, setCpu] = useState<CpuInfo | null>(null);
  const [error, setError] = useState<AppError | null>(null);

  useEffect(() => {
    if (paused) return;
    let cancelled = false;
    let id: number | null = null;
    setError(null);
    subscribePerf(serial, pkg, (event) => {
      if (cancelled) return;
      if (event.type === "info") setCpu(event.cpu);
      else if (event.type === "error") setError(event.error);
      else {
        const s = event.sample;
        setSamples((prev) => {
          const next = prev.filter(
            (p) => p.time > s.time - KEEP_MS && p.time !== s.time,
          );
          next.push(s);
          // Keep time order even if a stale subscription's sample sneaks in.
          if (next.length > 1 && (next.at(-2)?.time ?? 0) > s.time) {
            next.sort((a, b) => a.time - b.time);
          }
          return next;
        });
      }
    })
      .then((sub) => {
        if (cancelled) void unsubscribePerf(sub);
        else id = sub;
      })
      .catch((e: AppError) => setError(e));
    return () => {
      cancelled = true;
      if (id !== null) void unsubscribePerf(id);
    };
  }, [serial, pkg, paused]);

  return { samples, cpu, error };
}

function PerformanceBody({ serial }: { serial: string }) {
  const { t } = useTranslation("performance");
  const crumb = useDeviceCrumb();
  const windowSec = usePerfPrefs((s) => s.window);
  const setWindow = usePerfPrefs((s) => s.setWindow);
  const fpsPackage = usePerfPrefs((s) => s.fpsPackage);
  const [paused, setPaused] = useState(false);
  const { samples, cpu, error } = usePerfStream(serial, fpsPackage, paused);

  const windowMs = windowSec * 1000;
  const now = samples.at(-1)?.time ?? Date.now();
  const visible = useMemo(
    () => samples.filter((s) => s.time >= now - windowMs - SAMPLE_INTERVAL_MS),
    [samples, now, windowMs],
  );
  const latest = samples.at(-1) ?? null;
  const span =
    windowSec === 300
      ? t("minutes", { count: 5 })
      : t("seconds", { count: windowSec });

  const exportSamples = async () => {
    if (samples.length === 0) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const name = `tether-perf-${serial.replace(/[^\w.-]/g, "_")}-${stamp}.csv`;
    try {
      const path = await exportCsv(name, toCsv(samples));
      toast.success(t("exported"), { description: path });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <Page
      title={
        <span className="flex items-center gap-1.5">
          {t("title")}
          {error ? (
            <Badge variant="error" className="ml-1.5" title={error.message}>
              <StatusDot tone="error" />
              {t("stopped")}
            </Badge>
          ) : paused ? (
            <Badge className="ml-1.5">
              <StatusDot tone="neutral" />
              {t("paused")}
            </Badge>
          ) : (
            <Badge variant="success" className="ml-1.5">
              <StatusDot tone="success" />
              {t("sampling", { ms: SAMPLE_INTERVAL_MS })}
            </Badge>
          )}
        </span>
      }
      parent={crumb}
      className="flex flex-col gap-3 py-4"
      actions={
        <>
          <Segmented<`${TimeWindow}`>
            label={t("window")}
            value={`${windowSec}`}
            onChange={(v) => setWindow(Number(v) as TimeWindow)}
            options={[
              { value: "30", label: t("seconds", { count: 30 }) },
              { value: "60", label: t("minutes", { count: 1 }) },
              { value: "300", label: t("minutes", { count: 5 }) },
            ]}
          />
          <FpsPicker serial={serial} />
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPaused((p) => !p)}
          >
            {paused ? <Play /> : <Pause />}
            {paused ? t("resume") : t("pause")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={exportSamples}
            disabled={samples.length === 0}
          >
            <Download />
            {t("exportCsv")}
          </Button>
        </>
      }
    >
      {error && (
        <div className="bg-error/12 text-small flex items-center gap-2 rounded-md px-3 py-2">
          <span className="text-error font-medium">{t("errorTitle")}</span>
          <span className="text-secondary-foreground truncate">
            {error.message}
          </span>
        </div>
      )}
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        <CpuCard
          samples={visible}
          latest={latest}
          cpu={cpu}
          now={now}
          windowMs={windowMs}
          span={span}
        />
        <MemoryCard
          samples={visible}
          latest={latest}
          now={now}
          windowMs={windowMs}
          span={span}
          pkg={fpsPackage}
        />
        <NetworkCard
          samples={visible}
          latest={latest}
          now={now}
          windowMs={windowMs}
          span={span}
        />
        <FramesCard
          samples={visible}
          latest={latest}
          now={now}
          windowMs={windowMs}
          span={span}
          pkg={fpsPackage}
        />
      </div>
      <BatteryCard
        samples={visible}
        latest={latest}
        now={now}
        windowMs={windowMs}
      />
      <ProcessTable serial={serial} paused={paused} />
    </Page>
  );
}

interface CardProps {
  samples: PerfSample[];
  latest: PerfSample | null;
  now: number;
  windowMs: number;
}

function ChartCard({
  title,
  legend,
  value,
  children,
  footer,
  span,
  className,
}: {
  title: string;
  legend: ReactNode;
  value: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  span?: string;
  className?: string;
}) {
  const { t } = useTranslation("performance");
  return (
    <section
      className={cn(
        "bg-card flex min-w-0 flex-col gap-2 rounded-lg border px-4 py-3.5",
        className,
      )}
    >
      <div className="flex items-center gap-2.5">
        <h2 className="font-semibold">{title}</h2>
        <span className="text-caption text-secondary-foreground flex gap-3">
          {legend}
        </span>
        <span className="text-section ml-auto font-semibold whitespace-nowrap tabular-nums">
          {value}
        </span>
      </div>
      {children}
      {span !== undefined && (
        <div className="text-caption text-muted-foreground flex justify-between gap-2 tabular-nums">
          <span>−{span}</span>
          <span className="truncate">{footer}</span>
          <span className="flex-none">{t("now")}</span>
        </div>
      )}
    </section>
  );
}

function Legend({
  color,
  dashed,
  children,
}: {
  color: string;
  dashed?: boolean;
  children: ReactNode;
}) {
  return (
    <span className="flex items-center gap-[5px]">
      <Swatch color={color} dashed={dashed} />
      {children}
    </span>
  );
}

const times = (s: PerfSample[]) => s.map((x) => x.time);

function clusterLabel(
  t: (k: string, o?: Record<string, unknown>) => string,
  cpu: CpuInfo | null,
) {
  if (!cpu || cpu.cores === 0) return "";
  const c = cpu.clusters;
  if (c.length <= 1) return t("cores", { count: cpu.cores });
  const names =
    c.length === 2
      ? ["little", "big"]
      : c.length === 3
        ? ["little", "mid", "big"]
        : null;
  return c
    .map((n, i) => (names ? `${t(`cluster.${names[i]}`)} ×${n}` : `×${n}`))
    .join(" · ");
}

function CpuCard({
  samples,
  latest,
  cpu,
  now,
  windowMs,
  span,
}: CardProps & { cpu: CpuInfo | null; span: string }) {
  const { t } = useTranslation("performance");
  const cores = latest?.cores ?? [];
  // Faster clusters are drawn more opaque (board: little .6, mid .8, big 1).
  const clusterOf = (i: number) => {
    let acc = 0;
    for (const [ci, n] of (cpu?.clusters ?? []).entries()) {
      acc += n;
      if (i < acc) return ci;
    }
    return 0;
  };
  const clusters = cpu?.clusters.length ?? 1;
  return (
    <ChartCard
      title={t("cpu")}
      legend={<Legend color="var(--chart-1)">{t("total")}</Legend>}
      value={<span className="text-chart-1">{fmtPct(latest?.cpu)}</span>}
      span={span}
      footer={clusterLabel(t, cpu)}
    >
      <div className="flex items-stretch gap-3">
        <LineChart
          className="flex-1"
          times={times(samples)}
          now={now}
          windowMs={windowMs}
          max={100}
          label={t("cpuAria", { value: fmtPct(latest?.cpu) })}
          series={[
            {
              values: samples.map((s) => s.cpu),
              color: "var(--chart-1)",
              area: true,
            },
          ]}
        />
        <div
          role="img"
          aria-label={t("perCore")}
          className="grid w-[110px] flex-none items-end gap-0.5 border-b"
          style={{
            gridTemplateColumns: `repeat(${Math.max(cores.length, 1)}, minmax(0, 1fr))`,
          }}
        >
          {cores.map((v, i) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: cores are positional
              key={i}
              title={`cpu${i} · ${Math.round(v)}%`}
              className="bg-chart-1 rounded-t-[2px]"
              style={{
                height: `${Math.max(v, 1)}%`,
                opacity:
                  clusters > 1
                    ? 0.6 + (0.4 * clusterOf(i)) / (clusters - 1)
                    : 1,
              }}
            />
          ))}
        </div>
      </div>
    </ChartCard>
  );
}

function MemoryCard({
  samples,
  latest,
  now,
  windowMs,
  span,
  pkg,
}: CardProps & { span: string; pkg: string | null }) {
  const { t } = useTranslation("performance");
  const mem = latest?.memory;
  const footer =
    pkg && latest?.packagePssKb != null
      ? t("pss", { pkg, value: fmtBytes(latest.packagePssKb * 1024) })
      : mem && mem.swapTotalKb > 0
        ? t("swap", {
            used: fmtBytes(mem.swapUsedKb * 1024),
            total: fmtBytes(mem.swapTotalKb * 1024),
          })
        : "";
  return (
    <ChartCard
      title={t("memory")}
      legend={<Legend color="var(--chart-2)">{t("used")}</Legend>}
      value={
        <span className="text-chart-2">
          {mem ? `${fmtGb(mem.usedKb)} / ${fmtGb(mem.totalKb)} GB` : "—"}
        </span>
      }
      span={span}
      footer={footer}
    >
      <LineChart
        times={times(samples)}
        now={now}
        windowMs={windowMs}
        max={100}
        label={t("memoryAria")}
        series={[
          {
            values: samples.map((s) =>
              s.memory.totalKb
                ? (s.memory.usedKb / s.memory.totalKb) * 100
                : null,
            ),
            color: "var(--chart-2)",
            area: true,
          },
        ]}
      />
    </ChartCard>
  );
}

function NetworkCard({
  samples,
  latest,
  now,
  windowMs,
  span,
}: CardProps & { span: string }) {
  const { t } = useTranslation("performance");
  const rx = samples.map((s) => s.network?.rxBytesPerSec ?? null);
  const tx = samples.map((s) => s.network?.txBytesPerSec ?? null);
  const peak = Math.max(
    1024,
    ...rx.map((v) => v ?? 0),
    ...tx.map((v) => v ?? 0),
  );
  const net = latest?.network;
  const unit = rateUnit(
    Math.max(net?.rxBytesPerSec ?? 0, net?.txBytesPerSec ?? 0),
  );
  return (
    <ChartCard
      title={t("network")}
      legend={
        <>
          <Legend color="var(--chart-3)">rx</Legend>
          <Legend color="var(--chart-4)" dashed>
            tx
          </Legend>
        </>
      }
      value={
        net ? (
          <>
            <span className="text-chart-3">
              ↓ {fmtRate(net.rxBytesPerSec, unit)}
            </span>{" "}
            <span className="text-chart-4">
              ↑ {fmtRate(net.txBytesPerSec, unit)}
            </span>{" "}
            <span className="text-small text-muted-foreground font-medium">
              {unit.label}
            </span>
          </>
        ) : (
          "—"
        )
      }
      span={span}
      footer={net?.iface ?? ""}
    >
      <LineChart
        times={times(samples)}
        now={now}
        windowMs={windowMs}
        max={peak * 1.15}
        label={t("networkAria")}
        series={[
          { values: rx, color: "var(--chart-3)" },
          { values: tx, color: "var(--chart-4)", dashed: true },
        ]}
      />
    </ChartCard>
  );
}

function FramesCard({
  samples,
  latest,
  now,
  windowMs,
  span,
  pkg,
}: CardProps & { span: string; pkg: string | null }) {
  const { t } = useTranslation("performance");
  const fps = samples.map((s) => s.frames?.fps ?? null);
  const peak = Math.max(60, ...fps.map((v) => v ?? 0));
  const frames = latest?.frames;
  const footer = !pkg
    ? t("pickApp")
    : !frames
      ? t("notRunning")
      : [
          frames.jankyPercent != null &&
            t("janky", { value: frames.jankyPercent.toFixed(1) }),
          frames.p95Ms != null && t("p95", { value: frames.p95Ms }),
        ]
          .filter(Boolean)
          .join(" · ");
  return (
    <ChartCard
      title={t("frameRate")}
      legend={pkg ? <Legend color="var(--chart-5)">{pkg}</Legend> : null}
      value={
        <span className="text-chart-5">
          {frames ? `${Math.round(frames.fps)} fps` : "—"}
        </span>
      }
      span={span}
      footer={footer}
    >
      <LineChart
        times={times(samples)}
        now={now}
        windowMs={windowMs}
        max={peak * 1.2}
        reference={60}
        grid={false}
        label={t("framesAria")}
        series={[{ values: fps, color: "var(--chart-5)" }]}
      />
    </ChartCard>
  );
}

function BatteryCard({ samples, latest, now, windowMs }: CardProps) {
  const { t, i18n } = useTranslation("performance");
  const current = samples.map((s) => s.battery.currentMa);
  const temp = samples.map((s) => s.battery.temperatureC);
  const range = (vs: (number | null)[]) => {
    const xs = vs.filter((v): v is number => v !== null);
    if (xs.length === 0) return { min: 0, max: 1 };
    const lo = Math.min(...xs);
    const hi = Math.max(...xs);
    const pad = Math.max((hi - lo) * 0.2, 1);
    return { min: lo - pad, max: hi + pad };
  };
  const b = latest?.battery;
  const nf = new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 0 });
  const hasCurrent = current.some((v) => v !== null);
  return (
    <ChartCard
      className="pb-1.5"
      title={t("battery")}
      legend={
        <>
          <Legend color="var(--chart-4)">{t("current")}</Legend>
          <Legend color="var(--chart-2)" dashed>
            {t("temperature")}
          </Legend>
          {b?.level != null && (
            <span className="text-muted-foreground">
              {b.level}%{b.charging ? ` · ${t("charging")}` : ""}
            </span>
          )}
        </>
      }
      value={
        <>
          <span
            className="text-chart-4"
            title={hasCurrent ? undefined : t("currentUnavailable")}
          >
            {b?.currentMa != null
              ? `${b.currentMa > 0 ? "+" : ""}${nf.format(b.currentMa)} mA`
              : "— mA"}
          </span>{" "}
          <span className="text-chart-2">
            {b?.temperatureC != null ? `${b.temperatureC.toFixed(1)} °C` : "—"}
          </span>
        </>
      }
    >
      <LineChart
        times={times(samples)}
        now={now}
        windowMs={windowMs}
        max={1}
        height={70}
        grid={false}
        label={t("batteryAria")}
        series={[
          { values: current, color: "var(--chart-4)", ...range(current) },
          {
            values: temp,
            color: "var(--chart-2)",
            dashed: true,
            ...range(temp),
          },
        ]}
      />
    </ChartCard>
  );
}

function FpsPicker({ serial }: { serial: string }) {
  const { t } = useTranslation("performance");
  const fpsPackage = usePerfPrefs((s) => s.fpsPackage);
  const setFpsPackage = usePerfPrefs((s) => s.setFpsPackage);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const { data } = useQuery({
    queryKey: ["processes", serial],
    queryFn: () => listProcesses(serial),
    enabled: open,
  });
  const packages = useMemo(() => {
    const set = new Set<string>();
    for (const p of data ?? []) {
      const pkg = appPackage(p);
      if (pkg) set.add(pkg);
    }
    return [...set].sort();
  }, [data]);
  const q = query.trim().toLowerCase();
  const shown = packages
    .filter((p) => p.toLowerCase().includes(q))
    .slice(0, 50);
  const custom = q && /^[\w.]+$/.test(q) && !packages.includes(query.trim());

  const pick = (pkg: string | null) => {
    setFpsPackage(pkg);
    setOpen(false);
    setQuery("");
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={<Button variant="outline" size="sm" className="max-w-56" />}
      >
        <span className="truncate">
          {fpsPackage ? t("fpsOf", { pkg: fpsPackage }) : t("fpsNone")}
        </span>
        <ChevronDown />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 gap-1.5 p-1.5">
        <div className="border-input bg-background flex h-7 items-center gap-2 rounded-md border px-2">
          <Search className="text-muted-foreground size-3.5" aria-hidden />
          <input
            // biome-ignore lint/a11y/noAutofocus: popover search field
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("searchApps")}
            aria-label={t("searchApps")}
            className="text-small min-w-0 flex-1 bg-transparent outline-none"
          />
        </div>
        <div className="flex max-h-64 flex-col overflow-auto">
          {fpsPackage && (
            <PickItem onClick={() => pick(null)} muted>
              {t("fpsOff")}
            </PickItem>
          )}
          {custom && (
            <PickItem onClick={() => pick(query.trim())}>
              {query.trim()}
            </PickItem>
          )}
          {shown.map((p) => (
            <PickItem
              key={p}
              onClick={() => pick(p)}
              selected={p === fpsPackage}
            >
              {p}
            </PickItem>
          ))}
          {!custom && shown.length === 0 && (
            <p className="text-small text-muted-foreground px-2 py-1.5">
              {data ? t("noApps") : t("loading")}
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function PickItem({
  children,
  onClick,
  selected,
  muted,
}: {
  children: ReactNode;
  onClick: () => void;
  selected?: boolean;
  muted?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "text-small hover:bg-accent focus-visible:bg-accent truncate rounded-sm px-2 py-1 text-left outline-none",
        muted ? "text-muted-foreground font-sans" : "font-mono",
        selected && "bg-selected",
      )}
    >
      {children}
    </button>
  );
}

type SortKey = "pid" | "name" | "user" | "cpu" | "rssKb" | "state";

function ProcessTable({ serial, paused }: { serial: string; paused: boolean }) {
  const { t } = useTranslation("performance");
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({
    key: "cpu",
    desc: true,
  });
  const [selected, setSelected] = useState<number | null>(null);
  const [victim, setVictim] = useState<Process | null>(null);
  const { data, error } = useQuery({
    queryKey: ["processes", serial],
    queryFn: () => listProcesses(serial),
    refetchInterval: paused ? false : 3000,
  });

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = (data ?? []).filter(
      (p) =>
        !q ||
        p.name.toLowerCase().includes(q) ||
        p.user.toLowerCase().includes(q) ||
        String(p.pid) === q,
    );
    const dir = sort.desc ? -1 : 1;
    return list.sort((a, b) => {
      const x = a[sort.key];
      const y = b[sort.key];
      const c =
        typeof x === "number" && typeof y === "number"
          ? x - y
          : String(x).localeCompare(String(y));
      return c * dir || a.pid - b.pid;
    });
  }, [data, filter, sort]);

  const kill = async (p: Process) => {
    try {
      await killProcess(serial, p.pid, appPackage(p));
      toast.success(t("killed", { name: p.name }));
    } catch (e) {
      toast.error(t("killFailed", { name: p.name }), {
        description: errorMessage(e),
      });
    }
    void queryClient.invalidateQueries({ queryKey: ["processes", serial] });
  };

  const header = (key: SortKey, label: string, right?: boolean) => {
    const on = sort.key === key;
    return (
      <th
        className={cn(
          "bg-card h-8 border-b px-3 font-medium whitespace-nowrap",
          right ? "text-right" : "text-left",
        )}
        aria-sort={on ? (sort.desc ? "descending" : "ascending") : "none"}
      >
        <button
          type="button"
          className="hover:text-foreground focus-visible:outline-ring inline-flex items-center gap-1 rounded-sm outline-none focus-visible:outline-2"
          onClick={() =>
            setSort((s) => ({
              key,
              desc: s.key === key ? !s.desc : key === "cpu" || key === "rssKb",
            }))
          }
        >
          {label}
          {on &&
            (sort.desc ? (
              <ArrowDown className="text-brand size-3" aria-hidden />
            ) : (
              <ArrowUp className="text-brand size-3" aria-hidden />
            ))}
        </button>
      </th>
    );
  };

  const cell = "h-[30px] border-b px-3 whitespace-nowrap";

  return (
    <section className="bg-card overflow-hidden rounded-lg border">
      <div className="flex items-center gap-2.5 border-b px-3.5 py-2.5">
        <h2 className="font-semibold">{t("processes")}</h2>
        <span className="text-small text-muted-foreground tabular-nums">
          {data ? t("running", { count: data.length }) : ""}
        </span>
        <div className="border-input bg-background focus-within:border-ring ml-auto flex h-[26px] w-[220px] items-center gap-2 rounded-[7px] border px-2.5">
          <Search className="text-muted-foreground size-3.5" aria-hidden />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t("filter")}
            aria-label={t("filter")}
            className="text-small min-w-0 flex-1 bg-transparent outline-none"
          />
        </div>
      </div>
      {error ? (
        <p className="text-small text-error px-3.5 py-3">
          {errorMessage(error)}
        </p>
      ) : (
        <div className="max-h-[480px] overflow-auto">
          <table className="w-full border-collapse">
            <thead className="text-small text-muted-foreground sticky top-0 z-10">
              <tr>
                {header("pid", t("pid"))}
                {header("name", t("name"))}
                {header("user", t("user"))}
                {header("cpu", t("cpuPct"), true)}
                {header("rssKb", t("rss"), true)}
                {header("state", t("state"))}
                <th className="bg-card h-8 w-[72px] border-b" />
              </tr>
            </thead>
            <tbody className="text-small font-mono">
              {rows.map((p) => {
                const on = selected === p.pid;
                return (
                  <tr
                    key={p.pid}
                    onClick={() => setSelected(on ? null : p.pid)}
                    className={cn(
                      "group cursor-default",
                      on ? "bg-brand/15" : "hover:bg-accent",
                    )}
                  >
                    <td className={cn(cell, "tabular-nums")}>{p.pid}</td>
                    <td
                      className={cn(cell, "max-w-[360px] truncate")}
                      title={p.name}
                    >
                      {p.name}
                    </td>
                    <td className={cn(cell, "text-muted-foreground")}>
                      {p.user}
                    </td>
                    <td
                      className={cn(
                        cell,
                        "text-right tabular-nums",
                        on && "text-chart-1",
                      )}
                    >
                      {p.cpu.toFixed(1)}
                    </td>
                    <td className={cn(cell, "text-right tabular-nums")}>
                      {fmtBytes(p.rssKb * 1024)}
                    </td>
                    <td className={cell}>
                      <Badge
                        title={t(`states.${p.state}`, {
                          defaultValue: p.state,
                        })}
                      >
                        {p.state}
                      </Badge>
                    </td>
                    <td className={cn(cell, "px-1.5 text-right")}>
                      <Button
                        variant="outline"
                        size="xs"
                        className={cn(
                          "text-error h-[22px] font-sans",
                          on
                            ? ""
                            : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
                        )}
                        onClick={(e) => {
                          e.stopPropagation();
                          setVictim(p);
                        }}
                      >
                        {t("kill")}
                      </Button>
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td
                    colSpan={7}
                    className="text-muted-foreground h-14 text-center font-sans"
                  >
                    {data ? t("noProcesses") : t("loading")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <ConfirmDialog
        open={victim !== null}
        onOpenChange={(o) => !o && setVictim(null)}
        title={victim ? t("killTitle", { name: victim.name }) : ""}
        description={
          victim &&
          (appPackage(victim)
            ? t("killApp", { pkg: appPackage(victim) })
            : t("killPid", { pid: victim.pid }))
        }
        confirmLabel={
          victim && appPackage(victim) ? t("forceStop") : t("killConfirm")
        }
        onConfirm={() => victim && void kill(victim)}
      />
    </section>
  );
}

// ---------------------------------------------------------------- formatting

function fmtPct(v: number | null | undefined) {
  return v == null ? "—" : `${Math.round(v)}%`;
}

function fmtGb(kb: number) {
  return (kb / 1024 / 1024).toFixed(1);
}

function fmtBytes(bytes: number) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function rateUnit(peak: number) {
  if (peak >= 1024 ** 2) return { div: 1024 ** 2, label: "MB/s" };
  if (peak >= 1024) return { div: 1024, label: "KB/s" };
  return { div: 1, label: "B/s" };
}

function fmtRate(bytes: number, unit: { div: number }) {
  const v = bytes / unit.div;
  return v >= 100 || unit.div === 1 ? Math.round(v).toString() : v.toFixed(1);
}

function csvCell(v: string | number | null | undefined) {
  if (v == null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function toCsv(samples: PerfSample[]): string {
  const cores = Math.max(0, ...samples.map((s) => s.cores.length));
  const head = [
    "time",
    "cpu_percent",
    ...Array.from({ length: cores }, (_, i) => `cpu${i}_percent`),
    "mem_used_kb",
    "mem_total_kb",
    "swap_used_kb",
    "net_iface",
    "rx_bytes_per_sec",
    "tx_bytes_per_sec",
    "fps",
    "janky_percent",
    "p95_ms",
    "package_pss_kb",
    "battery_level",
    "battery_current_ma",
    "battery_temp_c",
  ];
  const rows = samples.map((s) =>
    [
      new Date(s.time).toISOString(),
      s.cpu?.toFixed(1),
      ...Array.from({ length: cores }, (_, i) => s.cores[i]?.toFixed(1)),
      s.memory.usedKb,
      s.memory.totalKb,
      s.memory.swapUsedKb,
      s.network?.iface,
      s.network?.rxBytesPerSec.toFixed(0),
      s.network?.txBytesPerSec.toFixed(0),
      s.frames?.fps.toFixed(1),
      s.frames?.jankyPercent?.toFixed(1),
      s.frames?.p95Ms,
      s.packagePssKb,
      s.battery.level,
      s.battery.currentMa?.toFixed(0),
      s.battery.temperatureC?.toFixed(1),
    ]
      .map(csvCell)
      .join(","),
  );
  return `${[head.join(","), ...rows].join("\n")}\n`;
}
