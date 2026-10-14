import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import crypto from 'crypto';
import { createServer, Server } from 'http';
import request from 'supertest';
import WebSocket from 'ws';
import { useTempUploadsDir, writeFakeApk } from './t6-helpers';

const uploadsDir = useTempUploadsDir();
process.env.PUBLIC_BASE_URL = 'https://mdm.example.com';
const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 't11-bin-'));
const instDir = fs.mkdtempSync(path.join(os.tmpdir(), 't11-inst-'));
process.env.AGENT_BINARIES_DIR = binDir;
process.env.INSTALLERS_DIR = instDir;

import { app, resetRateLimiters } from '../src/app';
import { setupSignaling, clearRooms } from '../src/signaling';
import { shutdownRelay } from '../src/relay';
import { deviceStore } from '../src/services/deviceStore';
import { commandStore } from '../src/services/commandStore';
import { eventStore } from '../src/services/eventStore';
import { enrollmentStore } from '../src/services/enrollmentStore';
import { wsTicketStore } from '../src/services/wsTicketStore';
import * as appPackageStore from '../src/services/appPackageStore';
import { setStorageProvider, LocalStorageProvider } from '../src/services/storageProvider';
import { setupTestDatabase, cleanupTestDatabase, closeTestDatabase, adminAuthHeader, deviceTokenFor } from './setup';

let db: ReturnType<typeof setupTestDatabase>;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't11-src-'));
const admin = () => adminAuthHeader();

beforeAll(() => {
  db = setupTestDatabase();
  appPackageStore.setDatabase(db);
  setStorageProvider(new LocalStorageProvider(uploadsDir, '/api/uploads'));
});
afterAll(() => { appPackageStore.setDatabase(null); closeTestDatabase(); });
beforeEach(() => { cleanupTestDatabase(); resetRateLimiters(); delete process.env.AGENT_PACKAGE_NAME; });

async function uploadApk(packageName: string, file: string) {
  return request(app).post('/api/apps/upload').set('Authorization', admin())
    .field('packageName', packageName).attach('file', file, { filename: 'app.apk' });
}

describe('QR provisioning: public, narrow agent APK download', () => {
  let agentApk: string;
  let otherApk: string;
  beforeAll(() => {
    agentApk = path.join(tmpDir, 'agent.apk');
    otherApk = path.join(tmpDir, 'other.apk');
    writeFakeApk(agentApk, { padBytes: 4096 });
    writeFakeApk(otherApk, { padBytes: 1000 });
  });

  it('is 404 until the agent APK has been uploaded', async () => {
    expect((await request(app).get('/api/provisioning/agent.apk')).status).toBe(404);
  });

  it('serves exactly the agent APK without any credential', async () => {
    const up = await uploadApk('com.androidremote.app', agentApk);
    expect(up.status).toBe(201);
    const r = await request(app).get('/api/provisioning/agent.apk').buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('application/vnd.android.package-archive');
    expect(Buffer.compare(r.body, fs.readFileSync(agentApk))).toBe(0);
  });

  it('does not serve any other package, and the generic upload route stays authenticated', async () => {
    const agent = await uploadApk('com.androidremote.app', agentApk);
    const other = await uploadApk('com.example.other', otherApk);
    const otherUrl = new URL(other.body.downloadUrl, 'https://x').pathname;
    const agentUrl = new URL(agent.body.downloadUrl, 'https://x').pathname;
    expect((await request(app).get(otherUrl)).status).toBe(401);
    expect((await request(app).get(agentUrl)).status).toBe(401);
    // Query tricks do not select another package.
    const r = await request(app).get('/api/provisioning/agent.apk?packageName=com.example.other&file=../x').buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(Buffer.compare(r.body, fs.readFileSync(agentApk))).toBe(0);
    expect((await request(app).get('/api/provisioning/other.apk')).status).toBe(401);
    expect((await request(app).get('/api/provisioning/agent.apk/extra')).status).toBe(401);
  });

  it('AGENT_PACKAGE_NAME selects another package', async () => {
    await uploadApk('com.example.other', otherApk);
    process.env.AGENT_PACKAGE_NAME = 'com.example.other';
    const r = await request(app).get('/api/provisioning/agent.apk');
    expect(r.status).toBe(200);
  });

  it('info (admin) returns the QR data with the base64url checksum and the public URL', async () => {
    expect((await request(app).get('/api/provisioning/info')).status).toBe(401);
    expect((await request(app).get('/api/provisioning/info').set('X-Session-Token', 'nope')).status).toBe(401);
    const up = await uploadApk('com.androidremote.app', agentApk);
    const r = await request(app).get('/api/provisioning/info').set('Authorization', admin());
    expect(r.status).toBe(200);
    const hex = crypto.createHash('sha256').update(fs.readFileSync(agentApk)).digest('hex');
    expect(up.body.sha256).toBe(hex);
    expect(r.body).toMatchObject({
      available: true,
      packageName: 'com.androidremote.app',
      sha256: hex,
      checksum: Buffer.from(hex, 'hex').toString('base64url'),
      downloadUrl: 'https://mdm.example.com/api/provisioning/agent.apk',
    });
    expect(r.body.checksum).not.toMatch(/[+/=]/);
    expect(r.body.qrPayload['android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION'])
      .toBe('https://mdm.example.com/api/provisioning/agent.apk');
    expect(r.body.qrPayload['android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_CHECKSUM']).toBe(r.body.checksum);
  });

  it('info without an uploaded agent says so', async () => {
    const r = await request(app).get('/api/provisioning/info').set('Authorization', admin());
    expect(r.body).toMatchObject({ available: false, checksum: null });
  });
});

