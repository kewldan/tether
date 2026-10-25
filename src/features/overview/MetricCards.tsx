import {
  Clock,
  Cpu as CpuIcon,
  HardDrive,
  MemoryStick,
  Smartphone,
  Wifi,
} from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { Badge } from "@/components/ui/badge";
import type { DeviceSnapshot } from "@/features/overview/api";
import { formatUptime, gigabytes } from "@/features/overview/format";
import { Sparkline } from "@/features/overview/Sparkline";
import {
  chargeRate,
  useSnapshotSamples,
} from "@/features/overview/useDeviceSnapshot";
import { cn } from "@/lib/utils";

export function MetricCard({
  title,
  aside,
  children,
  className,
}: {
  title: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "bg-card flex min-w-0 flex-col gap-2 rounded-lg border px-4 py-3.5",
        className,
      )}
    >
      <h2 className="flex items-center justify-between gap-2 font-semibold">
        {title}
        {aside}
      </h2>
      {children}
    </section>
  );
}

function CardIcon({ icon: Icon }: { icon: typeof Clock }) {
  return (
    <Icon className="text-muted-foreground size-4 flex-none" aria-hidden />
  );
}

export function Big({
  value,
  sub,
  small = false,
}: {
  value: ReactNode;
  sub?: ReactNode;
  small?: boolean;
}) {
  return (
    <div className="flex min-w-0 items-baseline gap-2">
      <span
        className={cn(
          "truncate font-semibold tracking-[-.02em] tabular-nums",
          small ? "text-[20px] leading-[30px]" : "text-[26px] leading-[30px]",
        )}
      >
        {value}
      </span>
      {sub && (
        <span className="text-muted-foreground truncate tabular-nums">
          {sub}
        </span>
      )}
    </div>
  );
}

export function Facts({
  rows,
}: {
  rows: [ReactNode, ReactNode, { mono?: boolean; key?: string }?][];
}) {
  return (
    <dl className="text-small m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
      {rows.map(([label, value, opts], i) => (
        <div key={opts?.key ?? i} className="contents">
          <dt className="text-muted-foreground flex items-center gap-1.5">
            {label}
          </dt>
          <dd
            className={cn(
              "m-0 truncate text-right tabular-nums",
              opts?.mono && "font-mono",
            )}
          >
            {value ?? "—"}
          </dd>
        </div>
      ))}
    </dl>
  );
}

const pct = (v: number) => Math.round(v * 100);

export function BatteryCard({
  serial,
  snapshot,
}: {
  serial: string;
  snapshot: DeviceSnapshot;
}) {
  const { t } = useTranslation("overview");
  const samples = useSnapshotSamples(
    useShallow((s) => s.samples[serial] ?? []),
  );
  const battery = snapshot.battery;
  if (!battery) {
    return (
      <MetricCard title={t("battery.title")}>
        <p className="text-muted-foreground">{t("battery.none")}</p>
      </MetricCard>
    );
  }

  const rate = chargeRate(samples);
  const charging = battery.status === "charging";
  const level = battery.level;
  let sub: string | null = null;
  if (rate !== null && Math.abs(rate) >= 0.05 && level !== null) {
    const sign = rate > 0 ? "+" : "−";
    const parts = [
      t("battery.rate", { rate: `${sign}${Math.abs(rate).toFixed(1)}` }),
    ];
    if (charging && rate > 0) {
      parts.push(
        t("battery.fullIn", {
          time: formatUptime(((100 - level) / rate) * 60),
        }),
      );
    } else if (rate < 0) {
      parts.push(
        t("battery.emptyIn", { time: formatUptime((level / -rate) * 60) }),
      );
    }
    sub = parts.join(" · ");
  }

  const status = [
    t(`battery.status.${battery.status}`),
    battery.plugged && t(`battery.source.${battery.plugged}`),
  ]
    .filter(Boolean)
    .join(" · ");
  const tone =
    battery.status === "charging" || battery.status === "full"
      ? "success"
      : level !== null && level <= 15
        ? "error"
        : "default";

  return (
    <MetricCard
      title={t("battery.title")}
      aside={<Badge variant={tone}>{status}</Badge>}
    >
      <Big value={level !== null ? `${level}%` : "—"} sub={sub} />
      <Sparkline
        tone={4}
        autoscale
        label={t("battery.chart")}
        values={samples.map((s) =>
          s.battery === null ? null : s.battery / 100,
        )}
      />
      <Facts
        rows={[
          [
            t("battery.temperature"),
            battery.temperatureC !== null
              ? `${battery.temperatureC.toFixed(1)} °C`
              : null,
          ],
          [t("battery.health"), t(`battery.healthValue.${battery.health}`)],
          [
            t("battery.voltage"),
            battery.voltageV !== null
              ? `${battery.voltageV.toFixed(2)} V`
              : null,
          ],
        ]}
      />
    </MetricCard>
  );
}

