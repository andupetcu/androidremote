import '@testing-library/jest-dom/vitest';
import { afterAll, afterEach, beforeAll, vi } from 'vitest';
import { server } from './mocks/server';

// Deterministic dialogs: see modalDouble.tsx for why the Fluent Modal is replaced in tests.
vi.mock('../components/ui/Modal', async () => {
  const { ModalDouble } = await import('./modalDouble');
  return { Modal: ModalDouble };
});

// Establish API mocking before all tests
beforeAll(() => {
  // WebSocket upgrades (the shared admin socket opens one on mount) are not HTTP calls under
  // test: ignore them. Every other unmatched request is still an error.
  server.listen({
    onUnhandledRequest(request, print) {
      if (/^wss?:/.test(request.url) || request.headers.get('upgrade') === 'websocket') return;
      print.error();
    },
  });

  // Components that open the shared admin socket must not make a real connection in tests
  // (a live socket at worker exit crashes libuv on recent Node). Set AFTER listen(), because
  // MSW wraps the global WebSocket. Tests that need a socket stub FakeWebSocket over this.
  class InertWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    readyState = 0;
    binaryType = 'blob';
    onopen: unknown = null;
    onclose: unknown = null;
    onerror: unknown = null;
    onmessage: unknown = null;
    url: string;
    constructor(url: string) { this.url = url; }
    send() {}
    close() { this.readyState = 3; }
    addEventListener() {}
    removeEventListener() {}
  }
  Object.defineProperty(globalThis, 'WebSocket', { value: InertWebSocket, configurable: true, writable: true });

  // Node's fetch cannot resolve relative URLs ('/api/files'), unlike a browser.
  // Resolve them against the jsdom origin so MSW's relative handlers match.
  const msFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === 'string' && input.startsWith('/')) {
      input = new URL(input, window.location.origin).toString();
    }
    return msFetch(input, init);
  }) as typeof fetch;
});

// Reset handlers after each test
afterEach(() => server.resetHandlers());

// Clean up after all tests
afterAll(() => server.close());

// Mock ResizeObserver for tests
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as Record<string, unknown>).ResizeObserver = ResizeObserverMock;

// Mock MediaStream for video tests
class MediaStreamMock {
  getTracks() { return []; }
}
(globalThis as unknown as Record<string, unknown>).MediaStream = MediaStreamMock;

// Mock URL.createObjectURL
URL.createObjectURL = vi.fn(() => 'mock-url');
URL.revokeObjectURL = vi.fn();

// jsdom has no canvas implementation: getContext() returns null, which makes
// FrameDecoder throw. Provide a no-op 2D context stub.
const ctx2dStub = new Proxy({}, {
  get: (_t, prop) => (prop === 'canvas' ? undefined : vi.fn()),
  set: () => true,
});
HTMLCanvasElement.prototype.getContext = vi.fn(() => ctx2dStub) as unknown as HTMLCanvasElement['getContext'];

// Recent Node versions ship an experimental global localStorage that shadows
// jsdom's and throws unless --localstorage-file is given. Install a plain
// in-memory Storage so code under test (apiFetch reads auth_token) behaves
// as in a browser.
function createMemoryStorage(): Storage {
  let store = new Map<string, string>();
  return {
    get length() { return store.size; },
    clear: () => { store = new Map(); },
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    removeItem: (k: string) => { store.delete(k); },
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
  };
}
const memoryStorage = createMemoryStorage();
Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage, configurable: true, writable: true });
Object.defineProperty(window, 'localStorage', { value: memoryStorage, configurable: true, writable: true });
