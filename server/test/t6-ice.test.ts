import crypto from 'crypto';
import request from 'supertest';
import { app, resetRateLimiters } from '../src/app';
import { deviceStore } from '../src/services/deviceStore';
import { setupTestDatabase, cleanupTestDatabase, closeTestDatabase, adminAuthHeader, deviceTokenFor } from './setup';

const ENV_KEYS = ['STUN_URLS', 'TURN_URLS', 'TURN_SECRET', 'TURN_TTL_SECONDS', 'PUBLIC_BASE_URL', 'BASE_URL'];

describe('T6 ICE servers (C7) and base URL (SS-14)', () => {
  let db: ReturnType<typeof setupTestDatabase>;
  beforeAll(() => { db = setupTestDatabase(); });
  afterAll(() => closeTestDatabase());
  beforeEach(() => {
    cleanupTestDatabase();
    resetRateLimiters();
    for (const k of ENV_KEYS) delete process.env[k];
    deviceStore.enrollDevice({ id: 'd1', name: 'd1' });
  });
  afterEach(() => { for (const k of ENV_KEYS) delete process.env[k]; });

  it('requires a credential', async () => {
    expect((await request(app).get('/api/ice-servers')).status).toBe(401);
    expect((await request(app).get('/api/ice-servers').set('X-Session-Token', 'bad')).status).toBe(401);
  });

  it('returns STUN only, with no credentials, when no TURN is configured', async () => {
    process.env.STUN_URLS = 'stun:stun.example.com:3478, stun:stun2.example.com:3478';
    const res = await request(app).get('/api/ice-servers').set('Authorization', adminAuthHeader());
    expect(res.status).toBe(200);
    expect(res.body.iceServers).toEqual([{ urls: ['stun:stun.example.com:3478', 'stun:stun2.example.com:3478'] }]);
  });

  it('never ships TURN credentials when TURN_SECRET is unset', async () => {
    process.env.TURN_URLS = 'turn:turn.example.com:3478';
    const res = await request(app).get('/api/ice-servers').set('Authorization', adminAuthHeader());
    expect(JSON.stringify(res.body)).not.toMatch(/credential|username/);
  });

  it('builds coturn REST credentials: username <expiry>:<id>, HMAC-SHA1 base64', async () => {
    process.env.STUN_URLS = 'stun:stun.example.com:3478';
    process.env.TURN_URLS = 'turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349?transport=tcp';
    process.env.TURN_SECRET = 'shared-secret';
    process.env.TURN_TTL_SECONDS = '600';
    const before = Math.floor(Date.now() / 1000);
    const res = await request(app).get('/api/ice-servers').set('X-Session-Token', deviceTokenFor('d1'));
    expect(res.status).toBe(200);
    const turn = res.body.iceServers.find((s: any) => s.credential);
    expect(turn.urls).toEqual(['turn:turn.example.com:3478?transport=udp', 'turns:turn.example.com:5349?transport=tcp']);
    const [expiry, id] = turn.username.split(':');
    expect(id).toBe('d1');
    expect(Number(expiry)).toBeGreaterThanOrEqual(before + 600);
    expect(Number(expiry)).toBeLessThanOrEqual(before + 602);
    expect(turn.credential).toBe(crypto.createHmac('sha1', 'shared-secret').update(turn.username).digest('base64'));
    expect(res.body.iceServers.find((s: any) => !s.credential).urls).toEqual(['stun:stun.example.com:3478']);
  });

  it('uses the admin subject as the id for the web UI', async () => {
    process.env.TURN_URLS = 'turn:turn.example.com:3478';
    process.env.TURN_SECRET = 's';
    const res = await request(app).get('/api/ice-servers').set('Authorization', adminAuthHeader());
    expect(res.body.iceServers.find((s: any) => s.username).username).toMatch(/^\d+:admin$/);
  });

  it('does not hand a device token the credentials of another device', async () => {
    process.env.TURN_URLS = 'turn:turn.example.com:3478';
    process.env.TURN_SECRET = 's';
    deviceStore.enrollDevice({ id: 'd2', name: 'd2' });
    const res = await request(app).get('/api/ice-servers').set('X-Session-Token', deviceTokenFor('d2'));
    expect(res.body.iceServers.find((s: any) => s.username).username).toMatch(/:d2$/);
  });

  describe('START_REMOTE payload', () => {
    it('carries iceServers and a signalingUrl from PUBLIC_BASE_URL, never from the Host header', async () => {
      process.env.PUBLIC_BASE_URL = 'https://mdm.example.com/';
      process.env.TURN_URLS = 'turn:turn.example.com:3478';
      process.env.TURN_SECRET = 'secret';
      const res = await request(app).post('/api/devices/d1/commands').set('Authorization', adminAuthHeader())
        .set('Host', 'evil.example.net').set('X-Forwarded-Host', 'evil.example.net')
        .send({ type: 'START_REMOTE', payload: { signalingUrl: 'wss://attacker.example/ws' } });
      expect(res.status).toBe(201);
      expect(res.body.payload.signalingUrl).toBe('wss://mdm.example.com/ws');
      const turn = res.body.payload.iceServers.find((s: any) => s.credential);
      expect(turn.username).toMatch(/:d1$/);
    });

    it('iceServers is present (STUN default) even with nothing configured', async () => {
      const res = await request(app).post('/api/devices/d1/commands').set('Authorization', adminAuthHeader())
        .send({ type: 'START_REMOTE' });
      expect(Array.isArray(res.body.payload.iceServers)).toBe(true);
      expect(res.body.payload.iceServers.length).toBeGreaterThan(0);
    });
  });

  describe('enroll serverUrl does not follow the Host header', () => {
    it('uses PUBLIC_BASE_URL', async () => {
      process.env.PUBLIC_BASE_URL = 'https://mdm.example.com';
      const tokenRes = await request(app).post('/api/enroll/tokens').set('Authorization', adminAuthHeader()).send({});
      const res = await request(app).post('/api/enroll/device').set('Host', 'evil.example.net')
        .send({ token: tokenRes.body.token, deviceName: 'x', deviceModel: 'y' });
      expect(res.status).toBe(201);
      expect(res.body.serverUrl).toBe('https://mdm.example.com');
    });
  });
});
