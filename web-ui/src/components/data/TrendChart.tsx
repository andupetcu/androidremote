import { useId } from 'react';

export interface TrendPoint {
  t: number;
  v: number | null;
}

export interface TrendChartProps {
  title: string;
  unit: string;
  series: TrendPoint[];
  /** Fixed y range (for example [0, 100] for a percentage). Default: fit the data. */
  domain?: [number, number];
  color?: string;
  height?: number;
  /** Decimals shown in the labels. */
  digits?: number;
}

const W = 600;
const PAD = { l: 44, r: 12, t: 10, b: 22 };

function fmtTime(t: number, span: number): string {
  const d = new Date(t);
  return span > 36 * 3600_000
    ? `${d.getMonth() + 1}/${d.getDate()}`
    : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Small dependency-free SVG line chart. Missing samples (null) break the line. */
export function TrendChart({ title, unit, series, domain, color = '#4fc3f7', height = 140, digits = 0 }: TrendChartProps) {
  const gradId = useId();
  const real = series.filter((p): p is { t: number; v: number } => p.v !== null);

  if (real.length === 0) {
    return (
      <figure style={{ margin: 0 }}>
        <figcaption style={{ fontWeight: 600, marginBottom: 4 }}>{title}</figcaption>
        <p style={{ opacity: 0.7, margin: 0 }}>No data in this range</p>
      </figure>
    );
  }

  const tMin = series[0].t;
  const tMax = series[series.length - 1].t;
  const span = Math.max(1, tMax - tMin);
  let lo = domain ? domain[0] : Math.min(...real.map((p) => p.v));
  let hi = domain ? domain[1] : Math.max(...real.map((p) => p.v));
  if (!domain) {
    const pad = (hi - lo) * 0.1 || Math.abs(hi) * 0.1 || 1;
    lo = Math.max(0, lo - pad);
    hi = hi + pad;
  }
  const x = (t: number) => PAD.l + (series.length === 1 ? (W - PAD.l - PAD.r) / 2 : ((t - tMin) / span) * (W - PAD.l - PAD.r));
  const y = (v: number) => PAD.t + (1 - (v - lo) / (hi - lo || 1)) * (height - PAD.t - PAD.b);

  // Build segments separated by gaps
  let d = '';
  let area = '';
  let open = false;
  let first: TrendPoint | null = null;
  let last: TrendPoint | null = null;
  const flushArea = () => {
    if (first && last) {
      area += `L${x(last.t).toFixed(1)},${y(lo).toFixed(1)}L${x(first.t).toFixed(1)},${y(lo).toFixed(1)}Z`;
    }
  };
  for (const p of series) {
    if (p.v === null) {
      if (open) flushArea();
      open = false;
      continue;
    }
    const cmd = `${open ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`;
    d += cmd;
    area += cmd;
    if (!open) first = p;
    last = p;
    open = true;
  }
  if (open) flushArea();

  const latest = real[real.length - 1].v;
  const mn = Math.min(...real.map((p) => p.v));
  const mx = Math.max(...real.map((p) => p.v));
  const f = (v: number) => `${v.toFixed(digits)}${unit}`;
  const label = `${title}: latest ${f(latest)}, min ${f(mn)}, max ${f(mx)}, ${real.length} samples`;

  return (
    <figure style={{ margin: 0 }}>
      <figcaption style={{ fontWeight: 600, marginBottom: 4, display: 'flex', justifyContent: 'space-between' }}>
        <span>{title}</span>
        <span style={{ fontWeight: 400, opacity: 0.8 }}>{f(latest)}</span>
      </figcaption>
      <svg role="img" aria-label={label} viewBox={`0 0 ${W} ${height}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.35" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <line x1={PAD.l} x2={W - PAD.r} y1={y(lo)} y2={y(lo)} stroke="currentColor" strokeOpacity="0.2" />
        <line x1={PAD.l} x2={W - PAD.r} y1={y(hi)} y2={y(hi)} stroke="currentColor" strokeOpacity="0.1" strokeDasharray="3 3" />
        <text x={PAD.l - 6} y={y(hi) + 4} textAnchor="end" fontSize="11" fill="currentColor" opacity="0.7">{f(hi)}</text>
        <text x={PAD.l - 6} y={y(lo) + 4} textAnchor="end" fontSize="11" fill="currentColor" opacity="0.7">{f(lo)}</text>
        <text x={PAD.l} y={height - 6} fontSize="11" fill="currentColor" opacity="0.7">{fmtTime(tMin, span)}</text>
        <text x={W - PAD.r} y={height - 6} textAnchor="end" fontSize="11" fill="currentColor" opacity="0.7">{fmtTime(tMax, span)}</text>
        <path d={area} fill={`url(#${gradId})`} stroke="none" />
        <path data-series="line" d={d} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />
        {real.length === 1 && <circle cx={x(real[0].t)} cy={y(real[0].v)} r="3.5" fill={color} />}
      </svg>
    </figure>
  );
}
