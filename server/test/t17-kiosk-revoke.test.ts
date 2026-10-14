import { createServer, Server } from 'http';
import request from 'supertest';
import WebSocket from 'ws';
import Database from 'better-sqlite3';
import { app, resetRateLimiters } from '../src/app';
import { setupSignaling, clearRooms } from '../src/signaling';
import { shutdownRelay } from '../src/relay';
import { agentConnectionStore } from '../src/services/agentConnectionStore';
import { deviceStore } from '../src/services/deviceStore';
import { policyStore } from '../src/services/policyStore';
import { wsTicketStore } from '../src/services/wsTicketStore';
import {
  setupTestDatabase, cleanupTestDatabase, closeTestDatabase, adminAuthHeader, deviceTokenFor,
} from './setup';

let db: Database.Database;
const cmds = (deviceId: string, type: string) =>
  db.prepare('SELECT * FROM device_commands WHERE device_id = ? AND type = ? ORDER BY created_at, rowid').all(deviceId, type) as Array<Record<string, any>>;
const payloadOf = (r: Record<string, any>) => JSON.parse(r.payload);

describe('T17 policy kiosk becomes SET_KIOSK', () => {
  beforeAll(() => { db = setupTestDatabase(); });
  afterAll(() => closeTestDatabase());
  beforeEach(() => { cleanupTestDatabase(); resetRateLimiters(); });

  const assign = (id: string, policyId: string | null) =>
    request(app).put(`/api/devices/${id}/policy`).set('Authorization', adminAuthHeader()).send({ policyId });

  it('assigning a kiosk policy queues SET_KIOSK enabled with lockTask true', async () => {
    deviceStore.enrollDevice({ id: 'k1', name: 'k1', model: 'm' });
    const p = policyStore.createPolicy({ name: 'kiosk', kioskMode: true, kioskPackage: 'com.shop.app' });
    expect((await assign('k1', p.id)).status).toBe(200);
    const rows = cmds('k1', 'SET_KIOSK');
    expect(rows).toHaveLength(1);
    expect(payloadOf(rows[0])).toEqual({ packageName: 'com.shop.app', enabled: true, lockTask: true });
  });

  it('a second assignment supersedes the older pending SET_KIOSK', async () => {
    deviceStore.enrollDevice({ id: 'k2', name: 'k2', model: 'm' });
    const p = policyStore.createPolicy({ name: 'kiosk', kioskMode: true, kioskPackage: 'com.shop.app' });
    await assign('k2', p.id);
    await assign('k2', p.id);
    const rows = cmds('k2', 'SET_KIOSK');
    expect(rows.filter((r) => r.status === 'pending')).toHaveLength(1);
    expect(rows.filter((r) => r.error === 'superseded')).toHaveLength(1);
  });

  it('editing the policy to turn kiosk off queues enabled:false for its devices', async () => {
    deviceStore.enrollDevice({ id: 'k3', name: 'k3', model: 'm' });
    const p = policyStore.createPolicy({ name: 'kiosk', kioskMode: true, kioskPackage: 'com.shop.app' });
    await assign('k3', p.id);
    const r = await request(app).put(`/api/policies/${p.id}`).set('Authorization', adminAuthHeader()).send({ kioskMode: false });
    expect(r.status).toBe(200);
    const pending = cmds('k3', 'SET_KIOSK').filter((c) => c.status === 'pending');
    expect(pending).toHaveLength(1);
    expect(payloadOf(pending[0])).toEqual({ packageName: 'com.shop.app', enabled: false, lockTask: true });
  });

  it('changing only the kiosk package re-queues SET_KIOSK', async () => {
    deviceStore.enrollDevice({ id: 'k4', name: 'k4', model: 'm' });
    const p = policyStore.createPolicy({ name: 'kiosk', kioskMode: true, kioskPackage: 'com.a.app' });
    await assign('k4', p.id);
    await request(app).put(`/api/policies/${p.id}`).set('Authorization', adminAuthHeader()).send({ kioskPackage: 'com.b.app' });
    const pending = cmds('k4', 'SET_KIOSK').filter((c) => c.status === 'pending');
    expect(pending).toHaveLength(1);
    expect(payloadOf(pending[0]).packageName).toBe('com.b.app');
  });

  it('a policy without kiosk queues no SET_KIOSK', async () => {
    deviceStore.enrollDevice({ id: 'k5', name: 'k5', model: 'm' });
    const p = policyStore.createPolicy({ name: 'plain' });
    await assign('k5', p.id);
    expect(cmds('k5', 'SET_KIOSK')).toHaveLength(0);
  });
});

describe('T17 unenroll revokes live authority', () => {
  let server: Server;
  let port: number;
  const sockets: WebSocket[] = [];

  beforeAll(async () => {
    db = setupTestDatabase();
    server = createServer(app);
    setupSignaling(server, { db });
    await new Promise<void>((r) => server.listen(0, r));
    const a = server.address();
    port = typeof a === 'object' && a ? a.port : 0;
  });
  afterAll(async () => {
    for (const ws of sockets) ws.terminate();
    shutdownRelay();
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => setImmediate(() => setImmediate(r)));
    closeTestDatabase();
  });
  beforeEach(() => { cleanupTestDatabase(); resetRateLimiters(); clearRooms(); });

  function open(path: string, headers: Record<string, string> = {}): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${port}${path}`, { headers });
      sockets.push(ws);
      ws.on('open', () => resolve(ws));
      ws.on('error', reject);
      ws.on('unexpected-response', (_q, res) => reject(new Error(`status ${res.statusCode}`)));
    });
  }
  const closed = (ws: WebSocket) =>
    new Promise<boolean>((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) return resolve(true);
      ws.on('close', () => resolve(true));
      setTimeout(() => resolve(false), 1500);
    });

  it('DELETE closes the device /ws socket, the relay agent and its viewers, and the token stops working', async () => {
    deviceStore.enrollDevice({ id: 'gone', name: 'gone', model: 'm' });
    const token = deviceTokenFor('gone');

    const dev = await open('/ws', { Authorization: `Bearer ${token}` });
    dev.send(JSON.stringify({ type: 'join', deviceId: 'gone' }));

    const agent = await open('/relay');
    const authed = new Promise<void>((resolve) => agent.on('message', () => resolve()));
    const body = Buffer.from(JSON.stringify({ token, agent_version: '1', os: 'linux', arch: 'x', hostname: 'h' }));
    const hdr = Buffer.alloc(9);
    hdr.writeUInt8(0x01, 0); hdr.writeUInt16LE(body.length, 1);
    agent.send(Buffer.concat([hdr, body]));
    await authed;
    expect(agentConnectionStore.isAgentConnected('gone')).toBe(true);

    const t = wsTicketStore.issue({ purpose: 'relay', subject: 'admin', deviceId: 'gone' }).ticket;
    const viewer = await open(`/relay?deviceId=gone&session=desktop&ticket=${t}`);

    const res = await request(app).delete('/api/devices/gone').set('Authorization', adminAuthHeader());
    expect(res.status).toBe(200);

    expect(await closed(dev)).toBe(true);
    expect(await closed(agent)).toBe(true);
    expect(await closed(viewer)).toBe(true);
    expect(agentConnectionStore.getAgent('gone')).toBeUndefined();
    expect(deviceStore.getDeviceIdForSession(token)).toBeNull();
    const poll = await request(app).get('/api/devices/gone/commands/pending').set('X-Session-Token', token);
    expect([401, 403, 404]).toContain(poll.status);
  });
});
