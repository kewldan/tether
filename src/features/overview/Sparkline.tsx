import { cn } from "cn";

/**
 * 40 px area sparkline (no animation: charts never animate). `values` are
 * 0..1; nulls are skipped. `tone` is a chart token suffix (1–5). With
 * `autoscale` the range is zoomed to the data (at least 10% tall) so slow
 * changes such as battery level stay visible.
 */
export function Sparkline({
  values,
  tone,
  label,
  autoscale = false,
  className,
}: {
  values: (number | null)[];
  tone: 1 | 2 | 3 | 4 | 5;
  label: string;
  autoscale?: boolean;
  className?: string;
}) {
  const W = 220;
  const H = 40;
  let points = values.filter((v): v is number => v !== null);
  if (autoscale && points.length > 1) {
    const lo = Math.min(...points);
    const hi = Math.max(...points);
    const span = Math.max(hi - lo, 0.1);
    const base = (lo + hi) / 2 - span / 2;
    points = points.map((v) => (v - base) / span);
  }
  const stroke = `var(--chart-${tone})`;

  if (points.length < 2) {
    return (
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className={cn("h-10 w-full", className)}
        role="img"
        aria-label={label}
      >
        <path
          d={`M0 ${H - 4} L${W} ${H - 4}`}
          stroke="var(--border)"
          strokeWidth={1.5}
          strokeDasharray="3 4"
          fill="none"
        />
      </svg>
    );
  }

  const step = W / (points.length - 1);
  const y = (v: number) => H - 4 - Math.max(0, Math.min(1, v)) * (H - 8);
  const line = points
    .map(
      (v, i) =>
        `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)} ${y(v).toFixed(1)}`,
    )
    .join(" ");
  const area = `${line} L${W} ${H} L0 ${H}Z`;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className={cn("h-10 w-full", className)}
      role="img"
      aria-label={label}
    >
      <path d={area} fill={stroke} opacity={0.14} />
      <path
        d={line}
        fill="none"
        stroke={stroke}
        strokeWidth={1.75}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
