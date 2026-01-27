import request from 'supertest';
import { app, resetRateLimiters } from '../src/app';
import { enrollmentStore } from '../src/services/enrollmentStore';
import { deviceStore } from '../src/services/deviceStore';
import { setupTestDatabase, cleanupTestDatabase, closeTestDatabase } from './setup';

describe('Enrollment Token API', () => {
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

  describe('POST /api/enroll/tokens', () => {
    it('creates a new enrollment token with defaults', async () => {
      const response = await request(app)
        .post('/api/enroll/tokens')
        .send({});

      expect(response.status).toBe(201);
      expect(response.body.id).toMatch(/^token-/);
      expect(response.body.token).toHaveLength(8);
      expect(response.body.maxUses).toBe(1);
      expect(response.body.usedCount).toBe(0);
      expect(response.body.status).toBe('active');
      expect(response.body.expiresAt).toBeGreaterThan(Date.now());
    });

    it('creates token with custom maxUses', async () => {
      const response = await request(app)
        .post('/api/enroll/tokens')
        .send({ maxUses: 5 });

      expect(response.status).toBe(201);
      expect(response.body.maxUses).toBe(5);
    });

    it('creates token with custom expiration', async () => {
      const response = await request(app)
        .post('/api/enroll/tokens')
        .send({ expiresInHours: 1 });

      expect(response.status).toBe(201);
      // Should expire in about 1 hour (give some slack for test execution)
      const oneHourFromNow = Date.now() + 60 * 60 * 1000;
      expect(response.body.expiresAt).toBeLessThanOrEqual(oneHourFromNow + 1000);
      expect(response.body.expiresAt).toBeGreaterThan(Date.now());
    });
  });

  describe('GET /api/enroll/tokens', () => {
    it('returns empty list when no tokens', async () => {
      const response = await request(app).get('/api/enroll/tokens');

      expect(response.status).toBe(200);
      expect(response.body.tokens).toEqual([]);
    });

    it('returns list of tokens', async () => {
      // Create some tokens
      await request(app).post('/api/enroll/tokens').send({});
      await request(app).post('/api/enroll/tokens').send({});

      const response = await request(app).get('/api/enroll/tokens');

      expect(response.status).toBe(200);
      expect(response.body.tokens).toHaveLength(2);
    });

    it('filters tokens by status', async () => {
      // Create a token
      const createResponse = await request(app).post('/api/enroll/tokens').send({});
      const tokenId = createResponse.body.id;

      // Revoke it
      await request(app).delete(`/api/enroll/tokens/${tokenId}`);

      // Create another active token
      await request(app).post('/api/enroll/tokens').send({});

      // Filter by active
      const activeResponse = await request(app).get('/api/enroll/tokens?status=active');
      expect(activeResponse.body.tokens).toHaveLength(1);

      // Filter by revoked
      const revokedResponse = await request(app).get('/api/enroll/tokens?status=revoked');
      expect(revokedResponse.body.tokens).toHaveLength(1);
    });
  });

  describe('DELETE /api/enroll/tokens/:id', () => {
    it('revokes an active token', async () => {
      const createResponse = await request(app).post('/api/enroll/tokens').send({});
      const tokenId = createResponse.body.id;

      const response = await request(app).delete(`/api/enroll/tokens/${tokenId}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);

      // Verify token is revoked
      const listResponse = await request(app).get('/api/enroll/tokens?status=revoked');
      expect(listResponse.body.tokens).toHaveLength(1);
      expect(listResponse.body.tokens[0].id).toBe(tokenId);
    });

    it('returns 404 for unknown token', async () => {
      const response = await request(app).delete('/api/enroll/tokens/unknown-token');

      expect(response.status).toBe(404);
    });

    it('returns 404 when revoking already revoked token', async () => {
      const createResponse = await request(app).post('/api/enroll/tokens').send({});
      const tokenId = createResponse.body.id;

      // Revoke once
      await request(app).delete(`/api/enroll/tokens/${tokenId}`);

      // Try to revoke again
      const response = await request(app).delete(`/api/enroll/tokens/${tokenId}`);
      expect(response.status).toBe(404);
    });
  });

  describe('POST /api/enroll/device', () => {
    it('enrolls device with valid token', async () => {
      // Create token
      const tokenResponse = await request(app).post('/api/enroll/tokens').send({});
      const token = tokenResponse.body.token;

      // Enroll device
      const response = await request(app)
        .post('/api/enroll/device')
        .send({
          token,
          deviceName: 'Test Phone',
          deviceModel: 'Pixel 8',
          androidVersion: '14',
        });

      expect(response.status).toBe(201);
      expect(response.body.deviceId).toMatch(/^device-/);
      expect(response.body.sessionToken).toBeDefined();
      expect(response.body.serverUrl).toContain('ws://');
    });

    it('device appears in device list after enrollment', async () => {
      // Create token
      const tokenResponse = await request(app).post('/api/enroll/tokens').send({});
      const token = tokenResponse.body.token;

      // Enroll device
      const enrollResponse = await request(app)
        .post('/api/enroll/device')
        .send({
          token,
          deviceName: 'My Device',
          deviceModel: 'Galaxy S24',
        });

      const deviceId = enrollResponse.body.deviceId;

      // Check device exists
      const deviceResponse = await request(app).get(`/api/devices/${deviceId}`);
      expect(deviceResponse.status).toBe(200);
      expect(deviceResponse.body.name).toBe('My Device');
      expect(deviceResponse.body.model).toBe('Galaxy S24');
    });

    it('rejects missing token', async () => {
      const response = await request(app)
        .post('/api/enroll/device')
        .send({ deviceName: 'Test' });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('token');
    });

    it('rejects missing deviceName', async () => {
      const response = await request(app)
        .post('/api/enroll/device')
        .send({ token: 'ABC12345' });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('deviceName');
    });

    it('rejects invalid token', async () => {
      const response = await request(app)
        .post('/api/enroll/device')
        .send({
          token: 'INVALID1',
          deviceName: 'Test',
        });

      expect(response.status).toBe(401);
    });

    it('rejects revoked token', async () => {
      // Create and revoke token
      const tokenResponse = await request(app).post('/api/enroll/tokens').send({});
      await request(app).delete(`/api/enroll/tokens/${tokenResponse.body.id}`);

      const response = await request(app)
        .post('/api/enroll/device')
        .send({
          token: tokenResponse.body.token,
          deviceName: 'Test',
        });

      expect(response.status).toBe(401);
    });

    it('exhausts single-use token after enrollment', async () => {
      // Create single-use token
      const tokenResponse = await request(app).post('/api/enroll/tokens').send({ maxUses: 1 });
      const token = tokenResponse.body.token;

      // First enrollment succeeds
      const first = await request(app)
        .post('/api/enroll/device')
        .send({ token, deviceName: 'Device 1' });
      expect(first.status).toBe(201);

      // Second enrollment fails
      const second = await request(app)
        .post('/api/enroll/device')
        .send({ token, deviceName: 'Device 2' });
      expect(second.status).toBe(401);
    });

    it('allows multiple enrollments with multi-use token', async () => {
      // Create multi-use token
      const tokenResponse = await request(app).post('/api/enroll/tokens').send({ maxUses: 3 });
      const token = tokenResponse.body.token;

      // All three enrollments succeed
      for (let i = 1; i <= 3; i++) {
        const response = await request(app)
          .post('/api/enroll/device')
          .send({ token, deviceName: `Device ${i}` });
        expect(response.status).toBe(201);
      }

      // Fourth fails
      const fourth = await request(app)
        .post('/api/enroll/device')
        .send({ token, deviceName: 'Device 4' });
      expect(fourth.status).toBe(401);
    });

    it('is case-insensitive for token', async () => {
      const tokenResponse = await request(app).post('/api/enroll/tokens').send({});
      const token = tokenResponse.body.token;

      // Enroll with lowercase token
      const response = await request(app)
        .post('/api/enroll/device')
        .send({
          token: token.toLowerCase(),
          deviceName: 'Test',
        });

      expect(response.status).toBe(201);
    });
  });
});