export function StorageCard({ snapshot }: { snapshot: DeviceSnapshot }) {
  const { t } = useTranslation("overview");
  const storage = snapshot.storage;
  if (!storage) {
    return (
      <MetricCard
        title={t("storage.title")}
        aside={<CardIcon icon={HardDrive} />}
      >
        <Big value="—" />
      </MetricCard>
    );
  }
  const total = storage.totalBytes;
  const c = storage.categories;
  const segments: { label: string; bytes: number; tone: number }[] = c
    ? [
        { label: t("storage.apps"), bytes: c.apps, tone: 1 },
        { label: t("storage.media"), bytes: c.photosVideos, tone: 2 },
        { label: t("storage.system"), bytes: c.system, tone: 3 },
        {
          label: t("storage.other"),
          bytes: c.other + c.audio + c.downloads,
          tone: 4,
        },
      ]
    : [{ label: t("storage.used"), bytes: storage.usedBytes, tone: 1 }];

  return (
    <MetricCard
      title={t("storage.title")}
      aside={<CardIcon icon={HardDrive} />}
    >
      <Big
        value={gigabytes(storage.usedBytes)}
        sub={t("storage.of", { total: gigabytes(total, 0) })}
      />
      <div
        className="bg-selected flex h-2 gap-0.5 overflow-hidden rounded-full"
        role="img"
        aria-label={segments
          .map((s) => `${s.label} ${gigabytes(s.bytes)} GB`)
          .join(", ")}
      >
        {segments.map((s) => (
          <span
            key={s.label}
            style={{
              width: `${(s.bytes / total) * 100}%`,
              background: `var(--chart-${s.tone})`,
            }}
          />
        ))}
      </div>
      <Facts
        rows={[
          ...segments.map((s): [ReactNode, ReactNode, { key: string }] => [
            <>
              <span
                aria-hidden
                className="size-[7px] flex-none rounded-full"
                style={{ background: `var(--chart-${s.tone})` }}
              />
              {s.label}
            </>,
            `${gigabytes(s.bytes)} GB`,
            { key: s.label },
          ]),
          ...(c
            ? []
            : [
                [
                  <>
                    <span
                      aria-hidden
                      className="bg-selected size-[7px] flex-none rounded-full"
                    />
                    {t("storage.free")}
                  </>,
                  `${gigabytes(storage.availableBytes)} GB`,
                  { key: "free" },
                ] as [ReactNode, ReactNode, { key: string }],
              ]),
        ]}
      />
    </MetricCard>
  );
}

export function MemoryCard({
  serial,
  snapshot,
}: {
  serial: string;
  snapshot: DeviceSnapshot;
}) {
  const { t } = useTranslation("overview");
  const samples = useSnapshotSamples(
    useShallow((s) => s.samples[serial] ?? []),
  );
  const m = snapshot.memory;
  const used = m ? m.totalBytes - m.availableBytes : 0;
  return (
    <MetricCard
      title={t("memory.title")}
      aside={<CardIcon icon={MemoryStick} />}
    >
      <Big
        value={m ? gigabytes(used) : "—"}
        sub={
          m &&
          t("memory.of", {
            total: gigabytes(m.totalBytes, 0),
            pct: pct(used / m.totalBytes),
          })
        }
      />
      <Sparkline
        tone={2}
        label={t("memory.chart")}
        values={samples.map((s) => s.memoryUsed)}
      />
      <Facts
        rows={[
          [t("memory.available"), m && `${gigabytes(m.availableBytes)} GB`],
          [
            t("memory.swap"),
            m && m.swapTotalBytes > 0
              ? `${gigabytes(m.swapTotalBytes - m.swapFreeBytes)} / ${gigabytes(m.swapTotalBytes, 0)} GB`
              : null,
          ],
        ]}
      />
    </MetricCard>
  );
}

