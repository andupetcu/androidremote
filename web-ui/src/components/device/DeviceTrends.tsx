import { useMemo, useState, useCallback } from 'react';
import { useTelemetryHistory } from '../../hooks/useTelemetry';
import { usePolling } from '../../hooks/usePolling';
import { rangeFor, RANGES, type RangeKey } from '../../lib/telemetrySeries';
import { TrendChart } from '../data/TrendChart';
import { NetworkTimeline } from '../data/NetworkTimeline';
import { Button } from '../ui/Button';
import { Spinner } from '../ui/Spinner';

const GB = 1024 ** 3;

interface DeviceTrendsProps {
  deviceId: string;
  storageTotal?: number | null;
  memoryTotal?: number | null;
  /** Fetch only when true (the Overview loads this section lazily). */
  enabled?: boolean;
}

/** Battery, storage, memory and network trends from the server's downsampled history. */
export default function DeviceTrends({ deviceId, storageTotal, memoryTotal, enabled = true }: DeviceTrendsProps) {
  const [rangeKey, setRangeKey] = useState<RangeKey>('24h');
  const [stamp, setStamp] = useState(() => Date.now());
  const window = useMemo(() => rangeFor(rangeKey, stamp), [rangeKey, stamp]);
  const { points, loading, error, refresh } = useTelemetryHistory(deviceId, window, enabled);

  // Slide the window forward every 5 minutes (and not while the tab is hidden)
  usePolling(async () => { setStamp(Date.now()); }, 5 * 60_000, enabled);

  const retry = useCallback(() => { setStamp(Date.now()); void refresh(); }, [refresh]);

  const series = (pick: (p: (typeof points)[number]) => number | null, scale = 1) =>
    points.map((p) => ({ t: p.t, v: pick(p) === null ? null : (pick(p) as number) / scale }));

  return (
    <div className="device-trends">
      <div role="group" aria-label="Time range" style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        {(Object.keys(RANGES) as RangeKey[]).map((k) => (
          <Button
            key={k}
            size="sm"
            variant={k === rangeKey ? 'primary' : 'secondary'}
            onClick={() => { setRangeKey(k); setStamp(Date.now()); }}
          >
            {RANGES[k].label}
          </Button>
        ))}
      </div>

      {error ? (
        <div role="alert">
          <p>Could not load telemetry history: {error}</p>
          <Button size="sm" variant="secondary" onClick={retry}>Retry</Button>
        </div>
      ) : loading ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><Spinner size="sm" /><span>Loading history...</span></div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16 }}>
          <TrendChart title="Battery" unit="%" domain={[0, 100]} color="#66bb6a" series={series((p) => p.battery)} />
          <TrendChart
            title="Storage used"
            unit=" GB"
            digits={1}
            domain={storageTotal ? [0, storageTotal / GB] : undefined}
            color="#4fc3f7"
            series={series((p) => p.storageUsed, GB)}
          />
          <TrendChart
            title="Memory used"
            unit=" GB"
            digits={1}
            domain={memoryTotal ? [0, memoryTotal / GB] : undefined}
            color="#ba68c8"
            series={series((p) => p.memoryUsed, GB)}
          />
          <NetworkTimeline samples={points.map((p) => ({ t: p.t, network: p.network }))} />
        </div>
      )}
    </div>
  );
}

export { DeviceTrends };
