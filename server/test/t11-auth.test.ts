import request from 'supertest';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';
import { app, resetRateLimiters } from '../src/app';
import { deviceStore } from '../src/services/deviceStore';
import { eventStore } from '../src/services/eventStore';
import { auditStore } from '../src/services/auditStore';
import { getJwtSecret } from '../src/middleware/auth';
import { setupTestDatabase, cleanupTestDatabase, closeTestDatabase, adminAuthHeader } from './setup';

let db: Database.Database;
const PASSWORD = 'correct horse battery';

beforeAll(() => { db = setupTestDatabase(); });
afterAll(() => closeTestDatabase());
beforeEach(async () => {
  cleanupTestDatabase();
  resetRateLimiters();
  db.prepare("DELETE FROM settings WHERE key LIKE 'admin%'").run();
  db.prepare('DELETE FROM revoked_tokens').run();
  process.env.ADMIN_PASSWORD_HASH = await bcrypt.hash(PASSWORD, 4);
  delete process.env.ADMIN_INITIAL_PASSWORD;
});
afterEach(() => { delete process.env.ADMIN_PASSWORD_HASH; });

const login = (password = PASSWORD, username = 'admin') =>
  request(app).post('/api/auth/login').send({ username, password });
const bearer = (t: string) => `Bearer ${t}`;
const verify = (t: string) => request(app).get('/api/auth/verify').set('Authorization', bearer(t));
const actions = () => auditStore.getRecentLogs(100).map(l => l.action);

describe('SS-09: admin session lifetime and identity', () => {
  it('issues an 8 hour token with a unique jti', async () => {
    const a = (await login()).body.token;
    const b = (await login()).body.token;
    const pa = jwt.decode(a) as jwt.JwtPayload;
    const pb = jwt.decode(b) as jwt.JwtPayload;
    expect(pa.exp! - pa.iat!).toBe(8 * 3600);
    expect(pa.jti).toBeTruthy();
    expect(pa.jti).not.toBe(pb.jti);
  });

  it('JWT_EXPIRES_IN overrides the lifetime', async () => {
    process.env.JWT_EXPIRES_IN = '1h';
    try {
      const p = jwt.decode((await login()).body.token) as jwt.JwtPayload;
      expect(p.exp! - p.iat!).toBe(3600);
    } finally {
      delete process.env.JWT_EXPIRES_IN;
    }
  });
});

describe('SS-09: POST /api/auth/logout revokes the session', () => {
  it('requires a credential', async () => {
    expect((await request(app).post('/api/auth/logout')).status).toBe(401);
  });

  it('revokes only the presented token', async () => {
    const a = (await login()).body.token;
    const b = (await login()).body.token;
    expect((await verify(a)).status).toBe(200);
    const out = await request(app).post('/api/auth/logout').set('Authorization', bearer(a));
    expect(out.status).toBe(200);
    expect((await verify(a)).status).toBe(401);
    expect((await request(app).get('/api/devices').set('Authorization', bearer(a))).status).toBe(401);
    expect((await verify(b)).status).toBe(200);
  });

  it('a second logout with the same token is 401', async () => {
    const a = (await login()).body.token;
    await request(app).post('/api/auth/logout').set('Authorization', bearer(a));
    expect((await request(app).post('/api/auth/logout').set('Authorization', bearer(a))).status).toBe(401);
  });

  it('writes an admin.logout audit entry', async () => {
    const a = (await login()).body.token;
    await request(app).post('/api/auth/logout').set('Authorization', bearer(a));
    expect(actions()).toContain('admin.logout');
  });

  it('a revoked ws-ticket request is refused too', async () => {
    const a = (await login()).body.token;
    await request(app).post('/api/auth/logout').set('Authorization', bearer(a));
    expect((await request(app).post('/api/ws-ticket').set('Authorization', bearer(a)).send({ purpose: 'admin' })).status).toBe(401);
  });
});

describe('SS-09: changing the password revokes every session', () => {
  it('old tokens die, a new login works with the new password', async () => {
    const a = (await login()).body.token;
    const b = (await login()).body.token;
    const legacy = jwt.sign({ username: 'admin', iat: Math.floor(Date.now() / 1000) - 60 }, getJwtSecret(), { expiresIn: '1h' });
    expect((await verify(legacy)).status).toBe(200);

    const ch = await request(app).put('/api/auth/password').set('Authorization', bearer(a))
      .send({ currentPassword: PASSWORD, newPassword: 'a brand new password' });
    expect(ch.status).toBe(200);

    expect((await verify(a)).status).toBe(401);
    expect((await verify(b)).status).toBe(401);
    expect((await verify(legacy)).status).toBe(401);

    delete process.env.ADMIN_PASSWORD_HASH; // the stored hash now wins anyway
    const again = await login('a brand new password');
    expect(again.status).toBe(200);
    expect((await verify(again.body.token)).status).toBe(200);
  });

  it('a token minted in the same second as the change but after it survives', async () => {
    const a = (await login()).body.token;
    await request(app).put('/api/auth/password').set('Authorization', bearer(a))
      .send({ currentPassword: PASSWORD, newPassword: 'another new password' });
    const fresh = await login('another new password');
    expect((await verify(fresh.body.token)).status).toBe(200);
  });

  it('a failed change leaves sessions alone', async () => {
    const a = (await login()).body.token;
    const ch = await request(app).put('/api/auth/password').set('Authorization', bearer(a))
      .send({ currentPassword: 'wrong password', newPassword: 'another new password' });
    expect(ch.status).toBe(401);
    expect((await verify(a)).status).toBe(200);
  });
});