describe('list endpoints: total, paging, search', () => {
  it('/api/devices returns total and summary, supports limit, offset and search', async () => {
    for (let i = 0; i < 5; i++) deviceStore.enrollDevice({ id: `d${i}`, name: i === 3 ? 'Lobby Tablet' : `Phone ${i}`, model: 'm' });
    deviceStore.updateLastSeen('d0');
    const all = await request(app).get('/api/devices').set('Authorization', admin());
    expect(all.body.devices).toHaveLength(5);
    expect(all.body.total).toBe(5);
    expect(all.body.summary).toEqual({ online: 1, offline: 4 });

    const page = await request(app).get('/api/devices?limit=2&offset=1').set('Authorization', admin());
    expect(page.body.devices).toHaveLength(2);
    expect(page.body.total).toBe(5);

    const found = await request(app).get('/api/devices?search=lobby').set('Authorization', admin());
    expect(found.body.devices.map((d: any) => d.id)).toEqual(['d3']);
    expect(found.body.total).toBe(1);
    expect(found.body.summary.online + found.body.summary.offline).toBe(5);
  });

  it('/api/events and /api/audit return total next to count', async () => {
    deviceStore.enrollDevice({ id: 'd1', name: 'd1', model: 'm' });
    for (let i = 0; i < 7; i++) eventStore.recordEvent({ deviceId: 'd1', eventType: 'battery-low', severity: 'warning' });
    const ev = await request(app).get('/api/events?limit=3').set('Authorization', admin());
    expect(ev.body.events).toHaveLength(3);
    expect(ev.body.total).toBe(7);
    const one = await request(app).get('/api/events?deviceId=d1&limit=2&severity=warning').set('Authorization', admin());
    expect(one.body.total).toBe(7);
    expect((await request(app).get('/api/events?severity=critical').set('Authorization', admin())).body.total).toBe(0);

    const ins = db.prepare("INSERT INTO audit_logs (id, timestamp, actor_type, action, resource_type) VALUES (?, ?, 'admin', 'command.queued', 'command')");
    for (let i = 0; i < 6; i++) ins.run(`a${i}`, Date.now() + i);
    const au = await request(app).get('/api/audit?limit=2').set('Authorization', admin());
    expect(au.body.logs).toHaveLength(2);
    expect(au.body.total).toBe(6);
  });

  it('GET /api/enroll/tokens/:token looks one token up by value', async () => {
    const t = enrollmentStore.createToken({ maxUses: 1 });
    const r = await request(app).get(`/api/enroll/tokens/${t.token}`).set('Authorization', admin());
    expect(r.status).toBe(200);
    expect(r.body.token).toBe(t.token);
    expect((await request(app).get('/api/enroll/tokens/nope').set('Authorization', admin())).status).toBe(404);
    expect((await request(app).get(`/api/enroll/tokens/${t.token}`)).status).toBe(401);
  });

  it('telemetry history accepts the 1m / 15m / 1h / 6h buckets the UI sends', async () => {
    deviceStore.enrollDevice({ id: 'd1', name: 'd1', model: 'm' });
    for (const b of ['1m', '15m', '1h', '6h']) {
      const r = await request(app).get(`/api/devices/d1/telemetry/history?bucket=${b}&limit=500`).set('Authorization', admin());
      expect(r.status).toBe(200);
      expect(r.body.bucket).toBe(b);
    }
  });
});

