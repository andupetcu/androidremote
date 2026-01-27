import request from 'supertest';
import { app, resetRateLimiters } from '../src/app';
import { deviceStore } from '../src/services/deviceStore';
import { setupTestDatabase, cleanupTestDatabase, closeTestDatabase } from './setup';

describe('Device Management API', () => {
  beforeAll(() => {
    setupTestDatabase();
  });

  afterAll(() => {
    closeTestDatabase();
  });

  beforeEach(() => {
    cleanupTestDatabase();
    resetRateLimiters();
  });

  describe('GET /api/devices', () => {
    it('returns empty list when no devices enrolled', async () => {
      const response = await request(app).get('/api/devices');

      expect(response.status).toBe(200);
      expect(response.body.devices).toEqual([]);
    });

    it('returns list of enrolled devices', async () => {
      // Enroll some devices
      deviceStore.enrollDevice({
        id: 'device-001',
        name: 'Test Device 1',
        model: 'Pixel 7',
      });
      deviceStore.enrollDevice({
        id: 'device-002',
        name: 'Test Device 2',
        model: 'Galaxy S23',
      });

      const response = await request(app).get('/api/devices');

      expect(response.status).toBe(200);
      expect(response.body.devices).toHaveLength(2);

      // Check both devices are present (order may vary if enrolled in same millisecond)
      const deviceNames = response.body.devices.map((d: { name: string }) => d.name);
      expect(deviceNames).toContain('Test Device 1');
      expect(deviceNames).toContain('Test Device 2');
    });
  });

  describe('GET /api/devices/:id', () => {
    it('returns device details for enrolled device', async () => {
      deviceStore.enrollDevice({
        id: 'device-123',
        name: 'My Phone',
        model: 'Pixel 8',
        androidVersion: '14',
      });

      const response = await request(app).get('/api/devices/device-123');

      expect(response.status).toBe(200);
      expect(response.body.id).toBe('device-123');
      expect(response.body.name).toBe('My Phone');
      expect(response.body.model).toBe('Pixel 8');
      expect(response.body.androidVersion).toBe('14');
      expect(response.body.status).toBe('offline');
    });

    it('returns 404 for unknown device', async () => {
      const response = await request(app).get('/api/devices/unknown-device');

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Device not found');
    });
  });

  describe('DELETE /api/devices/:id', () => {
    it('unenrolls an enrolled device', async () => {
      deviceStore.enrollDevice({
        id: 'device-to-delete',
        name: 'Temporary Device',
      });

      const response = await request(app).delete('/api/devices/device-to-delete');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);

      // Verify device is gone
      const getResponse = await request(app).get('/api/devices/device-to-delete');
      expect(getResponse.status).toBe(404);
    });

    it('returns 404 when deleting unknown device', async () => {
      const response = await request(app).delete('/api/devices/unknown-device');

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Device not found');
    });
  });

  describe('GET /api/devices/:id/status', () => {
    it('returns device status', async () => {
      deviceStore.enrollDevice({
        id: 'device-status-test',
        name: 'Status Test Device',
      });

      const response = await request(app).get('/api/devices/device-status-test/status');

      expect(response.status).toBe(200);
      expect(response.body.deviceId).toBe('device-status-test');
      expect(response.body.status).toBe('offline');
      expect(response.body.lastSeenAt).toBeNull();
    });

    it('returns 404 for unknown device', async () => {
      const response = await request(app).get('/api/devices/unknown/status');

      expect(response.status).toBe(404);
    });
  });

  describe('POST /api/devices/:id/heartbeat', () => {
    it('updates device last seen and sets online status', async () => {
      deviceStore.enrollDevice({
        id: 'device-heartbeat-test',
        name: 'Heartbeat Test Device',
      });

      const response = await request(app).post('/api/devices/device-heartbeat-test/heartbeat');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.timestamp).toBeDefined();

      // Verify device is now online
      const statusResponse = await request(app).get('/api/devices/device-heartbeat-test/status');
      expect(statusResponse.body.status).toBe('online');
      expect(statusResponse.body.lastSeenAt).toBeDefined();
    });

    it('returns 404 for unknown device', async () => {
      const response = await request(app).post('/api/devices/unknown/heartbeat');

      expect(response.status).toBe(404);
    });
  });

  describe('Device enrollment via pairing', () => {
    it('auto-enrolls device when pairing completes', async () => {
      // Initiate pairing
      const initResponse = await request(app)
        .post('/api/pair/initiate')
        .send({ devicePublicKey: 'test-public-key' });

      expect(initResponse.status).toBe(201);
      const { deviceId, pairingCode } = initResponse.body;

      // Device should not be enrolled yet
      const beforeEnroll = await request(app).get(`/api/devices/${deviceId}`);
      expect(beforeEnroll.status).toBe(404);

      // Complete pairing
      const completeResponse = await request(app)
        .post('/api/pair/complete')
        .send({
          pairingCode,
          controllerPublicKey: 'controller-key',
        });

      expect(completeResponse.status).toBe(200);

      // Device should now be enrolled
      const afterEnroll = await request(app).get(`/api/devices/${deviceId}`);
      expect(afterEnroll.status).toBe(200);
      expect(afterEnroll.body.id).toBe(deviceId);
    });
  });
});
