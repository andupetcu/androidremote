import request from 'supertest';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { app, resetRateLimiters } from '../src/app';
import { setupTestDatabase, cleanupTestDatabase, closeTestDatabase, adminAuthHeader } from './setup';
import { commandStore } from '../src/services/commandStore';
import { telemetryStore } from '../src/services/telemetryStore';
import { auditStore } from '../src/services/auditStore';
import { fileTransferStore } from '../src/services/fileTransferStore';
import { wsTicketStore } from '../src/services/wsTicketStore';
import { policyStore } from '../src/services/policyStore';
import { deviceStore } from '../src/services/deviceStore';
import { setAuthDatabase, ensureInitialAdminPassword } from '../src/middleware/auth';

let db: ReturnType<typeof setupTestDatabase>;

beforeAll(() => {
  db = setupTestDatabase();
  setAuthDatabase(db);
});
afterAll(() => closeTestDatabase());
beforeEach(() => {
  cleanupTestDatabase();
  db.prepare("DELETE FROM settings WHERE key = 'adminPasswordHash'").run();
  resetRateLimiters();
  delete process.env.ALLOW_TOKENLESS_DEVICES;
  delete process.env.ADMIN_PASSWORD_HASH;
  delete process.env.ADMIN_INITIAL_PASSWORD;
});

const admin = () => adminAuthHeader();

function call(method: string, url: string, token?: string, body?: object) {
  let t = (request(app) as any)[method.toLowerCase()](url);
  if (token) t = t.set('X-Session-Token', token);
  return method === 'POST' ? t.send(body ?? {}) : t;
}

async function enroll(name = 'Phone'): Promise<{ id: string; token: string }> {
  const t = await request(app).post('/api/enroll/tokens').set('Authorization', admin()).send({ maxUses: 10 });
  const r = await request(app).post('/api/enroll/device').send({ token: t.body.token, deviceName: name });
  expect(r.status).toBe(201);
  return { id: r.body.deviceId, token: r.body.sessionToken };
}

describe('SS-01 / WU-01: enrollment token admin routes', () => {
  it('anonymous callers cannot mint, list or revoke tokens', async () => {
    expect((await request(app).post('/api/enroll/tokens').send({ maxUses: 1000 })).status).toBe(401);
    expect((await request(app).get('/api/enroll/tokens')).status).toBe(401);
    expect((await request(app).delete('/api/enroll/tokens/abc')).status).toBe(401);
  });

  it('admin can mint and list tokens; redemption stays public', async () => {
    const created = await request(app).post('/api/enroll/tokens').set('Authorization', admin()).send({});
    expect(created.status).toBe(201);
    const list = await request(app).get('/api/enroll/tokens').set('Authorization', admin());
    expect(list.status).toBe(200);
    const redeem = await request(app).post('/api/enroll/device').send({ token: created.body.token, deviceName: 'X' });
    expect(redeem.status).toBe(201);
  });

  it('writes audit entries for token create and revoke', async () => {
    const created = await request(app).post('/api/enroll/tokens').set('Authorization', admin()).send({});
    await request(app).delete(`/api/enroll/tokens/${created.body.id}`).set('Authorization', admin());
    const actions = auditStore.getRecentLogs().map(l => l.action);
    expect(actions).toEqual(expect.arrayContaining(['token.created', 'token.revoked']));
  });
});

describe('SS-04: pairing', () => {
  it('anonymous /pair/complete is rejected and issues no session token', async () => {
    const init = await request(app).post('/api/pair/initiate').send({ deviceName: 'p' });
    const done = await request(app).post('/api/pair/complete')
      .send({ pairingCode: init.body.pairingCode, controllerPublicKey: 'k' });
    expect(done.status).toBe(401);
    const status = await request(app).get(`/api/pair/status/${init.body.deviceId}`);
    expect(status.body.status).toBe('pending');
    expect(status.body.sessionToken).toBeUndefined();
  });

  it('admin completes pairing and the device then receives its token', async () => {
    const init = await request(app).post('/api/pair/initiate').send({ deviceName: 'p' });
    const done = await request(app).post('/api/pair/complete').set('Authorization', admin())
      .send({ pairingCode: init.body.pairingCode, controllerPublicKey: 'k' });
    expect(done.status).toBe(200);
    const status = await request(app).get(`/api/pair/status/${init.body.deviceId}`);
    expect(status.body.status).toBe('completed');
    expect(status.body.sessionToken).toBe(done.body.sessionToken);
  });

  it('uses crypto.randomInt, not Math.random, for the code', async () => {
    const ri = jest.spyOn(crypto, 'randomInt');
    const mr = jest.spyOn(Math, 'random');
    const r = await request(app).post('/api/pair/initiate').send({ deviceName: 'p' });
    expect(r.body.pairingCode).toMatch(/^\d{6}$/);
    expect(ri).toHaveBeenCalled();
    expect(mr).not.toHaveBeenCalled();
    ri.mockRestore();
    mr.mockRestore();
  });
});

