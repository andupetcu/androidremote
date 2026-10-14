import request from 'supertest';
import Database from 'better-sqlite3';
import { app, resetRateLimiters } from '../src/app';
import { deviceStore } from '../src/services/deviceStore';
import { eventStore } from '../src/services/eventStore';
import { telemetryStore } from '../src/services/telemetryStore';
import { setupTestDatabase, cleanupTestDatabase, closeTestDatabase, adminAuthHeader, deviceTokenFor } from './setup';

let db: Database.Database;

function enroll(id: string): string {
  deviceStore.enrollDevice({ id, name: id, model: 'm' });
  return deviceTokenFor(id);
}
const post = (id: string, token: string, body: object, path = 'telemetry') =>
  request(app).post(`/api/devices/${id}/${path}`).set('X-Session-Token', token).send(body);
const history = (id: string, qs = '') =>
  request(app).get(`/api/devices/${id}/telemetry/history${qs}`).set('Authorization', adminAuthHeader());
const histRows = (id: string) =>
  db.prepare('SELECT * FROM telemetry_history WHERE device_id = ? ORDER BY recorded_at').all(id) as any[];
const events = (id: string, type: string) =>
  eventStore.getDeviceEvents(id, { limit: 500 }).filter(e => e.eventType === type);

beforeAll(() => { db = setupTestDatabase(); });
afterAll(() => closeTestDatabase());
beforeEach(() => { cleanupTestDatabase(); resetRateLimiters(); delete process.env.TELEMETRY_REPORT_INTERVAL_MS; });

describe('SR-09: history rows are written', () => {
  it('every telemetry report adds a history row', async () => {
    const token = enroll('d1');
    await post('d1', token, { batteryLevel: 80, networkType: 'wifi', storageUsedBytes: 5, memoryUsedBytes: 7 });
    await post('d1', token, { batteryLevel: 79, networkType: 'wifi', storageUsedBytes: 5, memoryUsedBytes: 8 });
    const rows = histRows('d1');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ battery_level: 80, network_type: 'wifi', storage_used_bytes: 5, memory_used_bytes: 7 });
  });

  it('uses collectedAt as the history time when it is plausible', async () => {
    const token = enroll('d1');
    const at = Date.now() - 60_000;
    await post('d1', token, { batteryLevel: 50, collectedAt: at });
    expect(histRows('d1')[0].recorded_at).toBe(at);
  });

  it('ignores a collectedAt in the far future', async () => {
    const token = enroll('d1');
    await post('d1', token, { batteryLevel: 50, collectedAt: Date.now() + 10 * 86_400_000 });
    expect(histRows('d1')[0].recorded_at).toBeLessThan(Date.now() + 5000);
  });

  it('the history API returns the rows written by reports', async () => {
    const token = enroll('d1');
    await post('d1', token, { batteryLevel: 61 });
    const r = await history('d1');
    expect(r.status).toBe(200);
    expect(r.body.dataPoints).toHaveLength(1);
    expect(r.body.dataPoints[0].batteryLevel).toBe(61);
  });

  it('a field sent as null is cleared; an absent field is kept', async () => {
    const token = enroll('d1');
    await post('d1', token, { networkType: 'wifi', networkSsid: 'Office', ipAddress: '10.0.0.5', latitude: 1, longitude: 2 });
    await post('d1', token, { networkType: 'cellular', networkSsid: null, latitude: null, longitude: null });
    const t = telemetryStore.getTelemetry('d1')!;
    expect(t.networkType).toBe('cellular');
    expect(t.networkSsid).toBeNull();
    expect(t.latitude).toBeNull();
    expect(t.ipAddress).toBe('10.0.0.5'); // not in the second body
  });

  it('answers nextReportIn in milliseconds, configurable', async () => {
    const token = enroll('d1');
    expect((await post('d1', token, { batteryLevel: 50 })).body.nextReportIn).toBe(60000);
    process.env.TELEMETRY_REPORT_INTERVAL_MS = '120000';
    expect((await post('d1', token, { batteryLevel: 50 })).body.nextReportIn).toBe(120000);
  });

  it('rejects an out-of-range battery level', async () => {
    const token = enroll('d1');
    expect((await post('d1', token, { batteryLevel: 150 })).status).toBe(400);
  });
});

