import request from 'supertest';
import { app, resetRateLimiters } from '../src/app';
import { deviceStore } from '../src/services/deviceStore';
import { commandStore } from '../src/services/commandStore';
import { setupTestDatabase, cleanupTestDatabase, closeTestDatabase, adminAuthHeader, deviceTokenFor } from './setup';

describe('Device Commands API', () => {
  beforeAll(() => {
    setupTestDatabase();
  });

  afterAll(() => {
    closeTestDatabase();
  });

  beforeEach(() => {
    cleanupTestDatabase();
    resetRateLimiters();

    // Create a test device
    deviceStore.enrollDevice({
      id: 'test-device',
      name: 'Test Device',
      model: 'Test Model',
    });
  });

  describe('POST /api/devices/:id/commands', () => {
    it('queues a LOCK command', async () => {
      const response = await request(app)
        .post('/api/devices/test-device/commands').set('Authorization', adminAuthHeader())
        .send({ type: 'LOCK' });

      expect(response.status).toBe(201);
      expect(response.body.id).toMatch(/^cmd-/);
      expect(response.body.deviceId).toBe('test-device');
      expect(response.body.type).toBe('LOCK');
      expect(response.body.status).toBe('pending');
      expect(response.body.payload).toEqual({});
    });

    it('queues an INSTALL_APK command with payload', async () => {
      const response = await request(app)
        .post('/api/devices/test-device/commands').set('Authorization', adminAuthHeader())
        .send({
          type: 'INSTALL_APK',
          payload: {
            url: 'https://example.com/app.apk',
            packageName: 'com.example.app',
            sha256: 'a'.repeat(64), // C6: required for INSTALL_APK that does not point at an uploaded package
          },
        });

      expect(response.status).toBe(201);
      expect(response.body.type).toBe('INSTALL_APK');
      expect(response.body.payload.url).toBe('https://example.com/app.apk');
      expect(response.body.payload.packageName).toBe('com.example.app');
    });

    it('queues an UNINSTALL_APP command', async () => {
      const response = await request(app)
        .post('/api/devices/test-device/commands').set('Authorization', adminAuthHeader())
        .send({
          type: 'UNINSTALL_APP',
          payload: { packageName: 'com.example.app' },
        });

      expect(response.status).toBe(201);
      expect(response.body.type).toBe('UNINSTALL_APP');
    });

    it('queues a REBOOT command', async () => {
      const response = await request(app)
        .post('/api/devices/test-device/commands').set('Authorization', adminAuthHeader())
        .send({ type: 'REBOOT' });

      expect(response.status).toBe(201);
      expect(response.body.type).toBe('REBOOT');
    });

    it('queues a WIPE command', async () => {
      const response = await request(app)
        .post('/api/devices/test-device/commands').set('Authorization', adminAuthHeader())
        .send({
          type: 'WIPE',
          payload: { confirm: 'test-device' },
        });

      expect(response.status).toBe(201);
      expect(response.body.type).toBe('WIPE');
    });

    it('queues a START_REMOTE command', async () => {
      const response = await request(app)
        .post('/api/devices/test-device/commands').set('Authorization', adminAuthHeader())
        .send({
          type: 'START_REMOTE',
          payload: { signalingUrl: 'wss://server.example.com/ws' },
        });

      expect(response.status).toBe(201);
      expect(response.body.type).toBe('START_REMOTE');
    });

    it('returns 404 for unknown device', async () => {
      const response = await request(app)
        .post('/api/devices/unknown-device/commands').set('Authorization', adminAuthHeader())
        .send({ type: 'LOCK' });

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Device not found');
    });

    it('returns 400 for invalid command type', async () => {
      const response = await request(app)
        .post('/api/devices/test-device/commands').set('Authorization', adminAuthHeader())
        .send({ type: 'INVALID_TYPE' });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Invalid command type');
    });

    it('returns 400 for INSTALL_APK without url', async () => {
      const response = await request(app)
        .post('/api/devices/test-device/commands').set('Authorization', adminAuthHeader())
        .send({
          type: 'INSTALL_APK',
          payload: { packageName: 'com.example.app' },
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('url');
    });

    it('returns 400 for INSTALL_APK without packageName', async () => {
      const response = await request(app)
        .post('/api/devices/test-device/commands').set('Authorization', adminAuthHeader())
        .send({
          type: 'INSTALL_APK',
          payload: { url: 'https://example.com/app.apk' },
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('packageName');
    });

    it('returns 400 for UNINSTALL_APP without packageName', async () => {
      const response = await request(app)
        .post('/api/devices/test-device/commands').set('Authorization', adminAuthHeader())
        .send({
          type: 'UNINSTALL_APP',
          payload: {},
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('packageName');
    });
  });

  describe('GET /api/devices/:id/commands/pending', () => {
    it('returns empty list when no pending commands', async () => {
      const response = await request(app)
        .get('/api/devices/test-device/commands/pending').set('X-Session-Token', deviceTokenFor('test-device'));

      expect(response.status).toBe(200);
      expect(response.body.commands).toEqual([]);
    });

    it('returns pending commands and marks them as delivered', async () => {
      // Queue some commands
      await request(app)
        .post('/api/devices/test-device/commands').set('Authorization', adminAuthHeader())
        .send({ type: 'LOCK' });
      await request(app)
        .post('/api/devices/test-device/commands').set('Authorization', adminAuthHeader())
        .send({ type: 'REBOOT' });

      // Poll for commands
      const response = await request(app)
        .get('/api/devices/test-device/commands/pending').set('X-Session-Token', deviceTokenFor('test-device'));

      expect(response.status).toBe(200);
      expect(response.body.commands).toHaveLength(2);
      expect(response.body.commands[0].status).toBe('delivered');
      expect(response.body.commands[0].deliveredAt).toBeDefined();

      // Second poll should return empty (commands are now delivered)
      const secondPoll = await request(app)
        .get('/api/devices/test-device/commands/pending').set('X-Session-Token', deviceTokenFor('test-device'));

      expect(secondPoll.body.commands).toEqual([]);
    });

    it('updates device last seen when polling', async () => {
      // Initial status should be offline with no lastSeenAt
      const initialStatus = await request(app)
        .get('/api/devices/test-device/status').set('Authorization', adminAuthHeader());
      expect(initialStatus.body.status).toBe('offline');

      // Poll for commands
      await request(app).get('/api/devices/test-device/commands/pending').set('X-Session-Token', deviceTokenFor('test-device'));

      // Status should now be online
      const afterPoll = await request(app)
        .get('/api/devices/test-device/status').set('Authorization', adminAuthHeader());
      expect(afterPoll.body.status).toBe('online');
      expect(afterPoll.body.lastSeenAt).toBeDefined();
    });
  });

  describe('GET /api/devices/:id/commands', () => {
    it('returns command history', async () => {
      // Queue and complete some commands
      const cmd1 = await request(app)
        .post('/api/devices/test-device/commands').set('Authorization', adminAuthHeader())
        .send({ type: 'LOCK' });

      await request(app)
        .patch(`/api/devices/test-device/commands/${cmd1.body.id}`).set('Authorization', adminAuthHeader())
        .send({ status: 'completed' });

      const response = await request(app)
        .get('/api/devices/test-device/commands').set('Authorization', adminAuthHeader());

      expect(response.status).toBe(200);
      expect(response.body.commands).toHaveLength(1);
      expect(response.body.commands[0].status).toBe('completed');
    });

    it('filters by status', async () => {
      // Create commands with different statuses
      await request(app)
        .post('/api/devices/test-device/commands').set('Authorization', adminAuthHeader())
        .send({ type: 'LOCK' });

      const cmd2 = await request(app)
        .post('/api/devices/test-device/commands').set('Authorization', adminAuthHeader())
        .send({ type: 'REBOOT' });

      await request(app)
        .patch(`/api/devices/test-device/commands/${cmd2.body.id}`).set('Authorization', adminAuthHeader())
        .send({ status: 'completed' });

      // Filter by pending
      const pending = await request(app)
        .get('/api/devices/test-device/commands?status=pending').set('Authorization', adminAuthHeader());
      expect(pending.body.commands).toHaveLength(1);
      expect(pending.body.commands[0].type).toBe('LOCK');

      // Filter by completed
      const completed = await request(app)
        .get('/api/devices/test-device/commands?status=completed').set('Authorization', adminAuthHeader());
      expect(completed.body.commands).toHaveLength(1);
      expect(completed.body.commands[0].type).toBe('REBOOT');
    });

    it('supports limit and offset', async () => {
      // Create 5 commands
      for (let i = 0; i < 5; i++) {
        await request(app)
          .post('/api/devices/test-device/commands').set('Authorization', adminAuthHeader())
          .send({ type: 'LOCK' });
      }

      // Get first 2
      const first = await request(app)
        .get('/api/devices/test-device/commands?limit=2').set('Authorization', adminAuthHeader());
      expect(first.body.commands).toHaveLength(2);

      // Get next 2
      const second = await request(app)
        .get('/api/devices/test-device/commands?limit=2&offset=2').set('Authorization', adminAuthHeader());
      expect(second.body.commands).toHaveLength(2);
    });
  });

  describe('PATCH /api/devices/:id/commands/:cmdId', () => {
    it('acknowledges command as executing', async () => {
      const cmd = await request(app)
        .post('/api/devices/test-device/commands').set('Authorization', adminAuthHeader())
        .send({ type: 'INSTALL_APK', payload: { url: 'http://x.com/a.apk', packageName: 'x', sha256: 'b'.repeat(64) } });

      const response = await request(app)
        .patch(`/api/devices/test-device/commands/${cmd.body.id}`).set('Authorization', adminAuthHeader())
        .send({ status: 'executing' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.status).toBe('executing');
    });

    it('acknowledges command as completed', async () => {
      const cmd = await request(app)
        .post('/api/devices/test-device/commands').set('Authorization', adminAuthHeader())
        .send({ type: 'LOCK' });

      const response = await request(app)
        .patch(`/api/devices/test-device/commands/${cmd.body.id}`).set('Authorization', adminAuthHeader())
        .send({ status: 'completed' });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('completed');

      // Verify in history
      const history = await request(app)
        .get('/api/devices/test-device/commands?status=completed').set('Authorization', adminAuthHeader());
      expect(history.body.commands[0].completedAt).toBeDefined();
    });

    it('acknowledges command as failed with error', async () => {
      const cmd = await request(app)
        .post('/api/devices/test-device/commands').set('Authorization', adminAuthHeader())
        .send({ type: 'INSTALL_APK', payload: { url: 'http://x.com/a.apk', packageName: 'x', sha256: 'b'.repeat(64) } });

      const response = await request(app)
        .patch(`/api/devices/test-device/commands/${cmd.body.id}`).set('Authorization', adminAuthHeader())
        .send({ status: 'failed', error: 'APK download failed' });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('failed');

      // Verify error is stored
      const history = await request(app)
        .get('/api/devices/test-device/commands?status=failed').set('Authorization', adminAuthHeader());
      expect(history.body.commands[0].error).toBe('APK download failed');
    });

    it('returns 400 for invalid status', async () => {
      const cmd = await request(app)
        .post('/api/devices/test-device/commands').set('Authorization', adminAuthHeader())
        .send({ type: 'LOCK' });

      const response = await request(app)
        .patch(`/api/devices/test-device/commands/${cmd.body.id}`).set('Authorization', adminAuthHeader())
        .send({ status: 'pending' });

      expect(response.status).toBe(400);
    });

    it('returns 404 for unknown command', async () => {
      const response = await request(app)
        .patch('/api/devices/test-device/commands/unknown-cmd').set('Authorization', adminAuthHeader())
        .send({ status: 'completed' });

      expect(response.status).toBe(404);
    });

    it('returns 409 when acknowledging already completed command', async () => {
      const cmd = await request(app)
        .post('/api/devices/test-device/commands').set('Authorization', adminAuthHeader())
        .send({ type: 'LOCK' });

      // Complete it
      await request(app)
        .patch(`/api/devices/test-device/commands/${cmd.body.id}`).set('Authorization', adminAuthHeader())
        .send({ status: 'completed' });

      // Try to complete again
      const response = await request(app)
        .patch(`/api/devices/test-device/commands/${cmd.body.id}`).set('Authorization', adminAuthHeader())
        .send({ status: 'completed' });

      expect(response.status).toBe(409);
    });
  });

  describe('DELETE /api/devices/:id/commands/:cmdId', () => {
    it('cancels a pending command', async () => {
      const cmd = await request(app)
        .post('/api/devices/test-device/commands').set('Authorization', adminAuthHeader())
        .send({ type: 'LOCK' });

      const response = await request(app)
        .delete(`/api/devices/test-device/commands/${cmd.body.id}`).set('Authorization', adminAuthHeader());

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);

      // Verify command is gone
      const history = await request(app)
        .get('/api/devices/test-device/commands').set('Authorization', adminAuthHeader());
      expect(history.body.commands).toHaveLength(0);
    });

    it('returns 404 when cancelling non-pending command', async () => {
      const cmd = await request(app)
        .post('/api/devices/test-device/commands').set('Authorization', adminAuthHeader())
        .send({ type: 'LOCK' });

      // Mark as delivered by polling
      await request(app).get('/api/devices/test-device/commands/pending').set('X-Session-Token', deviceTokenFor('test-device'));

      // Try to cancel
      const response = await request(app)
        .delete(`/api/devices/test-device/commands/${cmd.body.id}`).set('Authorization', adminAuthHeader());

      expect(response.status).toBe(404);
    });

    it('returns 404 for unknown command', async () => {
      const response = await request(app)
        .delete('/api/devices/test-device/commands/unknown-cmd').set('Authorization', adminAuthHeader());

      expect(response.status).toBe(404);
    });
  });
});