describe('SS-06 / AM-01 (C1): device routes need the session token', () => {
  const routes: Array<[string, string, (id: string) => string, object]> = [
    ['POST', 'heartbeat', id => `/api/devices/${id}/heartbeat`, {}],
    ['GET', 'poll', id => `/api/devices/${id}/commands/pending`, {}],
    ['POST', 'telemetry', id => `/api/devices/${id}/telemetry`, { battery_level: 50 }],
    ['POST', 'apps', id => `/api/devices/${id}/apps`, { apps: [] }],
    ['POST', 'events', id => `/api/devices/${id}/events`, { eventType: 'device-online', severity: 'info' }],
    ['GET', 'app-updates', id => `/api/devices/${id}/app-updates`, {}],
    ['GET', 'policy', id => `/api/devices/${id}/policy`, {}],
  ];

  it.each(routes)('%s %s without a token is 401', async (method, _n, url, body) => {
    const { id } = await enroll();
    const r = await call(method, url(id), undefined, body);
    expect(r.status).toBe(401);
  });

  it.each(routes)('%s %s with the right token is accepted', async (method, _n, url, body) => {
    const { id, token } = await enroll();
    const r = await call(method, url(id), token, body);
    expect(r.status).toBeLessThan(300);
  });

  it('accepts the token as Bearer too', async () => {
    const { id, token } = await enroll();
    const r = await request(app).get(`/api/devices/${id}/commands/pending`).set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
  });

  it('token of device A does not work on device B', async () => {
    const a = await enroll('A');
    const b = await enroll('B');
    commandStore.queueCommand(b.id, 'LOCK', {});
    const r = await request(app).get(`/api/devices/${b.id}/commands/pending`).set('X-Session-Token', a.token);
    expect(r.status).toBe(401);
    expect(commandStore.getCommandHistory(b.id)[0].status).toBe('pending');
  });

  it('an expired token is 401', async () => {
    const { id, token } = await enroll();
    db.prepare('UPDATE sessions SET expires_at = ? WHERE token = ?').run(Date.now() - 1000, token);
    const r = await request(app).get(`/api/devices/${id}/commands/pending`).set('X-Session-Token', token);
    expect(r.status).toBe(401);
  });

  it('a device token cannot use admin device routes', async () => {
    const { id, token } = await enroll();
    const h = { 'X-Session-Token': token };
    expect((await request(app).post(`/api/devices/${id}/commands`).set(h).send({ type: 'LOCK' })).status).toBe(401);
    expect((await request(app).get(`/api/devices/${id}/commands`).set(h)).status).toBe(401);
    expect((await request(app).get(`/api/devices`).set(h)).status).toBe(401);
    expect((await request(app).get(`/api/devices/${id}/telemetry`).set(h)).status).toBe(401);
    expect((await request(app).delete(`/api/devices/${id}`).set(h)).status).toBe(401);
  });

  it('matches routes exactly, not by substring', async () => {
    const { id, token } = await enroll();
    // The old gate treated any PATCH/POST path containing "/apps" or "/events" as device-facing.
    const r = await request(app).post(`/api/devices/${id}/apps/extra`).set('X-Session-Token', token).send({});
    expect(r.status).not.toBe(200);
    const r2 = await request(app).get(`/api/devices/${id}/events`).set('X-Session-Token', token);
    expect(r2.status).toBe(401);
  });

  it('ALLOW_TOKENLESS_DEVICES=true lets tokenless polls through with a warning', async () => {
    const { id } = await enroll();
    process.env.ALLOW_TOKENLESS_DEVICES = 'true';
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await request(app).get(`/api/devices/${id}/commands/pending`);
    expect(r.status).toBe(200);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    // a present-but-wrong token is still rejected
    const bad = await request(app).get(`/api/devices/${id}/commands/pending`).set('X-Session-Token', 'nope');
    expect(bad.status).toBe(401);
  });

  it('device-facing routes do not exist for admin callers on file callback without token', async () => {
    const { id } = await enroll();
    const t = fileTransferStore.createTransfer({ deviceId: id, direction: 'download', devicePath: '/x' });
    expect((await request(app).patch(`/api/files/${t.id}`).send({ status: 'completed' })).status).toBe(401);
  });

  it('file callback works with the owning device token and not with another device token', async () => {
    const a = await enroll('A');
    const b = await enroll('B');
    const t = fileTransferStore.createTransfer({ deviceId: a.id, direction: 'download', devicePath: '/x' });
    expect((await request(app).patch(`/api/files/${t.id}`).set('X-Session-Token', b.token).send({ progress: 10 })).status).toBe(401);
    expect((await request(app).patch(`/api/files/${t.id}`).set('X-Session-Token', a.token).send({ progress: 10 })).status).toBe(200);
  });
});