export function CpuCard({ snapshot }: { snapshot: DeviceSnapshot }) {
  const { t } = useTranslation("overview");
  const cpu = snapshot.cpu;
  const thermal = snapshot.thermal;
  const temp = thermal?.cpuC ?? thermal?.skinC ?? null;
  const sub = [
    cpu.cores !== null && t("cpu.cores", { count: cpu.cores }),
    cpu.maxFreqMhz !== null &&
      t("cpu.maxFreq", { freq: (cpu.maxFreqMhz / 1000).toFixed(2) }),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <MetricCard title={t("cpu.title")} aside={<CardIcon icon={CpuIcon} />}>
      <Big value={cpu.load !== null ? `${pct(cpu.load)}%` : "—"} sub={sub} />
      <div
        className="grid h-10 items-end gap-[3px]"
        style={{
          gridTemplateColumns: `repeat(${Math.max(cpu.coreLoads.length, 1)}, minmax(0, 1fr))`,
        }}
        role="img"
        aria-label={t("cpu.chart")}
      >
        {cpu.coreLoads.map((load, i) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: cores are positional
            key={i}
            className={cn(
              "rounded-[2px]",
              load === null ? "bg-selected" : "bg-chart-1",
            )}
            style={{ height: `${Math.max(load ?? 0.04, 0.04) * 100}%` }}
          />
        ))}
      </div>
      <Facts
        rows={[
          [
            t("cpu.chip"),
            [snapshot.build.soc, cpu.abi].filter(Boolean).join(" · ") || null,
          ],
          [
            t("cpu.thermal"),
            thermal
              ? [
                  t(`cpu.thermalStatus.${thermal.status}`),
                  temp !== null && `${Math.round(temp)} °C`,
                ]
                  .filter(Boolean)
                  .join(" · ")
              : null,
          ],
        ]}
      />
    </MetricCard>
  );
}

const hz = (v: number) => `${Math.round(v)} Hz`;

export function DisplayCard({ snapshot }: { snapshot: DeviceSnapshot }) {
  const { t } = useTranslation("overview");
  const d = snapshot.display;
  const size = d.overrideSize ?? d.physicalSize;
  const density = d.overrideDensity ?? d.physicalDensity;
  const showMax =
    d.maxRefreshRate !== null &&
    d.refreshRate !== null &&
    Math.round(d.maxRefreshRate) > Math.round(d.refreshRate);
  return (
    <MetricCard
      title={t("display.title")}
      aside={<CardIcon icon={Smartphone} />}
    >
      <Big
        value={d.refreshRate !== null ? hz(d.refreshRate) : "—"}
        sub={
          showMax && d.maxRefreshRate !== null
            ? t("display.upTo", { rate: Math.round(d.maxRefreshRate) })
            : null
        }
      />
      <Facts
        rows={[
          [
            t("display.resolution"),
            size && (
              <span
                title={d.overrideSize ? t("display.overridden") : undefined}
              >
                {size.width} × {size.height}
                {d.overrideSize && " *"}
              </span>
            ),
            { mono: true },
          ],
          [
            t("display.density"),
            density !== null
              ? `${density} dpi${d.overrideDensity ? " *" : ""}`
              : null,
            { mono: true },
          ],
          [
            t("display.fontScale"),
            d.fontScale !== null
              ? d.fontScale.toFixed(2).replace(/0$/, "")
              : null,
          ],
        ]}
      />
    </MetricCard>
  );
}

const MOBILE_TYPES: Record<string, string> = {
  NR_SA: "5G SA",
  NR_NSA: "5G",
  NR: "5G",
  LTE_CA: "LTE+",
  LTE: "LTE",
  HSPAP: "H+",
  HSPA: "H",
  HSDPA: "H",
  UMTS: "3G",
  EDGE: "E",
  GPRS: "G",
};

export function NetworkCard({ snapshot }: { snapshot: DeviceSnapshot }) {
  const { t } = useTranslation("overview");
  const n = snapshot.network;
  const title =
    n.ssid ??
    (n.wifiEnabled === false
      ? t("network.wifiOff")
      : t("network.notConnected"));
  const band =
    n.frequencyMhz !== null
      ? n.frequencyMhz >= 5900
        ? "6 GHz"
        : n.frequencyMhz >= 4900
          ? "5 GHz"
          : "2.4 GHz"
      : null;
  const mobile = [
    n.mobileType && (MOBILE_TYPES[n.mobileType] ?? n.mobileType),
    n.mobileOperator,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <MetricCard title={t("network.title")} aside={<CardIcon icon={Wifi} />}>
      <Big value={title} small />
      <Facts
        rows={[
          [t("network.ip"), n.ip, { mono: true }],
          [
            t("network.signal"),
            n.rssiDbm !== null
              ? [`${n.rssiDbm.toString().replace("-", "−")} dBm`, band]
                  .filter(Boolean)
                  .join(" · ")
              : null,
          ],
          [t("network.mobile"), mobile || null],
        ]}
      />
    </MetricCard>
  );
}

export function UptimeCard({ snapshot }: { snapshot: DeviceSnapshot }) {
  const { t, i18n } = useTranslation("overview");
  const up = snapshot.uptimeSecs;
  const since =
    up !== null
      ? new Date(snapshot.takenAt - up * 1000).toLocaleString(i18n.language, {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })
      : null;
  return (
    <MetricCard title={t("uptime.title")} aside={<CardIcon icon={Clock} />}>
      <Big value={up !== null ? formatUptime(up) : "—"} />
      <Facts rows={[[t("uptime.since"), since]]} />
    </MetricCard>
  );
}
