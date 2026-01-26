import express, { Request, Response, NextFunction } from 'express';
import rateLimit, { MemoryStore } from 'express-rate-limit';
import { pairingStore } from './services/pairingStore';

export const app = express();

// Middleware
app.use(express.json());

// Rate limiter stores (exported for testing)
const initiateStore = new MemoryStore();
const completeStore = new MemoryStore();

// Rate limiters
const pairingInitiateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // 10 requests per minute
  message: { error: 'Too many pairing attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
  store: initiateStore,
});

const pairingCompleteLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 15, // 15 requests per minute
  message: { error: 'Too many pairing attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
  store: completeStore,
});

// Reset rate limiters (for testing)
export function resetRateLimiters(): void {
  initiateStore.resetAll();
  completeStore.resetAll();
}

// Health check endpoint
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: Date.now(),
  });
});

// Pairing endpoints
app.post(
  '/api/pair/initiate',
  pairingInitiateLimit,
  (req: Request, res: Response) => {
    const { devicePublicKey } = req.body;

    if (!devicePublicKey) {
      res.status(400).json({
        error: 'Missing required field: devicePublicKey',
      });
      return;
    }

    const session = pairingStore.createSession(devicePublicKey);

    res.status(201).json({
      deviceId: session.deviceId,
      pairingCode: session.pairingCode,
      qrCodeData: `android-remote://pair?code=${session.pairingCode}&device=${session.deviceId}`,
      expiresAt: session.expiresAt,
    });
  }
);

app.post(
  '/api/pair/complete',
  pairingCompleteLimit,
  (req: Request, res: Response) => {
    const { pairingCode, controllerPublicKey } = req.body;

    if (!pairingCode) {
      res.status(400).json({
        error: 'Missing required field: pairingCode',
      });
      return;
    }

    if (!controllerPublicKey) {
      res.status(400).json({
        error: 'Missing required field: controllerPublicKey',
      });
      return;
    }

    // Check if session exists and get its status
    const existingSession = pairingStore.getSessionByCode(pairingCode);
    if (!existingSession) {
      res.status(401).json({
        error: 'Invalid pairing code',
      });
      return;
    }

    if (existingSession.status === 'expired') {
      res.status(401).json({
        error: 'Pairing code has expired',
      });
      return;
    }

    if (existingSession.status === 'paired') {
      res.status(401).json({
        error: 'Invalid pairing code',
      });
      return;
    }

    const session = pairingStore.completeSession(pairingCode, controllerPublicKey);

    if (!session) {
      res.status(401).json({
        error: 'Invalid or expired pairing code',
      });
      return;
    }

    res.json({
      sessionToken: session.sessionToken,
      deviceId: session.deviceId,
      deviceName: `Android Device (${session.deviceId.slice(-6)})`,
      devicePublicKey: session.devicePublicKey,
    });
  }
);

app.get('/api/pair/status/:deviceId', (req: Request, res: Response) => {
  const { deviceId } = req.params;

  const session = pairingStore.getSessionByDeviceId(deviceId);

  if (!session) {
    res.status(404).json({
      error: 'Device not found',
    });
    return;
  }

  res.json({
    status: session.status,
    deviceId: session.deviceId,
  });
});

// Error handling middleware
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  // eslint-disable-next-line no-console
  console.error('Server error:', err);
  res.status(500).json({
    error: 'Internal server error',
  });
});