describe('SR-01 / SS-13 / AM-02: command ack', () => {
  it('accepts the ack with the device token', async () => {
    const { id, token } = await enroll();
    const cmd = commandStore.queueCommand(id, 'LOCK', {});
    const r = await request(app).patch(`/api/devices/${id}/commands/${cmd.id}`)
      .set('X-Session-Token', token).send({ status: 'executing' });
    expect(r.status).toBe(200);
    const done = await request(app).patch(`/api/devices/${id}/commands/${cmd.id}`)
      .set('X-Session-Token', token).send({ status: 'completed' });
    expect(done.status).toBe(200);
    expect(commandStore.getCommand(cmd.id)!.status).toBe('completed');
  });

  it('accepts an admin JWT too, rejects anonymous and wrong device', async () => {
    const a = await enroll('A');
    const b = await enroll('B');
    const cmd = commandStore.queueCommand(a.id, 'LOCK', {});
    const url = `/api/devices/${a.id}/commands/${cmd.id}`;
    expect((await request(app).patch(url).send({ status: 'executing' })).status).toBe(401);
    expect((await request(app).patch(url).set('X-Session-Token', b.token).send({ status: 'executing' })).status).toBe(401);
    expect((await request(app).patch(url).set('Authorization', admin()).send({ status: 'executing' })).status).toBe(200);
  });

  it('repeating the executing ack is idempotent', async () => {
    const { id, token } = await enroll();
    const cmd = commandStore.queueCommand(id, 'LOCK', {});
    const url = `/api/devices/${id}/commands/${cmd.id}`;
    await request(app).patch(url).set('X-Session-Token', token).send({ status: 'executing' });
    expect((await request(app).patch(url).set('X-Session-Token', token).send({ status: 'executing' })).status).toBe(200);
  });

  it('404 for an unknown command', async () => {
    const { id, token } = await enroll();
    const r = await request(app).patch(`/api/devices/${id}/commands/nope`).set('X-Session-Token', token).send({ status: 'completed' });
    expect(r.status).toBe(404);
  });

  it('404 for a command that belongs to another device', async () => {
    const a = await enroll('A');
    const b = await enroll('B');
    const cmd = commandStore.queueCommand(b.id, 'LOCK', {});
    const r = await request(app).patch(`/api/devices/${a.id}/commands/${cmd.id}`).set('X-Session-Token', a.token).send({ status: 'completed' });
    expect(r.status).toBe(404);
    expect(commandStore.getCommand(cmd.id)!.status).toBe('pending');
  });

  it('409 for a command already completed or failed', async () => {
    const { id, token } = await enroll();
    const cmd = commandStore.queueCommand(id, 'LOCK', {});
    const url = `/api/devices/${id}/commands/${cmd.id}`;
    await request(app).patch(url).set('X-Session-Token', token).send({ status: 'completed' });
    const again = await request(app).patch(url).set('X-Session-Token', token).send({ status: 'failed', error: 'x' });
    expect(again.status).toBe(409);
    expect(commandStore.getCommand(cmd.id)!.status).toBe('completed');
  });

  it('410 for an expired command', async () => {
    const { id, token } = await enroll();
    const cmd = commandStore.queueCommand(id, 'LOCK', {});
    // the schema CHECK has no 'expired' yet (command lifecycle task); relax it for this probe
    db.pragma('ignore_check_constraints = ON');
    db.prepare("UPDATE device_commands SET status = 'expired' WHERE id = ?").run(cmd.id);
    db.pragma('ignore_check_constraints = OFF');
    const r = await request(app).patch(`/api/devices/${id}/commands/${cmd.id}`).set('X-Session-Token', token).send({ status: 'completed' });
    expect(r.status).toBe(410);
  });
});

