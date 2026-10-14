import { render, screen, waitFor, cleanup, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from './mocks/server';
import { API_BASE } from '../utils/api';
import { rangeFor, normalizeHistory, RANGES } from '../lib/telemetrySeries';
import { TrendChart } from '../components/data/TrendChart';
import { DeviceTrends } from '../components/device/DeviceTrends';
import { DeviceOverview } from '../components/device/DeviceOverview';
import { useTelemetryHistory } from '../hooks/useTelemetry';
import { closeAdminSocket } from '../lib/adminSocket';

beforeEach(() => localStorage.setItem('auth_token', 'jwt'));
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  closeAdminSocket();
});

const GB = 1024 ** 3;
const points = (n: number, start = 1_700_000_000_000, step = 900_000) =>
  Array.from({ length: n }, (_, i) => ({
    timestamp: start + i * step,
    batteryLevel: 100 - i,
    networkType: i < n / 2 ? 'wifi' : 'cellular',
    storageUsedBytes: (20 + i * 0.1) * GB,
    memoryUsedBytes: (3 + (i % 5) * 0.1) * GB,
  }));

function historyHandler(seen: URL[], n = 20) {
  return http.get(`${API_BASE}/api/devices/dev-1/telemetry/history`, ({ request }) => {
    seen.push(new URL(request.url));
    return HttpResponse.json({ deviceId: 'dev-1', dataPoints: points(n) });
  });
}

describe('range and bucket selection (WU-19)', () => {
  it('every range is bounded and asks for a downsampled series', () => {
    const now = 1_700_000_000_000;
    for (const key of Object.keys(RANGES) as Array<keyof typeof RANGES>) {
      const r = rangeFor(key, now);
      expect(r.to).toBe(now);
      expect(r.to - r.from).toBeLessThanOrEqual(30 * 24 * 3600 * 1000);
      expect(r.bucket).toMatch(/^\d+[mhd]$/);
      expect(r.limit).toBeLessThanOrEqual(500);
    }
    expect(rangeFor('24h', now)).toMatchObject({ from: now - 24 * 3600 * 1000, bucket: '15m' });
    expect(rangeFor('7d', now).bucket).toBe('1h');
  });

  it('normalizeHistory accepts the current server shape (dataPoints/timestamp/...Bytes) and the typed shape', () => {
    const a = normalizeHistory({ dataPoints: [{ timestamp: 5, batteryLevel: 50, networkType: 'wifi', storageUsedBytes: 10, memoryUsedBytes: 20 }] });
    const b = normalizeHistory({ history: [{ recordedAt: 5, batteryLevel: 50, networkType: 'wifi', storageUsed: 10, memoryUsed: 20 }] });
    expect(a).toEqual(b);
    expect(a[0]).toEqual({ t: 5, battery: 50, network: 'wifi', storageUsed: 10, memoryUsed: 20 });
    expect(normalizeHistory({})).toEqual([]);
    // sorted ascending, bad rows dropped
    expect(normalizeHistory({ dataPoints: [{ timestamp: 9 }, { timestamp: 3 }, { nope: 1 }] }).map((p) => p.t)).toEqual([3, 9]);
  });
});

describe('useTelemetryHistory (WU-19)', () => {
  function Probe({ enabled = true }: { enabled?: boolean }) {
    const { points, loading } = useTelemetryHistory('dev-1', { from: 1000, to: 5000, bucket: '5m', limit: 300 }, enabled);
    return <div>{loading ? 'loading' : `n=${points.length}`}</div>;
  }

  it('sends from, to, bucket and limit and returns normalized points', async () => {
    const seen: URL[] = [];
    server.use(historyHandler(seen, 7));
    render(<Probe />);
    await screen.findByText('n=7');
    expect(seen).toHaveLength(1);
    expect(Object.fromEntries(seen[0].searchParams)).toEqual({ from: '1000', to: '5000', bucket: '5m', limit: '300' });
  });

  it('does nothing while disabled (lazy)', async () => {
    const seen: URL[] = [];
    server.use(historyHandler(seen));
    render(<Probe enabled={false} />);
    await new Promise((r) => setTimeout(r, 100));
    expect(seen).toHaveLength(0);
  });
});

