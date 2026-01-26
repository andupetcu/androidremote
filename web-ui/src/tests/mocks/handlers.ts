import { http, HttpResponse } from 'msw';

export const handlers = [
  // Pairing endpoints
  http.post('/api/pair/initiate', () => {
    return HttpResponse.json({
      pairingCode: '123456',
      qrCodeData: 'android-remote://pair?code=123456&key=abc123',
      expiresAt: Date.now() + 300000, // 5 minutes
    });
  }),

  http.post('/api/pair/complete', async ({ request }) => {
    const body = await request.json() as { code: string };
    if (body.code === '123456') {
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
