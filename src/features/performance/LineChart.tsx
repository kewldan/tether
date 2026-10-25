import { cn } from "@/lib/utils";

/**
 * Tiny SVG time-series chart (Performance board). Never animated: every
 * sample just redraws the paths. Series 2+ should be dashed so they stay
 * distinguishable without color (CVD-safe).
 */
export interface Series {
  /** One value per sample time; null leaves a gap. */
  values: (number | null)[];
  /** CSS color, e.g. `var(--chart-1)`. */
  color: string;
  dashed?: boolean;
  area?: boolean;
  /** Own scale (0..max) instead of the chart's, for mixed units. */
  max?: number;
  min?: number;
}

const W = 600;
const H = 120;

function path(
  times: number[],
  values: (number | null)[],
  from: number,
  span: number,
  min: number,
  max: number,
): string[] {
  const parts: string[] = [];
  let current = "";
  const range = max - min || 1;
  values.forEach((v, i) => {
    const t = times[i];
    if (v === null || t === undefined || !Number.isFinite(v)) {
      if (current) parts.push(current);
      current = "";
      return;
    }
    const x = ((t - from) / span) * W;
    const clamped = Math.min(Math.max(v, min), max);
    const y = H - ((clamped - min) / range) * H;
    current += `${current ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
  });
  if (current) parts.push(current);
  return parts;
}

export function LineChart({
  times,
  series,
  windowMs,
  now,
  max,
  min = 0,
  height = 120,
  grid = true,
  reference,
  label,
  className,
}: {
  /** Sample timestamps (ms), ascending. */
  times: number[];
  series: Series[];
  windowMs: number;
  /** Right edge of the chart. */
  now: number;
  max: number;
  min?: number;
  height?: number;
  grid?: boolean;
  /** Dashed horizontal guide at this value (e.g. 60 fps). */
  reference?: number;
  label: string;
  className?: string;
}) {
  const from = now - windowMs;
  const refY =
    reference !== undefined
      ? H - ((reference - min) / (max - min || 1)) * H
      : null;
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
      className={cn("block w-full min-w-0 overflow-hidden", className)}
      style={{ height }}
    >
      {grid && (
        <path
          d="M0 30H600M0 60H600M0 90H600"
          stroke="var(--border)"
          strokeWidth={1}
          fill="none"
          vectorEffect="non-scaling-stroke"
        />
      )}
      {refY !== null && (
        <path
          d={`M0 ${refY.toFixed(1)}H600`}
          stroke="var(--input)"
          strokeWidth={1}
          strokeDasharray="4 4"
          fill="none"
          vectorEffect="non-scaling-stroke"
        />
      )}
      {series.map((s, i) => {
        const segments = path(
          times,
          s.values,
          from,
          windowMs,
          s.min ?? min,
          s.max ?? max,
        );
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: series order is fixed
          <g key={i}>
            {s.area &&
              segments.map((d) => {
                if (!d.includes("L")) return null;
                const start = d.slice(1, d.indexOf(" "));
                const end = d.slice(d.lastIndexOf("L") + 1).split(" ")[0];
                return (
                  <path
                    key={`a${d.length}${start}`}
                    d={`${d}L${end} ${H}L${start} ${H}Z`}
                    fill={s.color}
                    opacity={0.12}
                  />
                );
              })}
            {segments.map((d) => (
              <path
                key={`l${d.length}${d.slice(0, 12)}`}
                d={d}
                fill="none"
                stroke={s.color}
                strokeWidth={1.75}
                strokeDasharray={s.dashed ? "5 3" : undefined}
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            ))}
          </g>
        );
      })}
    </svg>
  );
}

/** Legend swatch: solid or dashed 10×2 line. */
export function Swatch({ color, dashed }: { color: string; dashed?: boolean }) {
  return (
    <i
      aria-hidden
      className="inline-block h-0 w-2.5 rounded-[1px] border-t-2"
      style={{
        borderColor: color,
        borderTopStyle: dashed ? "dashed" : "solid",
      }}
    />
  );
}
