import request from 'supertest';
import { app, resetRateLimiters } from '../src/app';
import { pairingStore } from '../src/services/pairingStore';

// Mock public keys for testing
const mockDevicePublicKey = 'device-public-key-base64-encoded-32bytes';
const mockControllerPublicKey = 'controller-public-key-base64-encoded';

describe('Pairing API', () => {
  beforeEach(() => {
    // Clear pairing store between tests
    pairingStore.clear();
    // Reset rate limiters to prevent test interference
    resetRateLimiters();
  });

  describe('POST /api/pair/initiate', () => {
    it('creates pairing session and returns device ID', async () => {
      const response = await request(app)
        .post('/api/pair/initiate')
        .send({ devicePublicKey: mockDevicePublicKey });

      expect(response.status).toBe(201);
      expect(response.body.deviceId).toBeDefined();
      expect(response.body.pairingCode).toMatch(/^\d{6}$/);
    });

    it('returns QR code data', async () => {
      const response = await request(app)
        .post('/api/pair/initiate')
        .send({ devicePublicKey: mockDevicePublicKey });

      expect(response.status).toBe(201);
      expect(response.body.qrCodeData).toBeDefined();
      expect(response.body.qrCodeData).toContain('android-remote://pair');
    });

    it('returns expiration time', async () => {
      const before = Date.now();
      const response = await request(app)
        .post('/api/pair/initiate')
        .send({ devicePublicKey: mockDevicePublicKey });

      expect(response.status).toBe(201);
      expect(response.body.expiresAt).toBeGreaterThan(before);
      // Should expire in ~5 minutes
      expect(response.body.expiresAt).toBeLessThanOrEqual(before + 6 * 60 * 1000);
    });

    it('rejects request without public key', async () => {
      const response = await request(app)
        .post('/api/pair/initiate')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('devicePublicKey');
    });

    it('generates unique pairing codes', async () => {
      const response1 = await request(app)
        .post('/api/pair/initiate')
        .send({ devicePublicKey: mockDevicePublicKey + '1' });

      const response2 = await request(app)
        .post('/api/pair/initiate')
        .send({ devicePublicKey: mockDevicePublicKey + '2' });

      expect(response1.body.pairingCode).not.toBe(response2.body.pairingCode);
    });
  });

  describe('POST /api/pair/complete', () => {
    it('completes pairing with valid code', async () => {
      // Setup: create pairing session
      const initResponse = await request(app)
        .post('/api/pair/initiate')
        .send({ devicePublicKey: mockDevicePublicKey });

      const response = await request(app)
        .post('/api/pair/complete')
        .send({
          pairingCode: initResponse.body.pairingCode,
          controllerPublicKey: mockControllerPublicKey,
        });

      expect(response.status).toBe(200);
      expect(response.body.sessionToken).toBeDefined();
      expect(response.body.deviceId).toBe(initResponse.body.deviceId);
      expect(response.body.deviceName).toBeDefined();
    });

    it('returns device public key on successful pairing', async () => {
      const initResponse = await request(app)
        .post('/api/pair/initiate')
        .send({ devicePublicKey: mockDevicePublicKey });

      const response = await request(app)
        .post('/api/pair/complete')
        .send({
          pairingCode: initResponse.body.pairingCode,
          controllerPublicKey: mockControllerPublicKey,
        });

      expect(response.status).toBe(200);
      expect(response.body.devicePublicKey).toBe(mockDevicePublicKey);
    });

    it('rejects invalid pairing code', async () => {
      const response = await request(app)
        .post('/api/pair/complete')
        .send({
          pairingCode: '000000',
          controllerPublicKey: mockControllerPublicKey,
        });

      expect(response.status).toBe(401);
      expect(response.body.error).toContain('Invalid');
    });

    it('rejects expired pairing code', async () => {
      // Create a session and manually expire it
      const initResponse = await request(app)
        .post('/api/pair/initiate')
        .send({ devicePublicKey: mockDevicePublicKey });

      // Expire the session
      pairingStore.expireSession(initResponse.body.deviceId);

      const response = await request(app)
        .post('/api/pair/complete')
        .send({
          pairingCode: initResponse.body.pairingCode,
          controllerPublicKey: mockControllerPublicKey,
        });

      expect(response.status).toBe(401);
      expect(response.body.error).toContain('expired');
    });

    it('rejects request without pairing code', async () => {
      const response = await request(app)
        .post('/api/pair/complete')
        .send({
          controllerPublicKey: mockControllerPublicKey,
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('pairingCode');
    });

    it('rejects request without controller public key', async () => {
      const initResponse = await request(app)
        .post('/api/pair/initiate')
        .send({ devicePublicKey: mockDevicePublicKey });

      const response = await request(app)
        .post('/api/pair/complete')
        .send({
          pairingCode: initResponse.body.pairingCode,
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('controllerPublicKey');
    });

    it('invalidates pairing code after use', async () => {
      const initResponse = await request(app)
        .post('/api/pair/initiate')
        .send({ devicePublicKey: mockDevicePublicKey });

      // First completion succeeds
      const response1 = await request(app)
        .post('/api/pair/complete')
        .send({
          pairingCode: initResponse.body.pairingCode,
          controllerPublicKey: mockControllerPublicKey,
        });
      expect(response1.status).toBe(200);

      // Second attempt with same code fails
      const response2 = await request(app)
        .post('/api/pair/complete')
        .send({
          pairingCode: initResponse.body.pairingCode,
          controllerPublicKey: mockControllerPublicKey,
        });
      expect(response2.status).toBe(401);
    });
  });

  describe('Rate Limiting', () => {
    it('rate limits pairing initiation attempts', async () => {
      const attempts = Array(15).fill(null).map((_, i) =>
        request(app)
          .post('/api/pair/initiate')
          .send({ devicePublicKey: mockDevicePublicKey + i })
      );

      const responses = await Promise.all(attempts);
      const rateLimited = responses.filter(r => r.status === 429);

      expect(rateLimited.length).toBeGreaterThan(0);
    });

    it('rate limits pairing completion attempts', async () => {
      const attempts = Array(20).fill(null).map(() =>
        request(app)
          .post('/api/pair/complete')
          .send({
            pairingCode: '000000',
            controllerPublicKey: mockControllerPublicKey,
          })
      );

      const responses = await Promise.all(attempts);
      const rateLimited = responses.filter(r => r.status === 429);

      expect(rateLimited.length).toBeGreaterThan(0);
    });
  });

  describe('GET /api/pair/status/:deviceId', () => {
    it('returns pairing status for valid device', async () => {
      const initResponse = await request(app)
        .post('/api/pair/initiate')
        .send({ devicePublicKey: mockDevicePublicKey });

      const response = await request(app)
        .get(`/api/pair/status/${initResponse.body.deviceId}`);

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('pending');
    });

    it('returns paired status after completion', async () => {
      const initResponse = await request(app)
        .post('/api/pair/initiate')
        .send({ devicePublicKey: mockDevicePublicKey });

      await request(app)
        .post('/api/pair/complete')
        .send({
          pairingCode: initResponse.body.pairingCode,
          controllerPublicKey: mockControllerPublicKey,
        });

      const response = await request(app)
        .get(`/api/pair/status/${initResponse.body.deviceId}`);

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('paired');
    });

    it('returns 404 for unknown device', async () => {
      const response = await request(app)
        .get('/api/pair/status/unknown-device-id');

      expect(response.status).toBe(404);
    });
  });
});
