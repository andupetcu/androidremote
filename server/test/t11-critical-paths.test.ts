import request from 'supertest';
import { createServer, Server } from 'http';
import WebSocket from 'ws';
import Database from 'better-sqlite3';
import { app, resetRateLimiters } from '../src/app';
import { setupSignaling, clearRooms } from '../src/signaling';
import { shutdownRelay } from '../src/relay';
import { deviceStore } from '../src/services/deviceStore';
import { commandStore } from '../src/services/commandStore';
import { eventStore } from '../src/services/eventStore';
import { wsTicketStore } from '../src/services/wsTicketStore';
import { setupTestDatabase, cleanupTestDatabase, closeTestDatabase, adminAuthHeader, deviceTokenFor } from './setup';

let db: Database.Database;
beforeAll(() => { db = setupTestDatabase(); });
afterAll(() => closeTestDatabase());
beforeEach(() => { cleanupTestDatabase(); resetRateLimiters(); });

interface RouteInfo { method: string; path: string }

/** Every route registered with a string path, read from the Express router stack. */
function registeredApiRoutes(): RouteInfo[] {
  const out: RouteInfo[] = [];
  const stack: any[] = (app as any)._router.stack;
  // Routers mounted with app.use(prefix, router): the prefix is recovered from the layer's regexp.
  const mountOf = (layer: any): string =>
    layer.regexp.source.replace(/^\^/, '').replace(/\\\/\?\(\?=\\\/\|\$\)$/, '').replace(/\\\//g, '/');
  const walk = (layers: any[], prefix: string) => {
    for (const layer of layers) {
      if (layer.route && typeof layer.route.path === 'string') {
        for (const m of Object.keys(layer.route.methods)) {
          if (layer.route.methods[m]) out.push({ method: m.toUpperCase(), path: prefix + layer.route.path });
        }
      } else if (layer.name === 'router' && layer.handle?.stack) {
        walk(layer.handle.stack, prefix + mountOf(layer));
      }
    }
  };
  walk(stack, '');
  return out.filter(r => r.path.startsWith('/api/'));
}

const fill = (p: string) => p.replace(/:id\b/g, 'dev-1').replace(/:deviceId\b/g, 'dev-1').replace(/:[A-Za-z]+/g, 'x');
const call = (r: RouteInfo, headers: Record<string, string> = {}) => {
  let t = (request(app) as any)[r.method.toLowerCase()](fill(r.path));
  for (const [k, v] of Object.entries(headers)) t = t.set(k, v);
  return ['POST', 'PUT', 'PATCH'].includes(r.method) ? t.send({}) : t;
};

// Routes an anonymous caller may reach (explicit, mirrors PUBLIC_ROUTES plus the login endpoint).
const PUBLIC = new Set([
  'POST /api/auth/login', 'POST /api/pair/initiate', 'GET /api/pair/status/:deviceId', 'POST /api/enroll/device',
  'GET /api/downloads/agent/:platform', 'GET /api/downloads/installer/:platform',
  'GET /api/provisioning/agent.apk',
]);
// Routes a device token (its own id) may reach.
const DEVICE = new Set([
  'POST /api/devices/:id/heartbeat', 'GET /api/devices/:id/commands/pending', 'PATCH /api/devices/:id/commands/:cmdId',
  'POST /api/devices/:id/telemetry', 'POST /api/devices/:id/telemetry/batch', 'POST /api/devices/:id/apps',
  'POST /api/devices/:id/events', 'GET /api/devices/:id/app-updates', 'GET /api/devices/:id/policy', 'PATCH /api/files/:id',
  'GET /api/ice-servers',
]);
const key = (r: RouteInfo) => `${r.method} ${r.path}`;

describe('SR-14: auth gate matrix over every registered /api route', () => {
  const routes = registeredApiRoutes();

  beforeEach(() => { deviceStore.enrollDevice({ id: 'dev-1', name: 'd', model: 'm' }); });

  it('discovers the route table (guards the matrix against silently testing nothing)', () => {
    expect(routes.length).toBeGreaterThan(85);
    expect(routes.map(key)).toEqual(expect.arrayContaining([...PUBLIC].filter(k => k !== 'GET /api/pair/status/:deviceId')));
  });

  it('every non-public route answers an anonymous request with 401', async () => {
    const failures: string[] = [];
    for (const r of routes.filter(r => !PUBLIC.has(key(r)))) {
      const res = await call(r);
      if (res.status !== 401) failures.push(`${key(r)} -> ${res.status}`);
    }
    expect(failures).toEqual([]);
  });

  it('every route outside the device list answers a device token with 401', async () => {
    const token = deviceTokenFor('dev-1');
    const failures: string[] = [];
    for (const r of routes.filter(r => !PUBLIC.has(key(r)) && !DEVICE.has(key(r)))) {
      const res = await call(r, { 'X-Session-Token': token });
      if (res.status !== 401) failures.push(`${key(r)} -> ${res.status}`);
    }
    expect(failures).toEqual([]);
  });

  it('every device route refuses a device token that belongs to another device', async () => {
    deviceStore.enrollDevice({ id: 'dev-2', name: 'd2', model: 'm' });
    const token = deviceTokenFor('dev-2');
    const failures: string[] = [];
    for (const r of routes.filter(r => DEVICE.has(key(r)) && r.path.includes('/devices/:id/'))) {
      const res = await call(r, { 'X-Session-Token': token });
      if (res.status !== 401) failures.push(`${key(r)} -> ${res.status}`);
    }
    expect(failures).toEqual([]);
  });

  it('the admin token reaches every admin route (nothing answers 401 or 403)', async () => {
    const failures: string[] = [];
    for (const r of routes.filter(r => !PUBLIC.has(key(r)) && !DEVICE.has(key(r)) && r.path !== '/api/auth/logout' && r.path !== '/api/auth/password')) {
      let res: any;
      try { res = await call(r, { Authorization: adminAuthHeader() }); } catch (e) { failures.push(`${key(r)} threw ${e}`); continue; }
      if (res.status === 401 || res.status === 403) failures.push(`${key(r)} -> ${res.status}`);
    }
    expect(failures).toEqual([]);
  });

  it('the public routes really are reachable anonymously', async () => {
    for (const k of PUBLIC) {
      if (k === 'POST /api/auth/login') continue; // 401 for bad credentials is its normal answer
      const [method, path] = k.split(' ');
      const res = await call({ method, path });
      expect(res.status).not.toBe(401);
    }
  });

  it('the regex route /api/uploads/* is gated too', async () => {
    expect((await request(app).get('/api/uploads/apks/x.apk')).status).toBe(401);
  });
});

describe('SR-14: command lifecycle end to end over HTTP (C5)', () => {
  async function enrollOverHttp(): Promise<{ id: string; token: string }> {
    const t = await request(app).post('/api/enroll/tokens').set('Authorization', adminAuthHeader()).send({});
    const r = await request(app).post('/api/enroll/device').send({ token: t.body.token, deviceName: 'Phone' });
    return { id: r.body.deviceId, token: r.body.sessionToken };
  }
  const poll = (id: string, token: string) => request(app).get(`/api/devices/${id}/commands/pending`).set('X-Session-Token', token);
  const ack = (id: string, token: string, cmd: string, status: string, error?: string) =>
    request(app).patch(`/api/devices/${id}/commands/${cmd}`).set('X-Session-Token', token).send({ status, error });

  it('enrol, queue, deliver, redeliver after the lease, execute, complete, with events and no leftovers', async () => {
    const { id, token } = await enrollOverHttp();
    const queued = await request(app).post(`/api/devices/${id}/commands`).set('Authorization', adminAuthHeader()).send({ type: 'LOCK' });
    expect(queued.status).toBe(201);
    const cmdId = queued.body.id;

    // heartbeat does not consume the queue
    await request(app).post(`/api/devices/${id}/heartbeat`).set('X-Session-Token', token).send({});
    expect(commandStore.getCommand(cmdId)!.status).toBe('pending');

    const first = await poll(id, token);
    expect(first.body.commands.map((c: any) => c.id)).toContain(cmdId);
    expect(commandStore.getCommand(cmdId)!.status).toBe('delivered');
    expect((await poll(id, token)).body.commands.map((c: any) => c.id)).not.toContain(cmdId);

    // the lease runs out: redelivery
    db.prepare('UPDATE device_commands SET lease_expires_at = ? WHERE id = ?').run(Date.now() - 1, cmdId);
    expect((await poll(id, token)).body.commands.map((c: any) => c.id)).toContain(cmdId);

    expect((await ack(id, token, cmdId, 'executing')).status).toBe(200);
    // executing commands are not redelivered
    db.prepare('UPDATE device_commands SET lease_expires_at = ? WHERE id = ?').run(Date.now() - 1, cmdId);
    expect((await poll(id, token)).body.commands.map((c: any) => c.id)).not.toContain(cmdId);

    expect((await ack(id, token, cmdId, 'completed')).status).toBe(200);
    expect((await ack(id, token, cmdId, 'completed')).status).toBe(409);
    expect(commandStore.getCommand(cmdId)!.status).toBe('completed');
    expect(eventStore.getDeviceEvents(id).filter(e => e.eventType === 'command-completed')).toHaveLength(1);

    // history API shows the finished command
    const hist = await request(app).get(`/api/devices/${id}/commands`).set('Authorization', adminAuthHeader());
    expect(hist.body.commands[0]).toMatchObject({ id: cmdId, status: 'completed' });
  });

  it('an expired command is never delivered and its ack is 410', async () => {
    const { id, token } = await enrollOverHttp();
    const c = commandStore.queueCommand(id, 'REBOOT', {});
    db.prepare('UPDATE device_commands SET expires_at = ? WHERE id = ?').run(Date.now() - 1, c.id);
    expect((await poll(id, token)).body.commands.map((x: any) => x.id)).not.toContain(c.id);
    expect(commandStore.getCommand(c.id)!.status).toBe('expired');
    expect((await ack(id, token, c.id, 'completed')).status).toBe(410);
  });

  it('a failed command records its error and raises command-failed', async () => {
    const { id, token } = await enrollOverHttp();
    const c = commandStore.queueCommand(id, 'LOCK', {});
    await poll(id, token);
    await ack(id, token, c.id, 'failed', 'no permission');
    expect(commandStore.getCommand(c.id)).toMatchObject({ status: 'failed', error: 'no permission' });
    expect(eventStore.getDeviceEvents(id).filter(e => e.eventType === 'command-failed')).toHaveLength(1);
  });

  it('one device cannot ack, or cancel, another device\'s command', async () => {
    const a = await enrollOverHttp();
    const b = await enrollOverHttp();
    const c = commandStore.queueCommand(a.id, 'LOCK', {});
    expect((await ack(b.id, b.token, c.id, 'completed')).status).toBe(404);
    expect((await request(app).patch(`/api/devices/${a.id}/commands/${c.id}`).set('X-Session-Token', b.token).send({ status: 'completed' })).status).toBe(401);
    expect(commandStore.getCommand(c.id)!.status).toBe('pending');
  });
});

describe('SR-14: WebSocket auth smoke (signaling, admin, relay)', () => {
  let server: Server;
  let port: number;
  beforeAll(async () => {
    server = createServer(app);
    setupSignaling(server, { db });
    await new Promise<void>(r => server.listen(0, r));
    port = (server.address() as any).port;
  });
  afterAll(async () => {
    clearRooms();
    shutdownRelay();
    await new Promise(r => setTimeout(r, 50));
    await new Promise<void>(r => server.close(() => r()));
  });

  function status(path: string, headers: Record<string, string> = {}): Promise<number> {
    return new Promise(resolve => {
      const ws = new WebSocket(`ws://localhost:${port}${path}`, { headers });
      ws.on('open', () => { ws.close(); resolve(101); });
      ws.on('unexpected-response', (_q, res) => { resolve(res.statusCode || 0); ws.terminate(); });
      ws.on('error', () => resolve(0));
    });
  }

  it('anonymous upgrades on /ws, /admin and /relay are rejected with 401', async () => {
    expect(await status('/ws')).toBe(401);
    expect(await status('/admin')).toBe(401);
    expect(await status('/relay?deviceId=dev-1&session=desktop')).toBe(401);
    expect(await status('/ws?token=' + adminAuthHeader().slice(7))).toBe(401); // JWT in a URL is not a credential
  });

  it('a ticket of the right purpose opens, once', async () => {
    const t = wsTicketStore.issue({ purpose: 'admin', subject: 'admin' }).ticket;
    expect(await status(`/admin?ticket=${t}`)).toBe(101);
    expect(await status(`/admin?ticket=${t}`)).toBe(401);
    const wrong = wsTicketStore.issue({ purpose: 'signaling', subject: 'admin' }).ticket;
    expect(await status(`/admin?ticket=${wrong}`)).toBe(401);
  });

  it('a relay viewer needs a relay ticket bound to the device in the URL', async () => {
    const other = wsTicketStore.issue({ purpose: 'relay', subject: 'admin', deviceId: 'dev-2' }).ticket;
    expect(await status(`/relay?deviceId=dev-1&session=desktop&ticket=${other}`)).toBe(401);
    const ok = wsTicketStore.issue({ purpose: 'relay', subject: 'admin', deviceId: 'dev-1' }).ticket;
    expect(await status(`/relay?deviceId=dev-1&session=desktop&ticket=${ok}`)).toBe(101);
  });

  it('a device session token opens /ws; an unknown one does not', async () => {
    deviceStore.enrollDevice({ id: 'dev-1', name: 'd', model: 'm' });
    const token = deviceTokenFor('dev-1');
    expect(await status('/ws', { Authorization: `Bearer ${token}` })).toBe(101);
    expect(await status('/ws', { Authorization: 'Bearer nope' })).toBe(401);
  });
});
