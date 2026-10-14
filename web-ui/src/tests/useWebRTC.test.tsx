import { renderHook, waitFor, act, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from './mocks/server';
import { API_BASE } from '../utils/api';
import { FakeWebSocket, installFakeWebSocket } from './fakeWebSocket';
import { useWebRTC } from '../hooks/useWebRTC';
import * as hookModule from '../hooks/useWebRTC';

// WU-09, WU-10, WU-20 (hook side), C7, C8, C9

class FakeChannel {
  label: string; opts: RTCDataChannelInit;
  readyState = 'open'; binaryType = 'blob';
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  constructor(label: string, opts: RTCDataChannelInit) { this.label = label; this.opts = opts; }
  send(d: string) { this.sent.push(d); }
  close() { this.readyState = 'closed'; }
}
class FakePC {
  static instances: FakePC[] = [];
  config: RTCConfiguration;
  channels: FakeChannel[] = [];
  connectionState = 'new';
  onicecandidate: unknown = null;
  onconnectionstatechange: (() => void) | null = null;
  constructor(config: RTCConfiguration) { this.config = config; FakePC.instances.push(this); }
  createDataChannel(label: string, opts: RTCDataChannelInit) {
    const c = new FakeChannel(label, opts); this.channels.push(c); return c;
  }
  ch(label: string) { return this.channels.find((c) => c.label === label)!; }
  createOffer() { return Promise.resolve({ type: 'offer', sdp: 'sdp' }); }
  setLocalDescription() { return Promise.resolve(); }
  setRemoteDescription() { return Promise.resolve(); }
  addIceCandidate() { return Promise.resolve(); }
  close() {}
}

const SERVERS = [
  { urls: ['stun:stun.example.org:3478'] },
  { urls: ['turn:turn.example.org:3478'], username: '1700000000:admin', credential: 'hmac' },
];
let iceCalls = 0;

beforeEach(() => {
  installFakeWebSocket();
  FakePC.instances = [];
  iceCalls = 0;
  vi.stubGlobal('RTCPeerConnection', FakePC);
  localStorage.setItem('auth_token', 'jwt-1');
  server.use(
    http.post(`${API_BASE}/api/ws-ticket`, () => HttpResponse.json({ ticket: 't1', expiresAt: Date.now() + 60000 })),
    http.get(`${API_BASE}/api/ice-servers`, ({ request }) => {
      iceCalls++;
      expect(request.headers.get('authorization')).toBe('Bearer jwt-1');
      return HttpResponse.json({ iceServers: SERVERS });
    })
  );
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); localStorage.clear(); });

const ws = () => FakeWebSocket.instances[0];
const pc = () => FakePC.instances[0];

async function connected() {
  const hook = renderHook(() => useWebRTC('dev-1', 'ws://h/ws'));
  await waitFor(() => expect(FakePC.instances).toHaveLength(1));
  return hook;
}

describe('ICE servers (WU-10, C7)', () => {
  it('uses the iceServers returned by GET /api/ice-servers', async () => {
    await connected();
    expect(iceCalls).toBe(1);
    expect(pc().config.iceServers).toEqual(SERVERS);
  });

  it('has no TURN credentials in source and still connects (STUN only) if the endpoint fails', async () => {
    server.use(http.get(`${API_BASE}/api/ice-servers`, () => new HttpResponse(null, { status: 500 })));
    await connected();
    const servers = pc().config.iceServers ?? [];
    expect(servers.length).toBeGreaterThan(0);
    for (const s of servers) {
      expect(s).not.toHaveProperty('credential');
      expect(JSON.stringify(s)).not.toContain('turn:');
    }
  });
});

