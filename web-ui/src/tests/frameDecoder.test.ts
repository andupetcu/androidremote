import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FrameDecoder } from '../lib/FrameDecoder';

// WU-07 / WU-08 / C9 decoder behaviour, against a fake WebCodecs VideoDecoder.

class FakeVideoDecoder {
  static instances: FakeVideoDecoder[] = [];
  state: 'unconfigured' | 'configured' | 'closed' = 'unconfigured';
  decodeQueueSize = 0;
  decoded: Array<{ type: string; timestamp: number }> = [];
  configureCalls = 0;
  outputCb: (f: unknown) => void;
  errorCb: (e: Error) => void;
  constructor(init: { output: (f: unknown) => void; error: (e: Error) => void }) {
    this.outputCb = init.output;
    this.errorCb = init.error;
    FakeVideoDecoder.instances.push(this);
  }
  configure() { this.state = 'configured'; this.configureCalls++; }
  decode(chunk: { type: string; timestamp: number }) {
    if (this.state === 'closed') throw new Error('closed');
    this.decoded.push({ type: chunk.type, timestamp: chunk.timestamp });
  }
  reset() { this.state = 'unconfigured'; this.decodeQueueSize = 0; }
  close() { this.state = 'closed'; }
  /** Simulates the browser reporting an async decode error: decoder closes, error callback fires. */
  fail(msg = 'boom') { this.state = 'closed'; this.errorCb(new Error(msg)); }
}

class FakeChunk {
  type: string; timestamp: number; data: Uint8Array;
  constructor(init: { type: string; timestamp: number; data: Uint8Array }) {
    this.type = init.type; this.timestamp = init.timestamp; this.data = init.data;
  }
}

const IDR = [0, 0, 0, 1, 0x65, 1, 2, 3];
const DELTA = [0, 0, 0, 1, 0x41, 1, 2, 3];

function frame(flags: number, ts: number, body: number[]): ArrayBuffer {
  const buf = new ArrayBuffer(9 + body.length);
  const v = new DataView(buf);
  v.setUint8(0, flags);
  v.setBigUint64(1, BigInt(ts), false);
  new Uint8Array(buf, 9).set(body);
  return buf;
}
const key = (ts: number) => frame(1, ts, IDR);
const delta = (ts: number) => frame(0, ts, DELTA);

function chunk(ts: number, index: number, total: number, payload: number[], flags = 1): ArrayBuffer {
  const buf = new ArrayBuffer(13 + payload.length);
  const v = new DataView(buf);
  v.setUint8(0, 0x80 | flags);
  v.setBigUint64(1, BigInt(ts), false);
  v.setUint16(9, index, false);
  v.setUint16(11, total, false);
  new Uint8Array(buf, 13).set(payload);
  return buf;
}

const fakeCanvas = () => ({
  width: 0, height: 0,
  getContext: () => ({ drawImage: vi.fn(), fillRect: vi.fn(), fillText: vi.fn() }),
}) as unknown as HTMLCanvasElement;

const dec = () => FakeVideoDecoder.instances[FakeVideoDecoder.instances.length - 1];