describe('POST /api/devices/:id/telemetry/batch (T10 contract)', () => {
  it('needs the device token', async () => {
    enroll('d1');
    const r = await request(app).post('/api/devices/d1/telemetry/batch').send({ samples: [{ batteryLevel: 5 }] });
    expect(r.status).toBe(401);
  });

  it('a token of another device is refused', async () => {
    enroll('d1');
    const other = enroll('d2');
    expect((await post('d1', other, { samples: [{ batteryLevel: 5 }] }, 'telemetry/batch')).status).toBe(401);
  });

  it('stores one history row per sample at its collectedAt and the newest sample as the latest state', async () => {
    const token = enroll('d1');
    const now = Date.now();
    const r = await post('d1', token, {
      samples: [
        { batteryLevel: 70, collectedAt: now - 120_000 },
        { batteryLevel: 90, collectedAt: now - 60_000 },
        { batteryLevel: 80, collectedAt: now - 180_000 },
      ],
    }, 'telemetry/batch');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ success: true, accepted: 3, nextReportIn: 60000 });
    expect(histRows('d1').map(h => h.battery_level)).toEqual([80, 70, 90]);
    expect(telemetryStore.getTelemetry('d1')!.batteryLevel).toBe(90); // older samples never overwrite the latest
  });

  it('a retried batch does not duplicate history', async () => {
    const token = enroll('d1');
    const body = { samples: [{ batteryLevel: 70, collectedAt: Date.now() - 1000 }] };
    await post('d1', token, body, 'telemetry/batch');
    await post('d1', token, body, 'telemetry/batch');
    expect(histRows('d1')).toHaveLength(1);
  });

  it('validates the body: empty, missing and oversized sample lists are 400', async () => {
    const token = enroll('d1');
    expect((await post('d1', token, {}, 'telemetry/batch')).status).toBe(400);
    expect((await post('d1', token, { samples: [] }, 'telemetry/batch')).status).toBe(400);
    expect((await post('d1', token, { samples: Array.from({ length: 501 }, () => ({ batteryLevel: 5 })) }, 'telemetry/batch')).status).toBe(400);
    expect((await post('d1', token, { samples: [{ batteryLevel: 500 }] }, 'telemetry/batch')).status).toBe(400);
  });

  it('a deviceId inside a sample never writes another device', async () => {
    const token = enroll('d1');
    enroll('d2');
    await post('d1', token, { samples: [{ deviceId: 'd2', batteryLevel: 5 }] }, 'telemetry/batch');
    expect(telemetryStore.getTelemetry('d2')).toBeNull();
  });

  it('battery alerts follow state transitions across a batch (one event, not one per sample)', async () => {
    const token = enroll('d1');
    const now = Date.now();
    await post('d1', token, {
      samples: [10, 12, 14, 15].map((b, i) => ({ batteryLevel: b, collectedAt: now - (10 - i) * 1000 })),
    }, 'telemetry/batch');
    expect(events('d1', 'battery-low')).toHaveLength(1);
  });
});