describe('TrendChart', () => {
  it('draws a line, labels the latest value, and breaks the line at missing samples', () => {
    const { container } = render(
      <TrendChart
        title="Battery"
        unit="%"
        domain={[0, 100]}
        series={[{ t: 0, v: 90 }, { t: 10, v: 80 }, { t: 20, v: null }, { t: 30, v: 60 }, { t: 40, v: 50 }]}
      />
    );
    const img = screen.getByRole('img', { name: /battery/i });
    expect(img.getAttribute('aria-label')).toMatch(/latest 50%/i);
    const d = container.querySelector('path[data-series="line"]')!.getAttribute('d')!;
    expect((d.match(/M/g) ?? []).length).toBe(2); // two segments around the gap
  });

  it('says so when there is no data in the range', () => {
    render(<TrendChart title="Memory" unit="GB" series={[]} />);
    expect(screen.getByText(/no data in this range/i)).toBeInTheDocument();
  });

  it('a single sample still renders a point', () => {
    const { container } = render(<TrendChart title="Storage" unit="GB" series={[{ t: 1, v: 5 }]} />);
    expect(container.querySelector('circle')).not.toBeNull();
  });
});

describe('DeviceTrends (WU-19)', () => {
  it('shows battery, storage, memory and network charts from the downsampled history', async () => {
    const seen: URL[] = [];
    server.use(historyHandler(seen));
    render(<DeviceTrends deviceId="dev-1" storageTotal={64 * GB} memoryTotal={8 * GB} />);
    expect(await screen.findByRole('img', { name: /battery/i })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /storage/i })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /memory/i })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /network/i })).toBeInTheDocument();
    expect(seen).toHaveLength(1);
    expect(seen[0].searchParams.get('bucket')).toBe('15m'); // 24 h default
    expect(Number(seen[0].searchParams.get('limit'))).toBeLessThanOrEqual(500);
    expect(Number(seen[0].searchParams.get('to')) - Number(seen[0].searchParams.get('from'))).toBe(24 * 3600 * 1000);
  });

  it('switching the range refetches with that range\'s bucket and window', async () => {
    const seen: URL[] = [];
    server.use(historyHandler(seen));
    const user = userEvent.setup();
    render(<DeviceTrends deviceId="dev-1" />);
    await screen.findByRole('img', { name: /battery/i });
    await user.click(screen.getByRole('button', { name: '7 days' }));
    await waitFor(() => expect(seen).toHaveLength(2));
    expect(seen[1].searchParams.get('bucket')).toBe('1h');
    expect(Number(seen[1].searchParams.get('to')) - Number(seen[1].searchParams.get('from'))).toBe(7 * 24 * 3600 * 1000);
  });

  it('shows the error and a retry when the history request fails', async () => {
    server.use(http.get(`${API_BASE}/api/devices/dev-1/telemetry/history`, () => new HttpResponse(null, { status: 500 })));
    render(<DeviceTrends deviceId="dev-1" />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/history/i);
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });
});

describe('DeviceOverview loads trends lazily (WU-19)', () => {
  it('does not fetch history until the Trends section scrolls into view', async () => {
    let trigger: ((visible: boolean) => void) | null = null;
    class IO {
      cb: IntersectionObserverCallback;
      constructor(cb: IntersectionObserverCallback) {
        this.cb = cb;
        trigger = (visible) => cb([{ isIntersecting: visible } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('IntersectionObserver', IO);
    const seen: URL[] = [];
    server.use(
      historyHandler(seen),
      http.get(`${API_BASE}/api/policies`, () => HttpResponse.json({ policies: [] })),
      http.get(`${API_BASE}/api/devices/dev-1/telemetry`, () =>
        HttpResponse.json({ deviceId: 'dev-1', batteryLevel: 80, storageTotalBytes: 64 * GB, storageUsedBytes: 20 * GB, memoryTotalBytes: 8 * GB, memoryUsedBytes: 4 * GB })
      )
    );
    const device = {
      id: 'dev-1', name: 'Pixel', model: 'P', androidVersion: '14', enrolledAt: 1, lastSeenAt: 2, status: 'online',
      osType: 'android', complianceStatus: 'compliant', policyId: null, groupId: null,
    };
    render(<MemoryRouter><DeviceOverview device={device as never} /></MemoryRouter>);
    expect(await screen.findByRole('heading', { name: /trends/i })).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 150));
    expect(seen).toHaveLength(0);
    act(() => trigger?.(true));
    expect(await screen.findByRole('img', { name: /battery/i })).toBeInTheDocument();
    expect(seen).toHaveLength(1);
  });
});
