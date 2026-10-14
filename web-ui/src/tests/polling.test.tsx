import { render, screen, act, waitFor, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from './mocks/server';
import { API_BASE } from '../utils/api';
import { createPoller, debounce, inflight } from '../lib/polling';
import { useDevices, useDevice } from '../hooks/useDevices';
import { useAllTelemetry } from '../hooks/useTelemetry';
import { FakeWebSocket, installFakeWebSocket } from './fakeWebSocket';
import { closeAdminSocket } from '../lib/adminSocket';
import { DeviceCommands } from '../components/device/DeviceCommands';

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { value: hidden, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

afterEach(() => {
  cleanup();
  setHidden(false);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  closeAdminSocket();
});

describe('createPoller (WU-16)', () => {
  beforeEach(() => vi.useFakeTimers());

  it('runs on the interval and stops on stop()', async () => {
    const task = vi.fn().mockResolvedValue(true);
    const p = createPoller({ task, intervalMs: 1000 });
    p.start();
    await vi.advanceTimersByTimeAsync(3100);
    expect(task).toHaveBeenCalledTimes(3);
    p.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(task).toHaveBeenCalledTimes(3);
  });

  it('does not run while the tab is hidden and runs once when it is visible again', async () => {
    const task = vi.fn().mockResolvedValue(true);
    const p = createPoller({ task, intervalMs: 1000 });
    p.start();
    setHidden(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(task).not.toHaveBeenCalled();
    setHidden(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(task).toHaveBeenCalledTimes(1);
    p.stop();
  });

  it('backs off exponentially after failures (capped) and resets after a success', async () => {
    const results = [false, false, false, false, true];
    const times: number[] = [];
    const task = vi.fn(async () => {
      times.push(Date.now());
      return results.shift() ?? true;
    });
    const t0 = Date.now();
    const p = createPoller({ task, intervalMs: 1000, maxIntervalMs: 4000 });
    p.start();
    await vi.advanceTimersByTimeAsync(20_000);
    const gaps = times.map((t, i) => (i === 0 ? t - t0 : t - times[i - 1]));
    // 1s first wait; failures double the wait: 2s, 4s, 4s (cap); after the success back to 1s
    expect(gaps.slice(0, 6)).toEqual([1000, 2000, 4000, 4000, 4000, 1000]);
    p.stop();
  });

  it('never overlaps two runs of the same poller', async () => {
    let active = 0;
    let maxActive = 0;
    const task = vi.fn(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5000));
      active--;
    });
    const p = createPoller({ task, intervalMs: 1000 });
    p.start();
    await vi.advanceTimersByTimeAsync(1000);
    p.trigger();
    p.trigger();
    await vi.advanceTimersByTimeAsync(12_000);
    expect(maxActive).toBe(1);
    p.stop();
  });
});

describe('debounce and inflight', () => {
  it('debounce collapses a burst into one trailing call', async () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = debounce(fn, 2000);
    for (let i = 0; i < 50; i++) d();
    await vi.advanceTimersByTimeAsync(1999);
    expect(fn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('inflight shares one request between concurrent callers', async () => {
    const fn = vi.fn(() => new Promise<number>((r) => setTimeout(() => r(7), 10)));
    const [a, b] = await Promise.all([inflight('k', fn), inflight('k', fn)]);
    expect([a, b]).toEqual([7, 7]);
    expect(fn).toHaveBeenCalledTimes(1);
    await inflight('k', fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

function DevicesProbe() {
  const { devices } = useDevices();
  const { device } = useDevice('d1');
  return <div>{devices.length}:{device?.id ?? 'none'}</div>;
}

describe('hooks use the scheduler (WU-16)', () => {
  it('useDevices and useDevice mounted together do not duplicate the same request', async () => {
    let listCalls = 0;
    let oneCalls = 0;
    server.use(
      http.get(`${API_BASE}/api/devices`, () => { listCalls++; return HttpResponse.json({ devices: [{ id: 'd1' }] }); }),
      http.get(`${API_BASE}/api/devices/d1`, () => { oneCalls++; return HttpResponse.json({ id: 'd1' }); })
    );
    function Two() { return <><DevicesProbe /><DevicesProbe /></>; }
    render(<Two />);
    await waitFor(() => expect(screen.getAllByText('1:d1')).toHaveLength(2));
    expect(listCalls).toBe(1);
    expect(oneCalls).toBe(1);
  });

  it('device list polling pauses while the tab is hidden', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ devices: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    function P() { useDevices(); return null; }
    render(<P />);
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    setHidden(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    setHidden(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(fetchMock).toHaveBeenCalledTimes(2); // catches up once on return
  });

  it('useAllTelemetry backs off while the server keeps failing', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response('{}', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    function P() { useAllTelemetry(); return null; }
    render(<P />);
    await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000); });
    // fixed 30 s polling would be 21 calls in 10 minutes; backoff (30,60,120,240 cap) stays under 10
    expect(fetchMock.mock.calls.length).toBeLessThan(10);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(2);
  });
});

describe('command status uses live events instead of 5 s polling (T5 follow-up)', () => {
  it('refreshes the command list when the admin socket reports a command event, and does not poll every 5 s', async () => {
    installFakeWebSocket();
    server.use(
      http.post(`${API_BASE}/api/ws-ticket`, () => HttpResponse.json({ ticket: 't', expiresAt: Date.now() + 60000 }))
    );
    let calls = 0;
    let status = 'executing';
    server.use(
      http.get(`${API_BASE}/api/devices/dev-1/commands`, () => {
        calls++;
        return HttpResponse.json({ commands: [{ id: 'c1', deviceId: 'dev-1', type: 'REBOOT', payload: {}, status, createdAt: 1 }] });
      })
    );
    render(<DeviceCommands deviceId="dev-1" />);
    await screen.findByText('executing');
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    const before = calls;
    await new Promise((r) => setTimeout(r, 5600));
    expect(calls).toBe(before); // no 5 s polling while the socket is connected
    FakeWebSocket.instances[0].open();
    status = 'completed';
    FakeWebSocket.instances[0].receive({
      type: 'device-event',
      event: { id: 'e1', deviceId: 'dev-1', eventType: 'command-completed', severity: 'info', data: { commandId: 'c1' }, acknowledged: false, createdAt: 2 },
    });
    await screen.findByText('completed', {}, { timeout: 4000 });
  }, 15000);

  it('patches a command in place from a command-update message', async () => {
    installFakeWebSocket();
    server.use(
      http.post(`${API_BASE}/api/ws-ticket`, () => HttpResponse.json({ ticket: 't', expiresAt: Date.now() + 60000 })),
      http.get(`${API_BASE}/api/devices/dev-1/commands`, () =>
        HttpResponse.json({ commands: [{ id: 'c1', deviceId: 'dev-1', type: 'LOCK', payload: {}, status: 'delivered', createdAt: 1 }] })
      )
    );
    render(<DeviceCommands deviceId="dev-1" />);
    await screen.findByText('delivered');
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    FakeWebSocket.instances[0].open();
    act(() => {
      FakeWebSocket.instances[0].receive({
        type: 'command-update',
        deviceId: 'dev-1',
        command: { id: 'c1', deviceId: 'dev-1', type: 'LOCK', payload: {}, status: 'executing', createdAt: 1 },
      });
    });
    await screen.findByText('executing');
  });
});