describe('data channels (C9)', () => {
  it('creates a reliable ordered "commands" channel and an unreliable "video" channel', async () => {
    await connected();
    expect(pc().ch('commands').opts).toMatchObject({ ordered: true });
    expect(pc().ch('commands').opts.maxRetransmits).toBeUndefined();
    expect(pc().ch('video').opts).toEqual({ ordered: false, maxRetransmits: 0 });
    expect(pc().ch('video').binaryType).toBe('arraybuffer');
  });

  it('delivers video from the video channel, and from commands as the fallback, to subscribers', async () => {
    const { result } = await connected();
    const got: ArrayBuffer[] = [];
    act(() => { result.current.subscribeVideo((d) => got.push(d)); });
    const a = new ArrayBuffer(4), b = new ArrayBuffer(8);
    act(() => pc().ch('video').onmessage?.({ data: a }));
    act(() => pc().ch('commands').onmessage?.({ data: b }));
    expect(got).toEqual([a, b]);
  });

  it('keeps command acks working on the same channel as the video fallback (single demux)', async () => {
    const { result } = await connected();
    const cmds = pc().ch('commands');
    act(() => cmds.onopen?.());
    let p!: Promise<unknown>;
    act(() => { p = result.current.sendCommandWithResponse({ type: 'GET_DEVICE_INFO' }); });
    const sentId = JSON.parse(cmds.sent[0]).id;
    act(() => cmds.onmessage?.({ data: JSON.stringify({ commandId: sentId, success: true, data: { type: 'DEVICE_INFO' }, timestamp: 1 }) }));
    await expect(p).resolves.toEqual({ type: 'DEVICE_INFO' });
    expect(result.current.lastAck?.commandId).toBe(sentId);
  });

  it('tracks SCREEN_INFO (size and rotation)', async () => {
    const { result } = await connected();
    act(() => pc().ch('commands').onmessage?.({ data: JSON.stringify({ type: 'SCREEN_INFO', width: 1080, height: 2400, rotation: 0 }) }));
    expect(result.current.screenInfo).toEqual({ width: 1080, height: 2400, rotation: 0 });
    act(() => pc().ch('commands').onmessage?.({ data: JSON.stringify({ type: 'SCREEN_INFO', width: 2400, height: 1080, rotation: 90 }) }));
    expect(result.current.screenInfo).toEqual({ width: 2400, height: 1080, rotation: 90 });
  });

  it('exposes CAPTURE_FAILED reason (C8)', async () => {
    const { result } = await connected();
    act(() => pc().ch('commands').onmessage?.({ data: JSON.stringify({ type: 'CAPTURE_FAILED', reason: 'projection denied' }) }));
    expect(result.current.captureError).toBe('projection denied');
  });

  it('requestKeyframe sends {"type":"REQUEST_KEYFRAME"} on the commands channel', async () => {
    const { result } = await connected();
    act(() => result.current.requestKeyframe());
    expect(pc().ch('commands').sent.map((s) => JSON.parse(s))).toContainEqual({ type: 'REQUEST_KEYFRAME' });
  });
});

describe('signaling lifecycle (WU-09)', () => {
  it('reports a signaling socket that closes before the peer connection is up', async () => {
    const { result } = await connected();
    act(() => ws().drop());
    expect(result.current.connectionState).toBe('failed');
    expect(result.current.error).toMatch(/signaling/i);
  });

  it('fails with a timeout error if the connection is not established in time', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const { result } = renderHook(() => useWebRTC('dev-1', 'ws://h/ws'));
    await vi.waitFor(() => expect(FakePC.instances).toHaveLength(1));
    act(() => { vi.advanceTimersByTime(25_000); });
    expect(result.current.connectionState).toBe('failed');
    expect(result.current.error).toMatch(/timed out/i);
  });

  it('does not time out once the commands channel is open', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const { result } = renderHook(() => useWebRTC('dev-1', 'ws://h/ws'));
    await vi.waitFor(() => expect(FakePC.instances).toHaveLength(1));
    act(() => pc().ch('commands').onopen?.());
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(result.current.connectionState).toBe('connected');
  });

  it('exposes devicePresent once the device joins the room', async () => {
    const { result } = await connected();
    expect(result.current.devicePresent).toBe(false);
    act(() => ws().open());
    act(() => ws().receive({ type: 'peer-joined', role: 'device' }));
    expect(result.current.devicePresent).toBe(true);
  });
});

describe('cleanup (WU-20)', () => {
  it('clears the 30 s command timer when the ack arrives', async () => {
    const { result } = await connected();
    const cmds = pc().ch('commands');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let p!: Promise<unknown>;
    act(() => { p = result.current.sendCommandWithResponse({ type: 'GET_DEVICE_INFO' }); });
    expect(vi.getTimerCount()).toBe(1);
    const id = JSON.parse(cmds.sent[0]).id;
    act(() => cmds.onmessage?.({ data: JSON.stringify({ commandId: id, success: true, timestamp: 1 }) }));
    await p;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects pending commands and clears their timers on unmount', async () => {
    const { result, unmount } = await connected();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const baseline = vi.getTimerCount();
    let p!: Promise<unknown>;
    act(() => { p = result.current.sendCommandWithResponse({ type: 'GET_DEVICE_INFO' }); });
    expect(vi.getTimerCount()).toBe(baseline + 1);
    const settled = p.then(() => 'resolved', (e: Error) => e.message);
    unmount();
    await expect(settled).resolves.toMatch(/disconnect|closed/i);
    // only FakeWebSocket's own async close event may remain, not the 30 s command timer
    expect(vi.getTimerCount()).toBeLessThanOrEqual(baseline + 1);
    const before = vi.getTimerCount();
    vi.advanceTimersByTime(31_000);
    expect(vi.getTimerCount()).toBeLessThanOrEqual(before);
  });

  it('does not log pointer/ICE details to the console', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { result } = await connected();
    act(() => pc().ch('commands').onopen?.());
    act(() => result.current.sendCommand({ type: 'TAP', x: 0.1, y: 0.2 }));
    act(() => { (pc().onicecandidate as (e: unknown) => void)?.({ candidate: null }); });
    expect(log).not.toHaveBeenCalled();
    expect(hookModule).toBeDefined();
  });
});