beforeEach(() => {
  FakeVideoDecoder.instances = [];
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
  vi.stubGlobal('VideoDecoder', FakeVideoDecoder);
  vi.stubGlobal('EncodedVideoChunk', FakeChunk);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('FrameDecoder resilience', () => {
  it('surfaces a decode error, rebuilds the decoder and asks for a keyframe (WU-07)', () => {
    const d = new FrameDecoder(fakeCanvas());
    const onError = vi.fn();
    const onKeyframeNeeded = vi.fn();
    d.onError = onError;
    d.onKeyframeNeeded = onKeyframeNeeded;
    d.decode(key(1));
    expect(dec().decoded).toHaveLength(1);
    const first = dec();

    first.fail('corrupt NAL');

    expect(onError).toHaveBeenCalledWith(expect.stringContaining('corrupt NAL'));
    expect(onKeyframeNeeded).toHaveBeenCalledTimes(1);
    expect(dec()).not.toBe(first); // a new decoder replaced the closed one
  });

  it('drops delta frames after an error until the next keyframe, then resumes', () => {
    const d = new FrameDecoder(fakeCanvas());
    d.decode(key(1));
    dec().fail();
    const fresh = dec();
    d.decode(delta(2));
    d.decode(delta(3));
    expect(fresh.decoded).toHaveLength(0);
    d.decode(key(4));
    d.decode(delta(5));
    expect(fresh.decoded.map((c) => c.timestamp)).toEqual([4, 5]);
  });

  it('does not queue delta frames that arrive before the first keyframe (WU-08)', () => {
    const d = new FrameDecoder(fakeCanvas());
    for (let i = 1; i <= 50; i++) d.decode(delta(i));
    d.decode(key(100));
    // only the keyframe is decoded; the stale deltas were never buffered
    expect(dec().decoded.map((c) => c.timestamp)).toEqual([100]);
  });

  it('drops deltas and requests a keyframe when the decode backlog is too large (WU-08)', () => {
    const d = new FrameDecoder(fakeCanvas());
    const onKeyframeNeeded = vi.fn();
    d.onKeyframeNeeded = onKeyframeNeeded;
    d.decode(key(1));
    dec().decodeQueueSize = 12;
    d.decode(delta(2));
    d.decode(delta(3));
    expect(dec().decoded.map((c) => c.timestamp)).toEqual([1]);
    expect(onKeyframeNeeded).toHaveBeenCalledTimes(1);
  });

  it('skips the backlog by resetting the decoder when a keyframe arrives during a backlog (WU-08)', () => {
    const d = new FrameDecoder(fakeCanvas());
    d.decode(key(1));
    const decoder = dec();
    decoder.decodeQueueSize = 12;
    d.decode(key(2));
    expect(decoder.decodeQueueSize).toBe(0); // reset dropped the queue
    expect(decoder.decoded.map((c) => c.timestamp)).toEqual([1, 2]);
  });

  it('caps incomplete chunk sets by count and requests a keyframe when one is evicted', () => {
    const d = new FrameDecoder(fakeCanvas());
    const onKeyframeNeeded = vi.fn();
    d.onKeyframeNeeded = onKeyframeNeeded;
    for (let ts = 1; ts <= 40; ts++) d.decode(chunk(ts, 0, 2, [0, 0, 0, 1, 0x65]));
    expect(d.pendingChunkSets).toBeLessThanOrEqual(8);
    expect(onKeyframeNeeded).toHaveBeenCalled();
  });

  it('caps incomplete chunk data by bytes', () => {
    const d = new FrameDecoder(fakeCanvas());
    const big = new Array(1024 * 1024).fill(7);
    for (let ts = 1; ts <= 20; ts++) d.decode(chunk(ts, 0, 2, big));
    expect(d.pendingChunkBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
  });

  it('treats a missing chunk (older incomplete frame overtaken by a newer one) as a gap', () => {
    const d = new FrameDecoder(fakeCanvas());
    const onKeyframeNeeded = vi.fn();
    d.onKeyframeNeeded = onKeyframeNeeded;
    d.decode(key(1));
    d.decode(chunk(2, 0, 2, [0, 0, 0, 1, 0x41, 9], 0)); // chunk 1 of frame 2 never arrives
    d.decode(chunk(3, 0, 1, [0, 0, 0, 1, 0x41, 9], 0)); // frame 3 completes
    expect(onKeyframeNeeded).toHaveBeenCalledTimes(1);
    expect(dec().decoded.map((c) => c.timestamp)).toEqual([1]); // delta 3 dropped until keyframe
  });

  it('rate-limits keyframe requests to one per second', () => {
    const d = new FrameDecoder(fakeCanvas());
    const onKeyframeNeeded = vi.fn();
    d.onKeyframeNeeded = onKeyframeNeeded;
    d.decode(key(1));
    dec().decodeQueueSize = 12;
    for (let i = 2; i < 10; i++) d.decode(delta(i));
    expect(onKeyframeNeeded).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1100);
    d.decode(delta(20));
    expect(onKeyframeNeeded).toHaveBeenCalledTimes(2);
  });
});
