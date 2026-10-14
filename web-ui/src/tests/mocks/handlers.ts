import { http, HttpResponse } from 'msw';

export const handlers = [
  // Short-lived WebSocket tickets (C3). Tests that care override this.
  http.post('*/api/ws-ticket', () => {
    return HttpResponse.json({ ticket: 'test-ticket', expiresAt: Date.now() + 60_000 });
  }),

  // ICE servers (C7). Default: STUN only; tests that care override this.
  http.get('*/api/ice-servers', () => {
    return HttpResponse.json({ iceServers: [{ urls: 'stun:stun.example.test:3478' }] });
  }),

  // Telemetry: nothing reported by default; tests that care override this.
  http.get('*/api/devices/:id/telemetry', ({ params }) => {
    return HttpResponse.json({ deviceId: params.id, batteryLevel: null, storageTotalBytes: null });
  }),

  // Pairing endpoints
  http.post('/api/pair/initiate', () => {
    return HttpResponse.json({
      pairingCode: '123456',
      qrCodeData: 'android-remote://pair?code=123456&key=abc123',
      expiresAt: Date.now() + 300000, // 5 minutes
    });
  }),

  http.post('/api/pair/complete', async ({ request }) => {
    const body = await request.json() as { pairingCode: string; controllerPublicKey: string };
    if (body.pairingCode === '123456') {
      return HttpResponse.json({
        sessionToken: 'valid-session-token',
        deviceId: 'device-123',
        deviceName: 'Test Device',
      });
    }
    return HttpResponse.json({ error: 'Invalid code' }, { status: 401 });
  }),

  // File browser endpoints
  http.get('/api/files', () => {
    return HttpResponse.json({
      files: [
        { name: 'photo.jpg', type: 'file', size: 1024 },
        { name: 'Documents', type: 'directory' },
      ],
    });
  }),

  http.post('/api/files/upload', () => {
    return HttpResponse.json({ success: true, message: 'Uploaded successfully' });
  }),

  http.get('/api/files/download/:filename', ({ params }) => {
    return new HttpResponse('file-content', {
      headers: {
        'Content-Disposition': `attachment; filename="${params.filename}"`,
        'Content-Type': 'application/octet-stream',
      },
    });
  }),
];
