import { useState } from 'react';
import { render, renderHook, screen, waitFor, act, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from './mocks/server';
import { API_BASE } from '../utils/api';
import { FakeWebSocket, installFakeWebSocket } from './fakeWebSocket';
import { useRealtimeEvents, useRealtimeDeviceStatus } from '../hooks/useAdminWebSocket';
import { useRelayWebSocket } from '../hooks/useRelayWebSocket';
import { useWebRTC } from '../hooks/useWebRTC';
import { closeAdminSocket } from '../lib/adminSocket';
import type { DeviceEvent } from '../types/api';

const JWT = 'eyJhbGciOi.header.payload-secret';
let ticketCalls: Array<{ purpose: string; deviceId?: string; auth: string | null }>;
let ticketSeq: number;

beforeEach(() => {
  installFakeWebSocket();
  localStorage.setItem('auth_token', JWT);
  ticketCalls = [];
  ticketSeq = 0;
  server.use(
    http.post(`${API_BASE}/api/ws-ticket`, async ({ request }) => {
      const body = (await request.json()) as { purpose: string; deviceId?: string };
      ticketCalls.push({ ...body, auth: request.headers.get('authorization') });
      ticketSeq += 1;
      return HttpResponse.json({ ticket: `ticket-${ticketSeq}`, expiresAt: Date.now() + 60000 });
    })
  );
});

afterEach(() => {
  cleanup();
  closeAdminSocket();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const sockets = () => FakeWebSocket.instances;

function EventsProbe() {
  const [events, setEvents] = useState<DeviceEvent[]>([]);
  useRealtimeEvents((e) => setEvents((p) => [e, ...p]));
  return <ul>{events.map((e) => <li key={e.id}>{e.eventType}:{e.deviceId}</li>)}</ul>;
}

describe('admin websocket (WU-02, WU-03, WU-04, WU-12)', () => {
  it('fetches an admin ticket with the JWT and connects with ?ticket= and no JWT in the URL', async () => {
    render(<EventsProbe />);
    await waitFor(() => expect(sockets()).toHaveLength(1));
    expect(ticketCalls[0]).toMatchObject({ purpose: 'admin', auth: `Bearer ${JWT}` });
    expect(sockets()[0].url).toMatch(/\/admin\?ticket=ticket-1$/);
    expect(sockets()[0].url).not.toContain(JWT);
    expect(sockets()[0].url).not.toContain('token=');
  });

  it('shows a live device-event in the events list', async () => {
    render(<EventsProbe />);
    await waitFor(() => expect(sockets()).toHaveLength(1));
    act(() => sockets()[0].open());
    act(() =>
      sockets()[0].receive({
        type: 'device-event',
        event: { id: 'e1', deviceId: 'dev-9', eventType: 'battery-critical', severity: 'critical', createdAt: 1 },
      })
    );
    expect(await screen.findByText('battery-critical:dev-9')).toBeInTheDocument();
  });

  it('maps device-event online/offline event types to the status callbacks', async () => {
    const onOnline = vi.fn();
    const onOffline = vi.fn();
    renderHook(() => useRealtimeDeviceStatus(onOnline, onOffline));
    await waitFor(() => expect(sockets()).toHaveLength(1));
    act(() => sockets()[0].open());
    act(() => sockets()[0].receive({ type: 'device-event', event: { id: 'a', deviceId: 'd1', eventType: 'device-online' } }));
    act(() => sockets()[0].receive({ type: 'device-event', event: { id: 'b', deviceId: 'd2', eventType: 'device-offline' } }));
    expect(onOnline).toHaveBeenCalledWith('d1', undefined);
    expect(onOffline).toHaveBeenCalledWith('d2');
  });

  it('shares ONE socket between several hook instances', async () => {
    renderHook(() => {
      useRealtimeEvents(() => {});
      useRealtimeDeviceStatus();
    });
    render(<EventsProbe />);
    await waitFor(() => expect(sockets().length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 30));
    expect(sockets()).toHaveLength(1);
    expect(ticketCalls).toHaveLength(1);
  });

  it('does not reconnect after unmount', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { unmount } = render(<EventsProbe />);
      await waitFor(() => expect(sockets()).toHaveLength(1));
      act(() => sockets()[0].open());
      unmount();
      await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
      expect(sockets()).toHaveLength(1);
      expect(ticketCalls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reconnects with a FRESH ticket when the server drops the socket', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<EventsProbe />);
      await waitFor(() => expect(sockets()).toHaveLength(1));
      act(() => sockets()[0].open());
      act(() => sockets()[0].drop());
      await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
      await waitFor(() => expect(sockets()).toHaveLength(2));
      expect(sockets()[1].url).toMatch(/ticket=ticket-2$/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('closeAdminSocket (logout) closes the socket and stops reconnecting', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<EventsProbe />);
      await waitFor(() => expect(sockets()).toHaveLength(1));
      act(() => sockets()[0].open());
      closeAdminSocket();
      await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
      expect(sockets()[0].readyState).toBe(3);
      expect(sockets()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('relay websocket (WU-12)', () => {
  it('uses a relay ticket, never the JWT, in the URL', async () => {
    const { result } = renderHook(() =>
      useRelayWebSocket({ deviceId: 'dev 1', sessionType: 'terminal', token: JWT })
    );
    act(() => result.current.connect());
    await waitFor(() => expect(sockets()).toHaveLength(1));
    expect(ticketCalls[0]).toMatchObject({ purpose: 'relay', deviceId: 'dev 1' });
    const url = sockets()[0].url;
    expect(url).toContain('ticket=ticket-1');
    expect(new URL(url).searchParams.get('deviceId')).toBe('dev 1');
    expect(url).not.toContain(JWT);
    expect(url).not.toContain('token=');
  });
});

describe('signaling websocket (WU-02)', () => {
  it('fetches a signaling ticket bound to the device and connects with ?ticket=', async () => {
    class PC {
      createDataChannel() { return { close() {}, addEventListener() {}, send() {} }; }
      close() {}
      addEventListener() {}
      createOffer() { return Promise.resolve({}); }
      setLocalDescription() { return Promise.resolve(); }
    }
    vi.stubGlobal('RTCPeerConnection', PC);
    renderHook(() => useWebRTC('dev-7', 'ws://host/ws'));
    await waitFor(() => expect(sockets()).toHaveLength(1));
    expect(ticketCalls[0]).toMatchObject({ purpose: 'signaling', deviceId: 'dev-7', auth: `Bearer ${JWT}` });
    expect(sockets()[0].url).toBe('ws://host/ws?ticket=ticket-1');
  });
});