describe('SS-12 (C2): device id comes from the URL', () => {
  it('a deviceId in the telemetry body does not write another device', async () => {
    const a = await enroll('A');
    const b = await enroll('B');
    const r = await request(app).post(`/api/devices/${a.id}/telemetry`).set('X-Session-Token', a.token)
      .send({ deviceId: b.id, battery_level: 1 });
    expect(r.status).toBe(200);
    expect(telemetryStore.getTelemetry(b.id)).toBeNull();
    expect(telemetryStore.getTelemetry(a.id)).not.toBeNull();
  });
});

describe('SS-07: no default credentials', () => {
  it('admin/admin is rejected when no password is configured', async () => {
    const r = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'admin' });
    expect(r.status).toBe(401);
    expect(r.body.token).toBeUndefined();
    expect(r.body.error).toMatch(/not configured|ADMIN_/i);
  });

  it('logs in with ADMIN_PASSWORD_HASH', async () => {
    process.env.ADMIN_PASSWORD_HASH = await bcrypt.hash('s3cret-pass', 4);
    const r = await request(app).post('/api/auth/login').send({ username: 'admin', password: 's3cret-pass' });
    expect(r.status).toBe(200);
    expect(r.body.token).toBeDefined();
    expect(r.body.mustChangePassword).toBeFalsy();
    expect((await request(app).post('/api/auth/login').send({ username: 'admin', password: 'admin' })).status).toBe(401);
  });

  it('ADMIN_INITIAL_PASSWORD is hashed and stored once, then ignored', async () => {
    process.env.ADMIN_INITIAL_PASSWORD = 'first-password-1';
    expect(await ensureInitialAdminPassword()).toBe(true);
    const stored = db.prepare("SELECT value FROM settings WHERE key = 'adminPasswordHash'").get() as { value: string };
    expect(stored.value).not.toContain('first-password-1');
    expect((await request(app).post('/api/auth/login').send({ username: 'admin', password: 'first-password-1' })).status).toBe(200);

    process.env.ADMIN_INITIAL_PASSWORD = 'other-password-2';
    expect(await ensureInitialAdminPassword()).toBe(false);
    expect((await request(app).post('/api/auth/login').send({ username: 'admin', password: 'other-password-2' })).status).toBe(401);
    expect((await request(app).post('/api/auth/login').send({ username: 'admin', password: 'first-password-1' })).status).toBe(200);
  });

  it('password change does not accept "admin" as the current password when unconfigured', async () => {
    const r = await request(app).put('/api/auth/password').set('Authorization', admin())
      .send({ currentPassword: 'admin', newPassword: 'longenough1' });
    expect(r.status).toBe(401);
  });
});

describe('SS-08: TRUST_PROXY', () => {
  it('keys the login limiter on the forwarded client IP when TRUST_PROXY=1', async () => {
    const saved = process.env.TRUST_PROXY;
    process.env.TRUST_PROXY = '1';
    let fresh: typeof import('../src/app') | undefined;
    jest.isolateModules(() => {
      fresh = require('../src/app');
    });
    process.env.TRUST_PROXY = saved;
    if (saved === undefined) delete process.env.TRUST_PROXY;
    expect(fresh!.app.get('trust proxy')).toBe(1);
    for (let i = 0; i < 6; i++) {
      await request(fresh!.app).post('/api/auth/login').set('X-Forwarded-For', '1.1.1.1').send({ username: 'admin', password: 'bad' });
    }
    const blocked = await request(fresh!.app).post('/api/auth/login').set('X-Forwarded-For', '1.1.1.1').send({ username: 'admin', password: 'bad' });
    expect(blocked.status).toBe(429);
    const other = await request(fresh!.app).post('/api/auth/login').set('X-Forwarded-For', '2.2.2.2').send({ username: 'admin', password: 'bad' });
    expect(other.status).toBe(401);
  });
});

