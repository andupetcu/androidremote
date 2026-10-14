import request from 'supertest';
import { app, resetRateLimiters } from '../src/app';
import { deviceStore } from '../src/services/deviceStore';
import { setupTestDatabase, cleanupTestDatabase, closeTestDatabase, adminAuthHeader, deviceTokenFor } from './setup';

// Remote desktop is root-only: the device reports `rooted` so the UI can say so before a session starts.
beforeAll(() => { setupTestDatabase(); });
afterAll(() => closeTestDatabase());
beforeEach(() => { cleanupTestDatabase(); resetRateLimiters(); });

async function report(id: string, body: object) {
  const token = deviceTokenFor(id);
  return request(app).post(`/api/devices/${id}/telemetry`).set('X-Session-Token', token).send(body);
}
const latest = (id: string) => request(app).get(`/api/devices/${id}/telemetry`).set('Authorization', adminAuthHeader());

describe('telemetry rooted flag', () => {
  beforeEach(() => { deviceStore.enrollDevice({ id: 'r1', name: 'r1', model: 'm' }); });

  it('stores and returns rooted=false', async () => {
    expect((await report('r1', { batteryLevel: 50, rooted: false })).status).toBe(200);
    expect((await latest('r1')).body.rooted).toBe(false);
  });

  it('stores rooted=true, and an absent field keeps the last value', async () => {
    await report('r1', { batteryLevel: 50, rooted: true });
    await report('r1', { batteryLevel: 40 });
    expect((await latest('r1')).body.rooted).toBe(true);
  });

  it('is null before the device ever reports it', async () => {
    expect((await latest('r1')).body.rooted ?? null).toBeNull();
  });

  it('is kept from batch uploads too', async () => {
    const token = deviceTokenFor('r1');
    const r = await request(app).post('/api/devices/r1/telemetry/batch').set('X-Session-Token', token)
      .send({ samples: [{ batteryLevel: 60, rooted: false, collectedAt: Date.now() - 5000 }] });
    expect(r.status).toBe(200);
    expect((await latest('r1')).body.rooted).toBe(false);
  });
});
