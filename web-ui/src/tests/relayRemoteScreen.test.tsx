import { render, screen, act, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as Protocol from '../lib/BinaryProtocol';

// WU-11: relay desktop (Rust agent) client

type RelayState = 'disconnected' | 'connecting' | 'connected' | 'error';
let relayState: RelayState = 'connected';
let onMessage: (m: Protocol.ProtocolMessage) => void = () => {};
const send = vi.fn();
const connect = vi.fn();
const disconnect = vi.fn();

vi.mock('../hooks/useRelayWebSocket', () => ({
  useRelayWebSocket: (opts: { onMessage: (m: Protocol.ProtocolMessage) => void }) => {
    onMessage = opts.onMessage;
    return { state: relayState, connect, disconnect, send, channelId: 1 };
  },
}));
vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ token: 'jwt' }) }));

import { RelayRemoteScreen } from '../components/RelayRemoteScreen';

const drawn: Array<{ x: number; y: number; id: string }> = [];
const resolvers = new Map<string, () => void>();
let rafCallbacks: Array<() => void> = [];

function tilePayload(x: number, y: number, tag: string): Uint8Array {
  const p = new Uint8Array(10 + tag.length);
  const v = new DataView(p.buffer);
  v.setUint16(0, x, true); v.setUint16(2, y, true); v.setUint16(4, 10, true); v.setUint16(6, 10, true);
  p.set(new TextEncoder().encode(tag), 10);
  return p;
}
const frameMsg = (payload: Uint8Array): Protocol.ProtocolMessage =>
  ({ header: { type: Protocol.DESKTOP_FRAME, length: payload.length, channel: 1, requestId: 0 }, payload });
const resizeMsg = (w: number, h: number): Protocol.ProtocolMessage => {
  const p = new Uint8Array(4); const v = new DataView(p.buffer);
  v.setUint16(0, w, true); v.setUint16(2, h, true);
  return { header: { type: Protocol.DESKTOP_RESIZE, length: 4, channel: 1, requestId: 0 }, payload: p };
};

beforeEach(() => {
  relayState = 'connected';
  drawn.length = 0; resolvers.clear(); rafCallbacks = [];
  send.mockClear(); connect.mockClear(); disconnect.mockClear();
  vi.stubGlobal('createImageBitmap', (blob: Blob) => new Promise((resolve) => {
    const fr = new FileReader();
    fr.onload = () => {
      const tag = String(fr.result);
      resolvers.set(tag, () => resolve({ tag, close() {} }));
    };
    fr.readAsText(blob);
  }));
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => { rafCallbacks.push(cb); return rafCallbacks.length; });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
    drawImage: (bmp: { tag: string }, x: number, y: number) => drawn.push({ x, y, id: bmp.tag }),
  })) as never;
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const flushMicrotasks = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });
const sentInputs = () =>
  send.mock.calls.map(([buf]) => Protocol.decodeAll(new Uint8Array(buf as ArrayBuffer)).messages[0].payload);

describe('tile ordering', () => {
  it('draws tiles in arrival order even when an older JPEG finishes decoding later', async () => {
    render(<RelayRemoteScreen deviceId="d1" />);
    act(() => {
      onMessage(frameMsg(tilePayload(0, 0, 'old')));
      onMessage(frameMsg(tilePayload(0, 0, 'new')));
    });
    await flushMicrotasks();
    // the newer tile finishes decoding first
    await act(async () => { resolvers.get('new')!(); await Promise.resolve(); });
    await flushMicrotasks();
    expect(drawn).toEqual([]); // must wait for the older tile
    await act(async () => { resolvers.get('old')!(); });
    await flushMicrotasks();
    expect(drawn.map((d) => d.id)).toEqual(['old', 'new']);
  });
});

describe('input', () => {
  async function ready() {
    render(<RelayRemoteScreen deviceId="d1" />);
    act(() => onMessage(resizeMsg(1000, 500)));
    const canvas = document.querySelector('canvas')!;
    canvas.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1000, height: 500, right: 1000, bottom: 500, x: 0, y: 0, toJSON: () => ({}) });
    return canvas;
  }

  it('coalesces mouse moves into one message per animation frame, using the latest position', async () => {
    const canvas = await ready();
    send.mockClear();
    for (let i = 1; i <= 20; i++) fireEvent.mouseMove(canvas, { clientX: i * 10, clientY: 50 });
    expect(send).not.toHaveBeenCalled();
    act(() => { const cbs = rafCallbacks; rafCallbacks = []; cbs.forEach((cb) => cb()); });
    expect(send).toHaveBeenCalledTimes(1);
    const payload = sentInputs()[0];
    const v = new DataView(payload.buffer, payload.byteOffset);
    expect(payload[0]).toBe(Protocol.INPUT_MOUSE_MOVE);
    expect(v.getUint16(1, true)).toBe(200);
    expect(v.getUint16(3, true)).toBe(50);
  });

  it('releases held keys when the canvas loses focus', async () => {
    const canvas = await ready();
    fireEvent.keyDown(canvas, { code: 'ControlLeft' });
    fireEvent.keyDown(canvas, { code: 'KeyC' });
    send.mockClear();
    fireEvent.blur(canvas);
    const releases = sentInputs().map((p) => ({
      type: p[0], scan: new DataView(p.buffer, p.byteOffset).getUint16(1, true), action: p[3],
    }));
    expect(releases).toEqual(expect.arrayContaining([
      { type: Protocol.INPUT_KEY_EVENT, scan: 29, action: 1 },
      { type: Protocol.INPUT_KEY_EVENT, scan: 46, action: 1 },
    ]));
    expect(releases).toHaveLength(2);
  });

  it('releases a held mouse button when the pointer leaves the canvas', async () => {
    const canvas = await ready();
    fireEvent.mouseDown(canvas, { button: 0 });
    send.mockClear();
    fireEvent.mouseLeave(canvas);
    const p = sentInputs()[0];
    expect([p[0], p[1], p[2]]).toEqual([Protocol.INPUT_MOUSE_BUTTON, 0, 1]);
  });
});

describe('reconnect', () => {
  it('reconnects (which fetches a fresh ticket) after an unexpected drop, with backoff', () => {
    vi.useFakeTimers();
    const { rerender } = render(<RelayRemoteScreen deviceId="d1" />);
    connect.mockClear();
    relayState = 'disconnected';
    rerender(<RelayRemoteScreen deviceId="d1" />);
    expect(connect).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1100); });
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('does not reconnect after the user pressed Disconnect', () => {
    vi.useFakeTimers();
    const { rerender } = render(<RelayRemoteScreen deviceId="d1" />);
    fireEvent.click(screen.getByText('Disconnect'));
    connect.mockClear();
    relayState = 'disconnected';
    rerender(<RelayRemoteScreen deviceId="d1" />);
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(connect).not.toHaveBeenCalled();
  });
});