describe('C3: POST /api/ws-ticket', () => {
  it('needs the admin JWT', async () => {
    expect((await request(app).post('/api/ws-ticket').send({ purpose: 'admin' })).status).toBe(401);
  });

  it.each(['signaling', 'admin', 'relay'] as const)('issues a %s ticket', async purpose => {
    const r = await request(app).post('/api/ws-ticket').set('Authorization', admin()).send({ purpose, deviceId: 'device-1' });
    expect(r.status).toBe(200);
    expect(r.body.ticket).toMatch(/^[0-9a-f]{64}$/);
    expect(r.body.expiresAt).toBeGreaterThan(Date.now());
    const claims = wsTicketStore.consume(r.body.ticket, purpose);
    expect(claims).toMatchObject({ purpose, subject: 'admin', deviceId: 'device-1' });
  });

  it('rejects a relay ticket without deviceId and uses the JWT username as subject', async () => {
    expect((await request(app).post('/api/ws-ticket').set('Authorization', admin()).send({ purpose: 'relay' })).status).toBe(400);
    const r = await request(app).post('/api/ws-ticket').set('Authorization', admin()).send({ purpose: 'signaling', deviceId: 'd1' });
    expect(wsTicketStore.consume(r.body.ticket, 'signaling')).toEqual({ purpose: 'signaling', subject: 'admin', deviceId: 'd1' });
  });

  it('rejects an unknown purpose or a bad deviceId', async () => {
    expect((await request(app).post('/api/ws-ticket').set('Authorization', admin()).send({ purpose: 'root' })).status).toBe(400);
    expect((await request(app).post('/api/ws-ticket').set('Authorization', admin()).send({})).status).toBe(400);
    expect((await request(app).post('/api/ws-ticket').set('Authorization', admin()).send({ purpose: 'admin', deviceId: 5 })).status).toBe(400);
  });
});

describe('SS-11: command audit', () => {
  it.each(['WIPE', 'RUN_SHELL', 'REBOOT', 'LOCK'])('POST /devices/:id/commands %s is audited', async type => {
    const { id } = await enroll();
    const payload = type === 'WIPE' ? { confirm: id } : type === 'RUN_SHELL' ? { command: 'id' } : {};
    const r = await request(app).post(`/api/devices/${id}/commands`).set('Authorization', admin()).send({ type, payload });
    expect(r.status).toBe(201);
    const log = auditStore.getRecentLogs().find(l => l.action === 'command.queued' && l.details?.type === type);
    expect(log).toBeDefined();
    expect(log!.actorType).toBe('admin');
    expect(log!.actorId).toBe('admin');
    expect(log!.resourceId).toBe(r.body.id);
    expect(log!.details).toMatchObject({ deviceId: id, type });
  });

  it('POST /api/commands is audited', async () => {
    const { id } = await enroll();
    const r = await request(app).post('/api/commands').set('Authorization', admin()).send({ deviceId: id, type: 'REBOOT' });
    expect(r.status).toBe(201);
    expect(auditStore.getRecentLogs().some(l => l.action === 'command.queued' && l.details?.deviceId === id && l.details?.type === 'REBOOT')).toBe(true);
  });

  it('batch commands are audited per device', async () => {
    const a = await enroll('A');
    const b = await enroll('B');
    const r = await request(app).post('/api/commands/batch').set('Authorization', admin())
      .send({ deviceIds: [a.id, b.id], type: 'LOCK' });
    expect(r.status).toBe(200);
    const queued = auditStore.getRecentLogs().filter(l => l.action === 'command.queued');
    expect(queued.map(l => l.details?.deviceId).sort()).toEqual([a.id, b.id].sort());
  });

  it('policy-triggered SYNC_POLICY commands are audited', async () => {
    const { id } = await enroll();
    const policy = policyStore.createPolicy({ name: 'p' } as any);
    const r = await request(app).put(`/api/devices/${id}/policy`).set('Authorization', admin()).send({ policyId: policy.id });
    expect(r.status).toBe(200);
    expect(auditStore.getRecentLogs().some(l => l.action === 'command.queued' && l.details?.type === 'SYNC_POLICY' && l.details?.deviceId === id)).toBe(true);
  });

  it('device unenroll is audited', async () => {
    const { id } = await enroll();
    await request(app).delete(`/api/devices/${id}`).set('Authorization', admin());
    expect(auditStore.getRecentLogs().some(l => l.action === 'device.unenrolled' && l.resourceId === id)).toBe(true);
    expect(deviceStore.getDevice(id)).toBeFalsy();
  });
});
