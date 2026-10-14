/**
 * Telemetry history helpers (WU-19). The UI always asks for a bounded window
 * and a server-side downsampled series (`bucket`), never the raw samples.
 */

export const RANGES = {
  '1h': { label: '1 hour', ms: 3600_000, bucket: '1m' },
  '24h': { label: '24 hours', ms: 24 * 3600_000, bucket: '15m' },
  '7d': { label: '7 days', ms: 7 * 24 * 3600_000, bucket: '1h' },
  '30d': { label: '30 days', ms: 30 * 24 * 3600_000, bucket: '6h' },
} as const;

export type RangeKey = keyof typeof RANGES;

export const MAX_POINTS = 500;

export interface HistoryWindow {
  from: number;
  to: number;
  bucket: string;
  limit: number;
}

export function rangeFor(key: RangeKey, now: number = Date.now()): HistoryWindow {
  const r = RANGES[key];
  return { from: now - r.ms, to: now, bucket: r.bucket, limit: MAX_POINTS };
}

export interface HistoryPoint {
  t: number;
  battery: number | null;
  network: string | null;
  storageUsed: number | null;
  memoryUsed: number | null;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Accepts the history response in either shape: the server's `dataPoints`
 * (`timestamp`, `storageUsedBytes`, ...) or the typed `history` (`recordedAt`, `storageUsed`, ...).
 */
export function normalizeHistory(data: unknown): HistoryPoint[] {
  const body = (data ?? {}) as Record<string, unknown>;
  const rows = (Array.isArray(body.dataPoints) ? body.dataPoints : Array.isArray(body.history) ? body.history : []) as Array<Record<string, unknown>>;
  const out: HistoryPoint[] = [];
  for (const row of rows) {
    const t = num(row.timestamp) ?? num(row.recordedAt);
    if (t === null) continue;
    out.push({
      t,
      battery: num(row.batteryLevel),
      network: typeof row.networkType === 'string' ? row.networkType : null,
      storageUsed: num(row.storageUsedBytes) ?? num(row.storageUsed),
      memoryUsed: num(row.memoryUsedBytes) ?? num(row.memoryUsed),
    });
  }
  return out.sort((a, b) => a.t - b.t);
}
