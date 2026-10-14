import { vi } from 'vitest';

export class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  static CLOSED = 3;
  OPEN = 1;
  readyState = 0;
  binaryType = 'blob';
  onopen: ((e?: unknown) => void) | null = null;
  onclose: ((e?: unknown) => void) | null = null;
  onerror: ((e?: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  sent: unknown[] = [];
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  send(d: unknown) { this.sent.push(d); }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    // like browsers, the close event fires asynchronously after close()
    setTimeout(() => this.onclose?.({ code: 1000, reason: '' }), 0);
  }
  open() { this.readyState = 1; this.onopen?.(); }
  receive(obj: unknown) { this.onmessage?.({ data: JSON.stringify(obj) }); }
  drop() { this.readyState = 3; this.onclose?.({ code: 1006, reason: '' }); }
}

export function installFakeWebSocket() {
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
}