describe('SS-11: login attempts are audited', () => {
  it('records a successful login', async () => {
    await login();
    expect(actions()).toContain('admin.login');
  });

  it('records a wrong password with the username and IP, never the password', async () => {
    const r = await login('not the password');
    expect(r.status).toBe(401);
    const entry = auditStore.getRecentLogs(10).find(l => l.action === 'admin.login_failed')!;
    expect(entry).toBeDefined();
    expect(entry.actorId).toBe('admin');
    expect(entry.ipAddress).toBeTruthy();
    expect(JSON.stringify(entry)).not.toContain('not the password');
    expect(entry.details).toMatchObject({ reason: 'invalid_credentials' });
  });

  it('records an unknown user', async () => {
    await login(PASSWORD, 'mallory');
    const entry = auditStore.getRecentLogs(10).find(l => l.action === 'admin.login_failed')!;
    expect(entry.actorId).toBe('mallory');
  });

  it('records a login refused because no password is configured', async () => {
    delete process.env.ADMIN_PASSWORD_HASH;
    await login();
    const entry = auditStore.getRecentLogs(10).find(l => l.action === 'admin.login_failed')!;
    expect(entry.details).toMatchObject({ reason: 'not_configured' });
  });

  it('records a rate-limited attempt', async () => {
    for (let i = 0; i < 5; i++) await login('bad');
    const r = await login('bad');
    expect(r.status).toBe(429);
    const reasons = auditStore.getRecentLogs(50).filter(l => l.action === 'admin.login_failed').map(l => (l.details as any).reason);
    expect(reasons).toContain('rate_limited');
  });

  it('truncates a very long username in the audit log', async () => {
    await request(app).post('/api/auth/login').send({ username: 'x'.repeat(100), password: 'p' });
    const entry = auditStore.getRecentLogs(10).find(l => l.action === 'admin.login_failed')!;
    expect((entry.actorId || '').length).toBeLessThanOrEqual(100);
  });
});

describe('SS-11: event acknowledge takes the actor from the JWT', () => {
  function adminAs(name: string): string {
    return bearer(jwt.sign({ username: name }, getJwtSecret(), { expiresIn: '1h' }));
  }
  function mkEvent(): number {
    deviceStore.enrollDevice({ id: 'd1', name: 'd1', model: 'm' });
    return eventStore.recordEvent({ deviceId: 'd1', eventType: 'battery-low', severity: 'warning' }).id;
  }

  it('ignores acknowledgedBy in the body (single)', async () => {
    const id = mkEvent();
    const r = await request(app).post(`/api/events/${id}/acknowledge`).set('Authorization', adminAs('alice')).send({ acknowledgedBy: 'bob' });
    expect(r.status).toBe(200);
    const ev = eventStore.getDeviceEvents('d1').find(e => e.id === id)!;
    expect(ev.acknowledgedBy).toBe('alice');
    const entry = auditStore.getRecentLogs(10).find(l => l.action === 'event.acknowledged')!;
    expect(entry.actorId).toBe('alice');
  });

  it('ignores acknowledgedBy in the body (bulk) and audits it', async () => {
    const a = mkEvent();
    const b = mkEvent();
    const r = await request(app).post('/api/events/acknowledge').set('Authorization', adminAs('alice')).send({ eventIds: [a, b], acknowledgedBy: 'bob' });
    expect(r.status).toBe(200);
    expect(r.body.acknowledged).toBe(2);
    const evs = eventStore.getDeviceEvents('d1');
    expect(evs.every(e => e.acknowledgedBy === 'alice')).toBe(true);
    const entry = auditStore.getRecentLogs(10).find(l => l.action === 'event.acknowledged')!;
    expect(entry.actorId).toBe('alice');
    expect(entry.details).toMatchObject({ count: 2 });
  });

  it('still works with the plain test admin token', async () => {
    const id = mkEvent();
    expect((await request(app).post(`/api/events/${id}/acknowledge`).set('Authorization', adminAuthHeader()).send({})).status).toBe(200);
  });
});
