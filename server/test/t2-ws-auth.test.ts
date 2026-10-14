import { createServer, Server } from 'http';
import crypto from 'crypto';
import WebSocket from 'ws';
import type Database from 'better-sqlite3';
import { setupSignaling, clearRooms, getRoomCount } from '../src/signaling';
import { shutdownRelay, sendWithBackpressure } from '../src/relay';
import { agentConnectionStore } from '../src/services/agentConnectionStore';
import { wsTicketStore } from '../src/services/wsTicketStore';
import { setupTestDatabase, cleanupTestDatabase, closeTestDatabase } from './setup';

// Relay binary protocol (server/src/relay.ts)
const HEADER = 9;
const AUTH_REQUEST = 0x01;
const AUTH_RESPONSE = 0x02;
const DESKTOP_FRAME = 0x12;

function frame(type: number, channel: number, payload: Buffer | object = Buffer.alloc(0)): Buffer {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload));
  const buf = Buffer.alloc(HEADER + body.length);
  buf.writeUInt8(type, 0);
  buf.writeUInt16LE(body.length, 1);
  buf.writeUInt16LE(channel, 3);
  buf.writeUInt32LE(0, 5);
  body.copy(buf, HEADER);
  return buf;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('T2 WebSocket authentication', () => {
  let db: Database.Database;
  let server: Server;
  let port: number;
  let sockets: WebSocket[] = [];

  function addDevice(id: string, expiresAt: number | null = Date.now() + 3_600_000): string {
    db.prepare('INSERT OR IGNORE INTO devices (id, name) VALUES (?, ?)').run(id, id);
    const token = crypto.randomBytes(16).toString('hex');
    db.prepare('INSERT INTO sessions (token, device_id, expires_at) VALUES (?, ?, ?)').run(token, id, expiresAt);
    return token;
  }

  const ticket = (purpose: 'signaling' | 'admin' | 'relay', subject = 'admin', deviceId?: string) =>
    wsTicketStore.issue({ purpose, subject, deviceId }).ticket;

  /** Resolves with the HTTP status when the upgrade is rejected, or 101 when it opens. */
  function tryConnect(path: string, headers: Record<string, string> = {}): Promise<{ status: number; ws?: WebSocket }> {
    return new Promise((resolve) => {
      const ws = new WebSocket(`ws://localhost:${port}${path}`, { headers });
      sockets.push(ws);
      ws.on('open', () => resolve({ status: 101, ws }));
      ws.on('unexpected-response', (_req, res) => {
        resolve({ status: res.statusCode || 0 });
        ws.terminate();
      });
      ws.on('error', () => resolve({ status: 0 }));
    });
  }

  async function open(path: string, headers: Record<string, string> = {}): Promise<WebSocket> {
    const r = await tryConnect(path, headers);
    if (!r.ws) throw new Error(`upgrade rejected: ${r.status}`);
    return r.ws;
  }

  const controller = (deviceId?: string, subject = 'admin') =>
    open(`/ws?ticket=${ticket('signaling', subject, deviceId)}`);
  const deviceSocket = (token: string) => open('/ws', { Authorization: `Bearer ${token}` });

  function inbox(ws: WebSocket): Array<Record<string, unknown>> {
    const msgs: Array<Record<string, unknown>> = [];
    ws.on('message', (d, isBinary) => {
      if (!isBinary) msgs.push(JSON.parse(d.toString()));
    });
    return msgs;
  }
  const join = (ws: WebSocket, deviceId: string, role?: string) =>
    ws.send(JSON.stringify({ type: 'join', deviceId, role }));

  beforeAll(() => {
    db = setupTestDatabase();
  });
  afterAll(() => closeTestDatabase());

  async function start(env: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(env)) process.env[k] = v;
    clearRooms();
    sockets = [];
    server = createServer();
    setupSignaling(server, { db });
    await new Promise<void>((r) => server.listen(0, r));
    const addr = server.address();
    port = typeof addr === 'object' && addr ? addr.port : 0;
  }

  const envKeys = ['WS_PING_INTERVAL_MS', 'RELAY_AUTH_TIMEOUT_MS', 'RELAY_MAX_VIEWERS_PER_DEVICE', 'WS_MAX_ADMIN_CONNECTIONS'];

  afterEach(async () => {
    for (const ws of sockets) ws.terminate();
    sockets = [];
    shutdownRelay();
    await new Promise<void>((r) => server.close(() => r()));
    // ws emits 'close' (and the server logs it) one tick after net reports the connection gone: let that finish
    // inside the test, not after jest has torn the environment down.
    await new Promise<void>((r) => setImmediate(() => setImmediate(r)));
    agentConnectionStore.getConnectedDeviceIds().forEach((id) => agentConnectionStore.removeAgent(id));
    envKeys.forEach((k) => delete process.env[k]);
    cleanupTestDatabase();
  });

  describe('/admin', () => {
    beforeEach(() => start());

    it('rejects anonymous upgrades with 401', async () => {
      expect((await tryConnect('/admin')).status).toBe(401);
    });

    it('rejects a garbage ticket and a ticket of the wrong purpose', async () => {
      expect((await tryConnect('/admin?ticket=nope')).status).toBe(401);
      expect((await tryConnect(`/admin?ticket=${ticket('signaling')}`)).status).toBe(401);
    });

    it('accepts an admin ticket once; reuse is rejected', async () => {
      const t = ticket('admin');
      const ws = await open(`/admin?ticket=${t}`);
      expect(ws.readyState).toBe(WebSocket.OPEN);
      expect((await tryConnect(`/admin?ticket=${t}`)).status).toBe(401);
    });

    it('rejects a JWT in the query string', async () => {
      expect((await tryConnect('/admin?token=abc.def.ghi')).status).toBe(401);
    });
  });

  describe('/ws', () => {
    beforeEach(() => start());

    it('rejects anonymous upgrades with 401', async () => {
      expect((await tryConnect('/ws')).status).toBe(401);
    });

    it('rejects an unknown device token and an expired device token', async () => {
      expect((await tryConnect('/ws', { Authorization: 'Bearer deadbeef' })).status).toBe(401);
      const expired = addDevice('dev-exp', Date.now() - 1000);
      expect((await tryConnect('/ws', { Authorization: `Bearer ${expired}` })).status).toBe(401);
    });

    it('a device token for A cannot join room B', async () => {
      const tokenA = addDevice('dev-a');
      addDevice('dev-b');
      const ws = await deviceSocket(tokenA);
      const msgs = inbox(ws);
      join(ws, 'dev-b');
      await wait(60);
      expect(msgs).toEqual([expect.objectContaining({ type: 'error' })]);
      expect(getRoomCount()).toBe(0);
    });

    it('a controller ticket bound to A cannot join room B but can join A', async () => {
      const ws = await controller('dev-a');
      const msgs = inbox(ws);
      join(ws, 'dev-b');
      await wait(60);
      expect(msgs).toEqual([expect.objectContaining({ type: 'error' })]);
      expect(getRoomCount()).toBe(0);
      join(ws, 'dev-a');
      await wait(60);
      expect(getRoomCount()).toBe(1);
    });

    it('takes the role from the credential, not from the message', async () => {
      const token = addDevice('dev-r');
      const dev = await deviceSocket(token);
      const devMsgs = inbox(dev);
      join(dev, 'dev-r', 'controller'); // lies about its role
      await wait(40);
      const ctl = await controller();
      const ctlMsgs = inbox(ctl);
      join(ctl, 'dev-r', 'device'); // lies about its role
      await wait(60);
      expect(devMsgs).toContainEqual({ type: 'peer-joined', role: 'controller' });
      expect(ctlMsgs).toContainEqual({ type: 'peer-joined', role: 'device' });
    });

    it('a second controller with another subject cannot evict the first', async () => {
      const first = await controller(undefined, 'alice');
      const firstMsgs = inbox(first);
      join(first, 'dev-x');
      await wait(40);
      const intruder = await controller(undefined, 'mallory');
      const intruderMsgs = inbox(intruder);
      join(intruder, 'dev-x');
      await wait(60);
      expect(intruderMsgs).toEqual([{ type: 'error', message: 'Role controller already taken in this room' }]);
      expect(first.readyState).toBe(WebSocket.OPEN);
      expect(firstMsgs.filter((m) => m.type === 'peer-left')).toEqual([]);
    });

    it('same-principal replacement works and sends no spurious peer-left', async () => {
      const token = addDevice('dev-s');
      const ctl = await controller();
      const ctlMsgs = inbox(ctl);
      join(ctl, 'dev-s');
      const old = await deviceSocket(token);
      const oldClosed = new Promise<void>((r) => old.on('close', () => r()));
      join(old, 'dev-s');
      await wait(60);
      const fresh = await deviceSocket(token);
      const freshMsgs = inbox(fresh);
      join(fresh, 'dev-s');
      await oldClosed;
      await wait(100);
      expect(ctlMsgs.filter((m) => m.type === 'peer-left')).toEqual([]);
      expect(ctlMsgs.filter((m) => m.type === 'peer-joined').length).toBe(2);
      // the new socket is the live one: it receives an offer from the controller
      ctl.send(JSON.stringify({ type: 'offer', sdp: 'x' }));
      await wait(60);
      expect(freshMsgs).toContainEqual({ type: 'offer', sdp: 'x' });
    });

    it('rejects a second join on the same socket', async () => {
      const ws = await controller();
      const msgs = inbox(ws);
      join(ws, 'dev-1');
      await wait(30);
      join(ws, 'dev-2');
      await wait(60);
      expect(msgs).toEqual([expect.objectContaining({ type: 'error' })]);
      expect(getRoomCount()).toBe(1);
    });
  });

  describe('/relay', () => {
    beforeEach(() => start());

    async function connectAgent(token: string): Promise<{ ws: WebSocket; ok: boolean }> {
      const ws = await open('/relay');
      const reply = new Promise<boolean>((resolve) => {
        ws.on('message', (d: Buffer) => {
          if (d[0] === AUTH_RESPONSE) resolve(JSON.parse(d.subarray(HEADER).toString()).success === true);
        });
        ws.on('close', () => resolve(false));
      });
      ws.send(frame(AUTH_REQUEST, 0, { token, agent_version: '1', os: 'linux', arch: 'x', hostname: 'h' }));
      return { ws, ok: await reply };
    }

    it('viewer without a ticket is rejected, also with a legacy token param', async () => {
      const tok = addDevice('dev-v');
      await connectAgent(tok);
      expect((await tryConnect('/relay?deviceId=dev-v&session=desktop')).status).toBe(401);
      expect((await tryConnect(`/relay?deviceId=dev-v&session=desktop&token=${tok}`)).status).toBe(401);
    });

    it('viewer needs a relay ticket bound to that device', async () => {
      const tok = addDevice('dev-v');
      await connectAgent(tok);
      const other = ticket('relay', 'admin', 'dev-other');
      expect((await tryConnect(`/relay?deviceId=dev-v&session=desktop&ticket=${other}`)).status).toBe(401);
      const unbound = ticket('relay', 'admin');
      expect((await tryConnect(`/relay?deviceId=dev-v&session=desktop&ticket=${unbound}`)).status).toBe(401);
      const good = ticket('relay', 'admin', 'dev-v');
      const r = await tryConnect(`/relay?deviceId=dev-v&session=desktop&ticket=${good}`);
      expect(r.status).toBe(101);
      await wait(40);
      expect(agentConnectionStore.getAgent('dev-v')?.activeSessions.size).toBe(1);
    });

    it('caps concurrent viewers per device', async () => {
      process.env.RELAY_MAX_VIEWERS_PER_DEVICE = '2';
      const tok = addDevice('dev-cap');
      await connectAgent(tok);
      const closes: number[] = [];
      for (let i = 0; i < 3; i++) {
        const ws = await open(`/relay?deviceId=dev-cap&session=desktop&ticket=${ticket('relay', 'admin', 'dev-cap')}`);
        ws.on('close', (code) => closes.push(code));
      }
      await wait(80);
      expect(agentConnectionStore.getAgent('dev-cap')?.activeSessions.size).toBe(2);
      expect(closes.length).toBe(1);
    });

    it('rejects an expired agent token and an agent token of nobody', async () => {
      expect((await connectAgent(addDevice('dev-old', Date.now() - 1000))).ok).toBe(false);
      expect((await connectAgent('ffff')).ok).toBe(false);
      expect(agentConnectionStore.isAgentConnected('dev-old')).toBe(false);
    });

    it('authenticates a valid agent', async () => {
      const r = await connectAgent(addDevice('dev-ok'));
      expect(r.ok).toBe(true);
      expect(agentConnectionStore.isAgentConnected('dev-ok')).toBe(true);
    });

    it('the late close of a replaced agent does not remove the new connection (SR-05)', async () => {
      const tok = addDevice('dev-race');
      const first = await connectAgent(tok);
      const firstClosed = new Promise<void>((r) => first.ws.on('close', () => r()));
      const second = await connectAgent(tok);
      expect(second.ok).toBe(true);
      await firstClosed;
      await wait(100);
      expect(agentConnectionStore.isAgentConnected('dev-race')).toBe(true);
      expect(agentConnectionStore.getAgent('dev-race')?.ws).not.toBe(first.ws);
      const status = db.prepare('SELECT status FROM devices WHERE id = ?').get('dev-race') as { status: string };
      expect(status.status).not.toBe('offline');
    });

    it('caps the pre-auth buffer', async () => {
      const ws = await open('/relay');
      const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
      // header promising a 65535 byte payload that never completes
      const head = frame(AUTH_REQUEST, 0, Buffer.alloc(0));
      head.writeUInt16LE(65535, 1);
      ws.send(head);
      for (let i = 0; i < 3; i++) ws.send(Buffer.alloc(30_000));
      expect(await closed).toBe(1009);
    });

    it('keeps the auth timeout after a partial AUTH_REQUEST header', async () => {
      process.env.RELAY_AUTH_TIMEOUT_MS = '150';
      const ws = await open('/relay');
      const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
      const head = frame(AUTH_REQUEST, 0, Buffer.alloc(0));
      head.writeUInt16LE(100, 1); // promises 100 bytes, sends none
      ws.send(head);
      expect(await closed).toBe(4001);
    });
  });

  describe('heartbeat and limits', () => {
    it('terminates /admin peers that miss two pings', async () => {
      await start({ WS_PING_INTERVAL_MS: '40' });
      const admin = new WebSocket(`ws://localhost:${port}/admin?ticket=${ticket('admin')}`, { autoPong: false });
      sockets.push(admin);
      await new Promise<void>((r) => admin.on('open', () => r()));
      const closed = new Promise<void>((r) => admin.on('close', () => r()));
      const t0 = Date.now();
      await closed;
      expect(Date.now() - t0).toBeLessThan(1500);
    });

    it('keeps peers that answer pings', async () => {
      await start({ WS_PING_INTERVAL_MS: '40' });
      const ws = await open(`/admin?ticket=${ticket('admin')}`);
      await wait(300);
      expect(ws.readyState).toBe(WebSocket.OPEN);
    });

    it('caps concurrent /admin connections', async () => {
      await start({ WS_MAX_ADMIN_CONNECTIONS: '2' });
      await open(`/admin?ticket=${ticket('admin')}`);
      await open(`/admin?ticket=${ticket('admin')}`);
      expect((await tryConnect(`/admin?ticket=${ticket('admin')}`)).status).toBe(503);
    });
  });

  describe('backpressure', () => {
    function fakeWs(buffered: number) {
      return { readyState: WebSocket.OPEN, bufferedAmount: buffered, send: jest.fn(), close: jest.fn() } as unknown as WebSocket;
    }
    it('sends when the buffer is small', () => {
      const ws = fakeWs(0);
      sendWithBackpressure(ws, frame(DESKTOP_FRAME, 1));
      expect(ws.send).toHaveBeenCalledTimes(1);
    });
    it('drops video frames when the buffer is over the limit', () => {
      const ws = fakeWs(9 * 1024 * 1024);
      sendWithBackpressure(ws, frame(DESKTOP_FRAME, 1));
      expect(ws.send).not.toHaveBeenCalled();
      expect(ws.close).not.toHaveBeenCalled();
    });
    it('closes the socket when non-video data piles up', () => {
      const ws = fakeWs(9 * 1024 * 1024);
      sendWithBackpressure(ws, frame(0x22, 1));
      expect(ws.send).not.toHaveBeenCalled();
      expect(ws.close).toHaveBeenCalledWith(1013, expect.any(String));
    });
  });
});