describe('admin socket: command-update on every command state change', () => {
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

  it('pushes queued, delivered, executing and completed states', async () => {
    deviceStore.enrollDevice({ id: 'd1', name: 'd1', model: 'm' });
    deviceStore.enrollDevice({ id: 'd2', name: 'd2', model: 'm' });
    const token = deviceTokenFor('d1');
    const ticket = wsTicketStore.issue({ purpose: 'admin', subject: 'admin' }).ticket;
    const ws = new WebSocket(`ws://localhost:${port}/admin?ticket=${ticket}`);
    const messages: any[] = [];
    ws.on('message', m => { const d = JSON.parse(String(m)); if (d.type === 'command-update') messages.push(d); });
    await new Promise<void>(r => ws.on('open', () => r()));

    const created = await request(app).post('/api/devices/d1/commands').set('Authorization', admin()).send({ type: 'LOCK' });
    await request(app).post('/api/devices/d2/commands').set('Authorization', admin()).send({ type: 'LOCK' });
    await request(app).get('/api/devices/d1/commands/pending').set('X-Session-Token', token);
    await request(app).patch(`/api/devices/d1/commands/${created.body.id}`).set('X-Session-Token', token).send({ status: 'executing' });
    await request(app).patch(`/api/devices/d1/commands/${created.body.id}`).set('X-Session-Token', token).send({ status: 'completed' });
    await new Promise(r => setTimeout(r, 150));
    ws.close();

    const mine = messages.filter(m => m.command.id === created.body.id).map(m => m.command.status);
    expect(mine).toEqual(['pending', 'delivered', 'executing', 'completed']);
    expect(messages.every(m => m.deviceId === m.command.deviceId)).toBe(true);
    expect(messages.some(m => m.deviceId === 'd2')).toBe(true); // an unfiltered subscription sees every device
    expect(commandStore.getCommand(created.body.id)!.status).toBe('completed');
  });
});

describe('SR-11 follow-up: agent binary and installer uploads are streamed to disk', () => {
  const big = Buffer.alloc(8 * 1024 * 1024, 5);
  const hex = crypto.createHash('sha256').update(big).digest('hex');
  const leftovers = (dir: string) => {
    const inc = path.join(dir, '.incoming');
    return fs.existsSync(inc) ? fs.readdirSync(inc) : [];
  };

  it('stores an agent binary with its sha256 and leaves no temp file', async () => {
    const r = await request(app).post('/api/agent/upload').set('Authorization', admin())
      .field('os', 'linux').field('arch', 'x64').field('version', '1.2.3')
      .attach('file', big, { filename: 'agent' });
    expect(r.status).toBe(200);
    expect(r.body.binary).toMatchObject({ os: 'linux', arch: 'x64', version: '1.2.3', sha256: hex, size: big.length });
    expect(fs.statSync(path.join(binDir, r.body.binary.filename)).size).toBe(big.length);
    expect(leftovers(binDir)).toEqual([]);
    const latest = await request(app).get('/api/agent/latest?os=linux&arch=x64').set('Authorization', admin());
    expect(latest.body).toMatchObject({ version: '1.2.3', sha256: hex });
  });

  it('refuses bad input and removes the temp file', async () => {
    const base = () => request(app).post('/api/agent/upload').set('Authorization', admin());
    expect((await base().field('os', 'plan9').field('arch', 'x64').field('version', '1.0').attach('file', big, { filename: 'a' })).status).toBe(400);
    expect((await base().field('os', 'linux').field('arch', 'x64').attach('file', big, { filename: 'a' })).status).toBe(400);
    expect((await base().field('os', 'linux').field('arch', 'x64').field('version', '../../evil').attach('file', big, { filename: 'a' })).status).toBe(400);
    expect(leftovers(binDir)).toEqual([]);
    expect(fs.readdirSync(binDir).filter(f => f.includes('evil'))).toEqual([]);
  });

  it('needs the admin token', async () => {
    const r = await request(app).post('/api/agent/upload').field('os', 'linux').field('arch', 'x64').field('version', '1').attach('file', Buffer.from('x'), { filename: 'a' });
    expect(r.status).toBe(401);
  });

  it('stores an installer and serves it with the config trailer', async () => {
    const r = await request(app).post('/api/agent/upload-installer').set('Authorization', admin())
      .field('platform', 'windows').attach('file', big, { filename: 'setup.exe' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ platform: 'windows', size: big.length });
    expect(fs.statSync(path.join(instDir, 'windows-x64.exe')).size).toBe(big.length);
    expect(leftovers(instDir)).toEqual([]);

    const bad = await request(app).post('/api/agent/upload-installer').set('Authorization', admin())
      .field('platform', 'amiga').attach('file', big, { filename: 'setup.exe' });
    expect(bad.status).toBe(400);
    expect(leftovers(instDir)).toEqual([]);
  });
});
