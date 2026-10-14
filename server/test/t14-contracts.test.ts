import request from 'supertest';
import Database from 'better-sqlite3';
import { app, resetRateLimiters } from '../src/app';
import { deviceStore } from '../src/services/deviceStore';
import { eventStore } from '../src/services/eventStore';
import { auditStore } from '../src/services/auditStore';
import { policyStore } from '../src/services/policyStore';
import { settingsStore } from '../src/services/settingsStore';
import { queueSyncPolicy } from '../src/services/appSyncService';
import { setupTestDatabase, cleanupTestDatabase, closeTestDatabase, adminAuthHeader, deviceTokenFor } from './setup';

let db: Database.Database;
beforeAll(() => { db = setupTestDatabase(); });
afterAll(() => closeTestDatabase());
beforeEach(() => { cleanupTestDatabase(); resetRateLimiters(); });

function enroll(id: string): string {
  deviceStore.enrollDevice({ id, name: id, model: 'm' });
  return deviceTokenFor(id);
}

// The exact JSON shape TelemetryCollector.kt encodes (TelemetryData), including the kiosk block (T13).
const ANDROID_SAMPLE = {
  batteryLevel: 87, batteryCharging: true, batteryHealth: 'good',
  networkType: 'wifi', networkSsid: 'shop', ipAddress: '10.0.0.5', signalStrength: -58,
  storageUsedBytes: 1000, storageTotalBytes: 2000, memoryUsedBytes: 300, memoryTotalBytes: 900,
  screenOn: true, brightness: 120, latitude: 44.4, longitude: 26.1, locationAccuracy: 12.5,
  uptimeMs: 123456, androidSecurityPatch: '2026-09-05', collectedAt: Date.now() - 1000,
  kioskActive: true, kioskPackage: 'com.shop.player', lockTask: true, protectedPackages: ['com.a.b', 'com.c.d'],
};

describe('T14 telemetry: what the device sends is what the server keeps (T13 kiosk block)', () => {
  it('accepts the Android sample and returns the kiosk fields', async () => {
    const token = enroll('d1');
    const r = await request(app).post('/api/devices/d1/telemetry').set('X-Session-Token', token).send(ANDROID_SAMPLE);
    expect(r.status).toBe(200);
    const got = await request(app).get('/api/devices/d1/telemetry').set('Authorization', adminAuthHeader());
    expect(got.body).toMatchObject({
      kioskActive: true, kioskPackage: 'com.shop.player', lockTask: true, protectedPackages: ['com.a.b', 'com.c.d'],
    });
  });

  it('kioskPackage null (no kiosk) clears the stored package; an absent block keeps it', async () => {
    const token = enroll('d1');
    const send = (b: object) => request(app).post('/api/devices/d1/telemetry').set('X-Session-Token', token).send(b);
    await send(ANDROID_SAMPLE);
    await send({ batteryLevel: 80 });
    let got = await request(app).get('/api/devices/d1/telemetry').set('Authorization', adminAuthHeader());
    expect(got.body.kioskPackage).toBe('com.shop.player');
    await send({ kioskActive: false, kioskPackage: null, lockTask: false, protectedPackages: [] });
    got = await request(app).get('/api/devices/d1/telemetry').set('Authorization', adminAuthHeader());
    expect(got.body).toMatchObject({ kioskActive: false, kioskPackage: null, lockTask: false, protectedPackages: [] });
  });

  it('the batch endpoint carries the kiosk block too', async () => {
    const token = enroll('d1');
    const r = await request(app).post('/api/devices/d1/telemetry/batch').set('X-Session-Token', token)
      .send({ samples: [ANDROID_SAMPLE] });
    expect(r.status).toBe(200);
    expect(r.body.nextReportIn).toBe(60000); // milliseconds, what ReportSchedule reads
    const got = await request(app).get('/api/devices/d1/telemetry').set('Authorization', adminAuthHeader());
    expect(got.body.kioskActive).toBe(true);
  });

  it('empty telemetry (never reported) has the same kiosk keys as null', async () => {
    enroll('d1');
    const got = await request(app).get('/api/devices/d1/telemetry').set('Authorization', adminAuthHeader());
    expect(got.body).toMatchObject({ kioskActive: null, kioskPackage: null, lockTask: null, protectedPackages: null });
  });
});

describe('T14 SYNC_POLICY: a cleared maintenance window is sent explicitly so the device clears it', () => {
  it('updateWindow is null when no window is configured', () => {
    enroll('dev-1');
    const policy = policyStore.createPolicy({ name: 'p', requiredApps: [] } as any);
    const cmd = queueSyncPolicy('dev-1', policy);
    expect(cmd.payload).toHaveProperty('updateWindow', null);
  });
});

describe('T14 events: the eventType filter the UI sends is honoured', () => {
  it('filters by eventType and counts the filtered set', async () => {
    enroll('d1');
    eventStore.recordEvent({ deviceId: 'd1', eventType: 'battery-low', severity: 'warning', data: {} });
    eventStore.recordEvent({ deviceId: 'd1', eventType: 'command-failed', severity: 'warning', data: {} });
    const r = await request(app).get('/api/events?eventType=battery-low').set('Authorization', adminAuthHeader());
    expect(r.body.events.map((e: any) => e.eventType)).toEqual(['battery-low']);
    expect(r.body.total).toBe(1);
  });
});

describe('T14 audit export honours the filters the UI sends', () => {
  it('exports only the requested action', async () => {
    auditStore.log({ actorType: 'admin', actorId: 'a', action: 'device.renamed', resourceType: 'device', resourceId: 'x' });
    auditStore.log({ actorType: 'admin', actorId: 'a', action: 'device.unenrolled', resourceType: 'device', resourceId: 'y' });
    const r = await request(app).get('/api/audit/export?action=device.renamed&format=csv').set('Authorization', adminAuthHeader());
    expect(r.text).toContain('device.renamed');
    expect(r.text).not.toContain('device.unenrolled');
  });
});
