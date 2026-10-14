// Drop-in for `supertest` (jest moduleNameMapper). When given an Express app, the real supertest starts a new server
// on an ephemeral port for EVERY request and closes it afterwards. A few hundred listen/close cycles per file, times
// ten parallel workers, makes ports get reused while an old connection to them is still being torn down, and a request
// then fails with "socket hang up" (about 1 run in 8 under load). Here each app gets ONE server for the whole file,
// closed by closeSupertestServers() in an afterAll (test/support/afterEnv.ts).
import type { Server } from 'http';
import { createServer } from 'http';

const actual = jest.requireActual('supertest/index.js') as typeof import('supertest');

const servers = new Map<unknown, Server>();

function serverFor(app: unknown): Server {
  let s = servers.get(app);
  if (!s) {
    s = createServer(app as Parameters<typeof createServer>[1]);
    s.listen(0); // no host: binds synchronously, so address() is set before supertest asks for it
    s.unref();
    servers.set(app, s);
  }
  return s;
}

function wrapped(app: unknown, ...rest: unknown[]) {
  const target = typeof app === 'function' ? serverFor(app) : app;
  return (actual as unknown as (...a: unknown[]) => unknown)(target, ...rest);
}

export function closeSupertestServers(): Promise<void> {
  const all = [...servers.values()];
  servers.clear();
  return Promise.all(all.map((s) => new Promise<void>((r) => {
    s.closeAllConnections();
    s.close(() => r());
  }))).then(() => undefined);
}

module.exports = Object.assign(wrapped, actual, { default: wrapped, closeSupertestServers });