describe('SR-09: history downsampling in SQL (from, to, bucket, limit)', () => {
  const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);

  function seed(id: string, n: number, stepMs: number): void {
    const ins = db.prepare(
      'INSERT INTO telemetry_history (device_id, battery_level, network_type, storage_used_bytes, memory_used_bytes, recorded_at) VALUES (?,?,?,?,?,?)'
    );
    for (let i = 0; i < n; i++) ins.run(id, 100 - (i % 100), i < n / 2 ? 'wifi' : 'cellular', 1000 + i, 2000 + i, T0 + i * stepMs);
  }

  it('returns raw rows ascending, filtered by from and to', async () => {
    enroll('d1');
    seed('d1', 10, 60_000);
    const r = await history('d1', `?from=${T0 + 2 * 60_000}&to=${T0 + 5 * 60_000}`);
    expect(r.body.dataPoints.map((p: any) => p.timestamp)).toEqual([2, 3, 4, 5].map(i => T0 + i * 60_000));
  });

  it('bucket=hour averages battery and keeps one point per hour', async () => {
    enroll('d1');
    seed('d1', 180, 60_000); // 3 hours, 1 sample/minute
    const r = await history('d1', `?from=${T0}&to=${T0 + 3 * 3_600_000}&bucket=hour`);
    expect(r.status).toBe(200);
    expect(r.body.bucket).toBe('hour');
    expect(r.body.dataPoints).toHaveLength(3);
    expect(r.body.dataPoints.map((p: any) => p.timestamp)).toEqual([0, 1, 2].map(h => T0 + h * 3_600_000));
    // first hour: battery 100..41 -> average 70.5 -> rounded
    expect(r.body.dataPoints[0].batteryLevel).toBe(71);
    // storage: last value in the bucket
    expect(r.body.dataPoints[0].storageUsedBytes).toBe(1059);
    expect(r.body.dataPoints[0].networkType).toBe('wifi');
    expect(r.body.dataPoints[2].networkType).toBe('cellular');
  });

  it('accepts minute, hour, day and the Nm / Nh / Nd forms the UI sends', async () => {
    enroll('d1');
    seed('d1', 120, 60_000);
    const counts: Record<string, number> = {};
    for (const b of ['minute', '15m', 'hour', '1h', 'day', '1d']) {
      const r = await history('d1', `?from=${T0}&to=${T0 + 7_200_000}&bucket=${b}`);
      expect(r.status).toBe(200);
      counts[b] = r.body.dataPoints.length;
    }
    expect(counts).toEqual({ minute: 120, '15m': 8, hour: 2, '1h': 2, day: 1, '1d': 1 });
  });

  it('rejects an unknown bucket', async () => {
    enroll('d1');
    expect((await history('d1', '?bucket=fortnight')).status).toBe(400);
    expect((await history('d1', '?bucket=0m')).status).toBe(400);
  });

  it('limit caps the points and keeps the newest', async () => {
    enroll('d1');
    seed('d1', 50, 60_000);
    const r = await history('d1', `?from=${T0}&to=${T0 + 3_600_000}&limit=5`);
    expect(r.body.dataPoints.map((p: any) => p.timestamp)).toEqual([45, 46, 47, 48, 49].map(i => T0 + i * 60_000));
  });

  it('a hostile or invalid limit is clamped, not an error or a full scan', async () => {
    enroll('d1');
    seed('d1', 10, 60_000);
    const r = await history('d1', `?from=${T0}&to=${T0 + 3_600_000}&limit=abc`);
    expect(r.status).toBe(200);
    expect(r.body.dataPoints).toHaveLength(10);
  });
});

describe('SR-08: battery events only on a state transition (with hysteresis)', () => {
  const level = (id: string, token: string, b: number) => post(id, token, { batteryLevel: b });

  it('emits one battery-low while the level stays under 20', async () => {
    const token = enroll('d1');
    for (const b of [19, 18, 17, 15, 12]) await level('d1', token, b);
    expect(events('d1', 'battery-low')).toHaveLength(1);
  });

  it('does not re-arm until the level reaches 25 (hysteresis)', async () => {
    const token = enroll('d1');
    for (const b of [19, 22, 19, 21, 18]) await level('d1', token, b);
    expect(events('d1', 'battery-low')).toHaveLength(1);
    await level('d1', token, 25);
    await level('d1', token, 19);
    expect(events('d1', 'battery-low')).toHaveLength(2);
  });

  it('emits battery-critical once under 5 and falls back to low (silently) only at 10 or above', async () => {
    const token = enroll('d1');
    for (const b of [30, 19, 4, 3, 6, 4]) await level('d1', token, b);
    expect(events('d1', 'battery-low')).toHaveLength(1);
    expect(events('d1', 'battery-critical')).toHaveLength(1); // 6 is inside the hysteresis band
    await level('d1', token, 11);
    await level('d1', token, 3);
    expect(events('d1', 'battery-critical')).toHaveLength(2);
  });

  it('going straight to critical emits only the critical event', async () => {
    const token = enroll('d1');
    await level('d1', token, 60);
    await level('d1', token, 3);
    expect(events('d1', 'battery-low')).toHaveLength(0);
    expect(events('d1', 'battery-critical')).toHaveLength(1);
  });

  it('a healthy battery never emits', async () => {
    const token = enroll('d1');
    for (const b of [100, 80, 40, 20, 20]) await level('d1', token, b);
    expect(events('d1', 'battery-low')).toHaveLength(0);
  });

  it('a report without a battery level does not change the state', async () => {
    const token = enroll('d1');
    await level('d1', token, 10);
    await post('d1', token, { networkType: 'wifi' });
    await level('d1', token, 9);
    expect(events('d1', 'battery-low')).toHaveLength(1);
  });
});
