export interface NetworkSample {
  t: number;
  network: string | null;
}

const COLORS: Record<string, string> = {
  wifi: '#66bb6a',
  cellular: '#ffa726',
  ethernet: '#4fc3f7',
  none: '#9e9e9e',
};
const colorFor = (n: string | null) => COLORS[(n ?? 'none').toLowerCase()] ?? '#ba68c8';

/** Connectivity over time as coloured segments (one band, no y axis). */
export function NetworkTimeline({ samples, title = 'Network' }: { samples: NetworkSample[]; title?: string }) {
  if (samples.length === 0) {
    return (
      <figure style={{ margin: 0 }}>
        <figcaption style={{ fontWeight: 600, marginBottom: 4 }}>{title}</figcaption>
        <p style={{ opacity: 0.7, margin: 0 }}>No data in this range</p>
      </figure>
    );
  }
  const tMin = samples[0].t;
  const tMax = samples[samples.length - 1].t;
  const span = Math.max(1, tMax - tMin);
  const W = 600;
  const segs: Array<{ from: number; to: number; net: string | null }> = [];
  samples.forEach((s, i) => {
    const to = i + 1 < samples.length ? samples[i + 1].t : tMax;
    const prev = segs[segs.length - 1];
    if (prev && prev.net === s.network) prev.to = to;
    else segs.push({ from: s.t, to, net: s.network });
  });
  const kinds = Array.from(new Set(segs.map((s) => s.net ?? 'none')));
  return (
    <figure style={{ margin: 0 }}>
      <figcaption style={{ fontWeight: 600, marginBottom: 4 }}>{title}</figcaption>
      <svg role="img" aria-label={`${title}: ${kinds.join(', ')}`} viewBox={`0 0 ${W} 28`} style={{ width: '100%', height: 'auto', display: 'block' }}>
        {segs.map((s, i) => (
          <rect
            key={i}
            x={((s.from - tMin) / span) * W}
            y={2}
            width={Math.max(2, ((s.to - s.from) / span) * W)}
            height={22}
            fill={colorFor(s.net)}
          >
            <title>{s.net ?? 'none'}</title>
          </rect>
        ))}
      </svg>
      <div style={{ display: 'flex', gap: 12, fontSize: 12, marginTop: 4 }}>
        {kinds.map((k) => (
          <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 10, height: 10, background: colorFor(k), display: 'inline-block', borderRadius: 2 }} />
            {k}
          </span>
        ))}
      </div>
    </figure>
  );
}
