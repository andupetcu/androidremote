import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import helmet from 'helmet';
import rateLimit, { MemoryStore } from 'express-rate-limit';
import multer from 'multer';
import { z } from 'zod';
import { pairingStore } from './services/pairingStore';
import { deviceStore } from './services/deviceStore';
import { enrollmentStore } from './services/enrollmentStore';
import { commandStore, CommandType, CommandStatus } from './services/commandStore';
import { telemetryStore, TelemetryInput } from './services/telemetryStore';
import { appInventoryStore, AppInput } from './services/appInventoryStore';
import { groupStore, GroupInput } from './services/groupStore';
import { policyStore, PolicyInput } from './services/policyStore';
import { eventStore, EventInput, DeviceEventType, EventSeverity } from './services/eventStore';
import { fileTransferStore, TransferInput } from './services/fileTransferStore';
import { auditStore, AuditInput } from './services/auditStore';
import { COMMAND_TYPES } from './db/schema';
import { LocalStorageProvider, setStorageProvider, getStorageProvider } from './services/storageProvider';
import * as appPackageStore from './services/appPackageStore';
import { syncRequiredApps, syncPolicyRequiredApps, queueSyncPolicy } from './services/appSyncService';
import { agentConnectionStore } from './services/agentConnectionStore';
import { agentBinaryStore, binariesDir } from './services/agentBinaryStore';
import { getDatabase } from './db/connection';
import { authMiddleware, adminSubject } from './middleware/auth';
import { authRouter, loginRateLimitStore } from './routes/auth';
import { telemetryRouter } from './routes/telemetry';
import { eventsRouter } from './routes/events';
import { auditRouter } from './routes/audit';
import { provisioningPublicRouter, provisioningAdminRouter } from './routes/provisioning';
import { getPublicBaseUrl } from './services/baseUrl';
import { noteDeviceSeen } from './services/devicePresence';
import { validateCommandPayload } from './services/commandPayloads';
import { parsePagination } from './routes/pagination';
import { apiGate } from './middleware/apiGate';
import { wsTicketStore, TicketPurpose } from './services/wsTicketStore';
import { settingsStore } from './services/settingsStore';
import { validateBody } from './middleware/validate';
import { HashingDiskStorage, LazyHashingDiskStorage, moveFile } from './services/uploadStorage';
import { inspectApk, isValidPackageName } from './services/apkValidator';
import { buildIceServers } from './services/iceServers';

// Initialize storage provider
const uploadsDir = path.resolve(process.env.UPLOADS_DIR || path.join(__dirname, '..', 'uploads'));
const storageProvider = new LocalStorageProvider(uploadsDir, '/api/uploads');
setStorageProvider(storageProvider);

// Configure multer for APK uploads
// The upload streams to a temp file under uploads/.incoming while its SHA-256 is computed (C6, SR-11).
const upload = multer({
  storage: new HashingDiskStorage(uploadsDir),
  limits: { fileSize: 500 * 1024 * 1024, files: 1 }, // 500MB max
  fileFilter: (_req, file, cb) => {
    if (file.originalname.endsWith('.apk')) {
      cb(null, true);
    } else {
      cb(new Error('Only APK files are allowed'));
    }
  },
});

export const app = express();

// Trust reverse proxies (nginx, load balancers, etc.)
// This makes req.protocol correctly return 'https' when behind TLS-terminating proxy.
// Set TRUST_PROXY to a specific value (e.g. "loopback", "1", "172.17.0.0/16") for
// fine-grained control. Defaults to "loopback" (trusts localhost proxies).
// Accepts a hop count ("1"), a boolean ("true"/"false") or an address/CIDR list as express does.
function parseTrustProxy(raw: string | undefined): boolean | number | string {
  if (!raw) return 'loopback';
  if (/^\d+$/.test(raw)) return parseInt(raw, 10);
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return raw;
}
app.set('trust proxy', parseTrustProxy(process.env.TRUST_PROXY));

// Security headers via helmet
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],  // Fluent UI requires inline styles
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'", "ws:", "wss:"],
      fontSrc: ["'self'", "data:"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,  // Needed for cross-origin resources on LAN
}));

// Middleware
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, etc.)
    if (!origin) {
      callback(null, true);
      return;
    }

    // Check against allowed patterns
    const allowedPatterns = [
      /^https?:\/\/localhost(:\d+)?$/,
      /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
      /^https?:\/\/192\.168\.\d+\.\d+(:\d+)?$/,  // Local network
      /^https?:\/\/10\.\d+\.\d+\.\d+(:\d+)?$/,   // Private network
      /^https?:\/\/172\.(1[6-9]|2\d|3[01])\.\d+\.\d+(:\d+)?$/, // Docker/private
    ];

    // Also allow origins from CORS_ORIGIN env var (comma-separated)
    const extraOrigins = (process.env.CORS_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);

    if (allowedPatterns.some(p => p.test(origin)) || extraOrigins.includes(origin)) {
      callback(null, true);
    } else {
      // Don't reject — just omit CORS headers. Using callback(new Error()) would
      // trigger the Express error handler and return 500, breaking same-origin
      // requests where the browser sends an Origin header (e.g. POST with JSON).
      callback(null, false);
    }
  },
  credentials: true,
}));
app.use(express.json());

// Request logging for debugging
app.use((req: Request, _res: Response, next: NextFunction) => {
  if (req.method !== 'GET' || req.path.includes('telemetry')) {
    console.log(`[HTTP] ${req.method} ${req.path}`);
  }
  next();
});

// ============================================
// Zod validation schemas
// ============================================
const commandTypeValues = COMMAND_TYPES as readonly [string, ...string[]];
const commandSchema = z.object({
  type: z.enum(commandTypeValues),
  payload: z.record(z.string(), z.unknown()).default({}),
});

const enrollDeviceSchema = z.object({
  token: z.string().min(1).max(50),
  deviceName: z.string().min(1).max(200),
  deviceModel: z.string().max(200).optional(),
  androidVersion: z.string().max(50).optional(),
  publicKey: z.string().max(5000).optional(),
  osType: z.string().max(50).optional(),
  hostname: z.string().max(200).optional(),
  arch: z.string().max(50).optional(),
  agentVersion: z.string().max(50).optional(),
});

// ============================================
// Authentication endpoints (public login; the rest check the admin token themselves)
// ============================================
app.use('/api/auth', authRouter);

// ============================================
// Auth gate for /api (see middleware/apiGate.ts): explicit public routes,
// device-token routes (contract C1), everything else needs the admin JWT.
// ============================================
app.use('/api', apiGate);

// POST /api/ws-ticket (contract C3): short-lived single-use ticket for browser WebSocket upgrades.
const WS_TICKET_PURPOSES: readonly TicketPurpose[] = ['signaling', 'admin', 'relay'];
app.post('/api/ws-ticket', (req: Request, res: Response) => {
  const { purpose, deviceId } = req.body ?? {};
  if (typeof purpose !== 'string' || !WS_TICKET_PURPOSES.includes(purpose as TicketPurpose)) {
    res.status(400).json({ error: `purpose must be one of: ${WS_TICKET_PURPOSES.join(', ')}` });
    return;
  }
  if (deviceId !== undefined && (typeof deviceId !== 'string' || deviceId.length === 0 || deviceId.length > 200)) {
    res.status(400).json({ error: 'deviceId must be a non-empty string' });
    return;
  }
  if (purpose === 'relay' && deviceId === undefined) {
    res.status(400).json({ error: 'deviceId is required for relay tickets' });
    return;
  }
  res.json(wsTicketStore.issue({ purpose: purpose as TicketPurpose, subject: adminSubject(req), deviceId }));
});

// Routers moved out of this file (SR-17): behaviour unchanged, paths relative to /api.
app.use('/api', provisioningPublicRouter, provisioningAdminRouter, telemetryRouter, eventsRouter, auditRouter);

/** Audit a command queued by an admin action (single, batch, policy-triggered). */
function auditCommandQueued(req: Request, command: { id: string; deviceId: string; type: string; payload?: Record<string, unknown> }): void {
  const details: Record<string, unknown> = { deviceId: command.deviceId, type: command.type };
  const payload = command.payload ?? {};
  if (command.type === 'RUN_SHELL' && typeof payload.command === 'string') {
    details.command = payload.command.slice(0, 500);
  }
  if (typeof payload.packageName === 'string') details.packageName = payload.packageName.slice(0, 200);
  if (command.type === 'WIPE') {
    details.confirmed = true;
    details.wipeExternalStorage = payload.wipeExternalStorage === true;
    if (typeof payload.reason === 'string') details.reason = payload.reason.slice(0, 500);
  }
  if (command.type === 'GRANT_PERMISSION') {
    if (typeof payload.permission === 'string') details.permission = payload.permission.slice(0, 200);
    if (typeof payload.state === 'string') details.state = payload.state;
  }
  if (command.type === 'SET_KIOSK') {
    details.enabled = payload.enabled;
    details.lockTask = payload.lockTask;
  }
  if (command.type === 'SET_PROTECTED_PACKAGES' && Array.isArray(payload.packages)) {
    details.packageCount = payload.packages.length;
  }
  try {
    auditStore.log({
      actorType: 'admin',
      actorId: adminSubject(req),
      action: 'command.queued',
      resourceType: 'command',
      resourceId: command.id,
      details,
      ipAddress: req.ip,
    });
  } catch (err) {
    console.error('Failed to write audit entry:', err);
  }
}

// ============================================
// Settings endpoints
// ============================================
app.get('/api/settings', (req: Request, res: Response) => {
  try {
    const settings = settingsStore.getAll();
    res.json(settings);
  } catch (err) {
    console.error('Failed to fetch settings:', err);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

app.put('/api/settings', (req: Request, res: Response) => {
  try {
    const settings = req.body;
    if (!settings || typeof settings !== 'object') {
      res.status(400).json({ error: 'Settings object is required' });
      return;
    }
    // Only allow known setting keys
    const allowedKeys = ['serverName', 'appsUpdateTime', 'updateWindowStart', 'updateWindowEnd'];
    const filtered: Record<string, string> = {};
    for (const key of allowedKeys) {
      if (settings[key] !== undefined) {
        filtered[key] = String(settings[key]);
      }
    }
    // Maintenance window for app updates (AM-08): both ends as HH:mm, or both empty to clear it.
    const hasStart = filtered.updateWindowStart !== undefined;
    const hasEnd = filtered.updateWindowEnd !== undefined;
    if (hasStart || hasEnd) {
      const clock = /^([01]\d|2[0-3]):[0-5]\d$/;
      const start = filtered.updateWindowStart ?? '';
      const end = filtered.updateWindowEnd ?? '';
      const clearing = hasStart && hasEnd && start === '' && end === '';
      if (!clearing && !(hasStart && hasEnd && clock.test(start) && clock.test(end))) {
        res.status(400).json({ error: 'updateWindowStart and updateWindowEnd must both be set as HH:mm, or both empty' });
        return;
      }
    }
    settingsStore.setMultiple(filtered);
    res.json(settingsStore.getAll());
  } catch (err) {
    console.error('Failed to update settings:', err);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

/**
 * External base URL of this server, from configuration only (SS-14). It ends up in installers, enrolment
 * responses and START_REMOTE payloads, so it must not follow the request's Host or X-Forwarded-* headers.
 * Set PUBLIC_BASE_URL (for example https://mdm.example.com). BASE_URL is accepted as an older name.
 * Without either, the URL falls back to http://localhost:<PORT>, which is only right for local development.
 */
function getBaseUrl(_req?: Request): string {
  return getPublicBaseUrl();
}

/**
 * Derive the WebSocket signaling URL from the incoming request.
 */
function getSignalingUrl(req: Request): string {
  const base = getBaseUrl(req);
  const wsUrl = base.replace(/^http/, 'ws');
  return `${wsUrl}/ws`;
}

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
  loginRateLimitStore.resetAll();
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
    const { deviceName, deviceModel, devicePublicKey } = req.body;

    // Accept either deviceName (from Android app) or devicePublicKey (legacy)
    const deviceIdentifier = devicePublicKey || deviceName || 'unknown-device';

    const session = pairingStore.createSession(deviceIdentifier);

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
  // eslint-disable-next-line no-console
  console.log(`[STATUS] Polling for deviceId: ${deviceId}`);

  const session = pairingStore.getSessionByDeviceId(deviceId);

  if (!session) {
    res.status(404).json({
      error: 'Device not found',
    });
    return;
  }

  // The session token leaves the server once, and only inside the pairing window.
  const sessionToken = session.status === 'paired' ? pairingStore.consumeSessionToken(deviceId) : null;

  // Map 'paired' status to 'completed' for Android app compatibility
  const status = session.status === 'paired' ? 'completed' : session.status;

  const response: Record<string, unknown> = {
    status,
    deviceId: session.deviceId,
  };

  // Include sessionToken and serverUrl when pairing is complete
  if (sessionToken) {
    response.sessionToken = sessionToken;
    response.serverUrl = getSignalingUrl(req);
  }

  // eslint-disable-next-line no-console
  console.log(`[STATUS] Returning:`, JSON.stringify(response));
  res.json(response);
});

// Device management endpoints

/**
 * GET /api/devices - List all enrolled devices
 */
app.get('/api/devices', (req: Request, res: Response) => {
  const all = deviceStore.getAllDevices();
  const summary = {
    online: all.filter(d => d.status === 'online').length,
    offline: all.filter(d => d.status !== 'online').length,
  };

  const search = typeof req.query.search === 'string' ? req.query.search.trim().toLowerCase() : '';
  const matching = search
    ? all.filter(d => [d.id, d.name, d.model, d.hostname, d.manufacturer, d.serialNumber]
        .some(v => typeof v === 'string' && v.toLowerCase().includes(search)))
    : all;

  // Without limit/offset the whole (filtered) list is returned, as before.
  const paged = req.query.limit !== undefined || req.query.offset !== undefined;
  const page = paged ? parsePagination(req.query, { defaultLimit: 100, maxLimit: 500 }) : null;
  const devices = page ? matching.slice(page.offset, page.offset + page.limit) : matching;

  res.json({ devices, total: matching.length, summary });
});

/**
 * GET /api/devices/:id - Get device details
 */
app.get('/api/devices/:id', (req: Request, res: Response) => {
  const { id } = req.params;
  const device = deviceStore.getDevice(id);

  if (!device) {
    res.status(404).json({ error: 'Device not found' });
    return;
  }

  const location = deviceStore.getDeviceLocation(id);
  res.json({ ...device, location });
});

/**
 * PUT /api/devices/:id - Update device details (name, location)
 */
app.put('/api/devices/:id', (req: Request, res: Response) => {
  const { id } = req.params;
  const { name, latitude, longitude } = req.body;

  const device = deviceStore.getDevice(id);
  if (!device) {
    res.status(404).json({ error: 'Device not found' });
    return;
  }

  if (name !== undefined) {
    if (typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ error: 'Name must be a non-empty string' });
      return;
    }
    deviceStore.updateDeviceName(id, name.trim());
  }

  if (latitude !== undefined || longitude !== undefined) {
    // Allow clearing location by passing null for both
    if (latitude === null && longitude === null) {
      deviceStore.updateDeviceLocation(id, null, null);
    } else if (typeof latitude === 'number' && typeof longitude === 'number' &&
               latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180) {
      deviceStore.updateDeviceLocation(id, latitude, longitude);
    } else {
      res.status(400).json({ error: 'Invalid coordinates. Latitude must be -90 to 90, longitude -180 to 180.' });
      return;
    }
  }

  const updated = deviceStore.getDevice(id);
  const location = deviceStore.getDeviceLocation(id);
  res.json({ ...updated, location });
});

/**
 * DELETE /api/devices/:id - Unenroll a device
 */
app.delete('/api/devices/:id', (req: Request, res: Response) => {
  const { id } = req.params;
  const deleted = deviceStore.unenrollDevice(id);

  if (!deleted) {
    res.status(404).json({ error: 'Device not found' });
    return;
  }

  auditStore.log({
    actorType: 'admin',
    actorId: adminSubject(req),
    action: 'device.unenrolled',
    resourceType: 'device',
    resourceId: id,
    ipAddress: req.ip,
  });

  res.json({ success: true, message: 'Device unenrolled' });
});

/**
 * GET /api/devices/:id/status - Get device online status
 */
app.get('/api/devices/:id/status', (req: Request, res: Response) => {
  const { id } = req.params;
  const device = deviceStore.getDevice(id);

  if (!device) {
    res.status(404).json({ error: 'Device not found' });
    return;
  }

  res.json({
    deviceId: device.id,
    status: device.status,
    lastSeenAt: device.lastSeenAt,
  });
});

/**
 * POST /api/devices/:id/heartbeat - Update device heartbeat (called by Android app)
 */
app.post('/api/devices/:id/heartbeat', (req: Request, res: Response) => {
  const { id } = req.params;

  // One device-online event when the device had counted as offline.
  if (!noteDeviceSeen(id)) {
    res.status(404).json({ error: 'Device not found' });
    return;
  }

  // Auto-sync apps if device has no apps yet and no pending SYNC_APPS command
  const appCount = appInventoryStore.getDeviceAppCount(id, true);
  if (appCount === 0) {
    // Existence check only: the heartbeat must never consume the device's queue (C5, SR-02).
    if (!commandStore.hasPendingOfType(id, 'SYNC_APPS')) {
      commandStore.queueCommand(id, 'SYNC_APPS', {});
    }
  }

  res.json({ success: true, timestamp: Date.now() });
});

// ============================================
// Enrollment Token Management (Admin)
// ============================================

/**
 * POST /api/enroll/tokens - Create a new enrollment token
 */
app.post('/api/enroll/tokens', (req: Request, res: Response) => {
  const { maxUses, expiresInHours } = req.body;

  const token = enrollmentStore.createToken({
    maxUses: maxUses || 1,
    expiresInMs: expiresInHours ? expiresInHours * 60 * 60 * 1000 : undefined,
  });

  auditStore.log({
    actorType: 'admin',
    actorId: adminSubject(req),
    action: 'token.created',
    resourceType: 'token',
    resourceId: token.id,
    details: { maxUses: maxUses || 1 },
    ipAddress: req.ip,
  });

  res.status(201).json(token);
});

/**
 * GET /api/enroll/tokens - List all enrollment tokens
 */
app.get('/api/enroll/tokens', (req: Request, res: Response) => {
  const { status } = req.query;
  const tokens = enrollmentStore.listTokens(
    status as 'active' | 'exhausted' | 'revoked' | 'expired' | undefined
  );
  res.json({ tokens });
});

/**
 * GET /api/enroll/tokens/:token - Look up one enrollment token by its value (admin)
 */
app.get('/api/enroll/tokens/:token', (req: Request, res: Response) => {
  const record = enrollmentStore.getTokenByValue(req.params.token);
  if (!record) {
    res.status(404).json({ error: 'Token not found' });
    return;
  }
  res.json(record);
});

/**
 * DELETE /api/enroll/tokens/:id - Revoke an enrollment token
 */
app.delete('/api/enroll/tokens/:id', (req: Request, res: Response) => {
  const { id } = req.params;
  const revoked = enrollmentStore.revokeToken(id);

  if (!revoked) {
    res.status(404).json({ error: 'Token not found or already inactive' });
    return;
  }

  auditStore.log({
    actorType: 'admin',
    actorId: adminSubject(req),
    action: 'token.revoked',
    resourceType: 'token',
    resourceId: id,
    ipAddress: req.ip,
  });

  res.json({ success: true, message: 'Token revoked' });
});

/**
 * POST /api/enroll/device - Enroll a device using a token
 */
app.post('/api/enroll/device', validateBody(enrollDeviceSchema), (req: Request, res: Response) => {
  const { token, deviceName, deviceModel, androidVersion, publicKey,
    osType, hostname, arch, agentVersion } = req.body;

  if (!token) {
    res.status(400).json({ error: 'Missing required field: token' });
    return;
  }

  if (!deviceName) {
    res.status(400).json({ error: 'Missing required field: deviceName' });
    return;
  }

  const result = enrollmentStore.enrollDevice({
    token,
    deviceName,
    deviceModel,
    androidVersion,
    publicKey,
    osType,
    hostname,
    arch,
    agentVersion,
  });

  if (!result) {
    res.status(401).json({ error: 'Invalid, expired, or exhausted enrollment token' });
    return;
  }

  // Queue SYNC_APPS so the device reports its installed apps on first connect
  commandStore.queueCommand(result.deviceId, 'SYNC_APPS', {});

  // Record enrollment event
  eventStore.recordEvent({
    deviceId: result.deviceId,
    eventType: 'device-enrolled',
    severity: 'info',
    data: { deviceName, deviceModel },
  });

  res.status(201).json({
    deviceId: result.deviceId,
    sessionToken: result.sessionToken,
    serverUrl: getBaseUrl(req),
  });
});

// ============================================
// Agent Connectivity (Cross-Platform Relay)
// ============================================

/**
 * GET /api/agent/status/:deviceId - Check if an agent is connected via relay
 */
app.get('/api/agent/status/:deviceId', authMiddleware, (req: Request, res: Response) => {
  const { deviceId } = req.params;
  const connected = agentConnectionStore.isAgentConnected(deviceId);
  const conn = agentConnectionStore.getAgent(deviceId);

  res.json({
    deviceId,
    connected,
    agentVersion: conn?.agentVersion || null,
    os: conn?.os || null,
    arch: conn?.arch || null,
    hostname: conn?.hostname || null,
    lastHeartbeat: conn?.lastHeartbeat || null,
    activeSessions: conn ? conn.activeSessions.size : 0,
  });
});

/**
 * GET /api/agent/connections - List all connected relay agents
 */
app.get('/api/agent/connections', authMiddleware, (_req: Request, res: Response) => {
  const deviceIds = agentConnectionStore.getConnectedDeviceIds();
  const connections = deviceIds.map((id) => {
    const conn = agentConnectionStore.getAgent(id);
    return {
      deviceId: id,
      agentVersion: conn?.agentVersion,
      os: conn?.os,
      arch: conn?.arch,
      hostname: conn?.hostname,
      lastHeartbeat: conn?.lastHeartbeat,
      activeSessions: conn ? conn.activeSessions.size : 0,
    };
  });

  res.json({
    count: connections.length,
    connections,
  });
});

// ============================================
// Agent Binary Distribution
// ============================================

/** Delete a rejected upload before the response goes out, so a caller that sees the 4xx/5xx never finds the temp file. */
function removeUpload(p: string): void {
  try { fs.unlinkSync(p); } catch { /* already gone */ }
}

// Configure multer for agent binary uploads
// Streamed to disk with its SHA-256 computed on the way, never held in memory.
const agentBinaryUpload = multer({
  storage: new LazyHashingDiskStorage(() => binariesDir()),
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB max
});

/**
 * GET /api/agent/latest - Get latest agent binary info for a platform
 * Query: ?os=linux&arch=x64
 */
app.get('/api/agent/latest', (req: Request, res: Response) => {
  const os = req.query.os as string;
  const arch = req.query.arch as string;

  if (!os || !arch) {
    res.status(400).json({ error: 'os and arch query parameters are required' });
    return;
  }

  const info = agentBinaryStore.getLatest(os, arch);
  if (!info) {
    res.status(404).json({ error: `no binary available for ${os}/${arch}` });
    return;
  }

  // Build download URL
  const url = `${getBaseUrl(req)}/api/agent/download/${os}/${arch}`;

  res.json({
    version: info.version,
    url,
    sha256: info.sha256,
    size: info.size,
    uploadedAt: info.uploadedAt,
  });
});

/**
 * GET /api/agent/download/:os/:arch - Download the latest agent binary
 */
app.get('/api/agent/download/:os/:arch', (req: Request, res: Response) => {
  const { os, arch } = req.params;

  const info = agentBinaryStore.getLatest(os, arch);
  if (!info) {
    res.status(404).json({ error: `no binary available for ${os}/${arch}` });
    return;
  }

  const filePath = agentBinaryStore.getBinaryPath(info);
  if (!require('fs').existsSync(filePath)) {
    res.status(404).json({ error: 'binary file not found on disk' });
    return;
  }

  const ext = os === 'windows' ? '.exe' : '';
  res.download(filePath, `android-remote-agent${ext}`);
});

/**
 * POST /api/agent/upload - Upload a new agent binary (admin only)
 * Body: multipart form with 'file', 'os', 'arch', 'version'
 */
app.post('/api/agent/upload', authMiddleware, agentBinaryUpload.single('file'), (req: Request, res: Response) => {
  const { os, arch, version } = req.body;
  const file = req.file as (Express.Multer.File & { sha256?: string }) | undefined;

  // The upload is already on disk; drop it whenever the request is refused.
  const refuse = (error: string) => {
    if (file?.path) removeUpload(file.path);
    res.status(400).json({ error });
  };

  if (!file) {
    res.status(400).json({ error: 'file is required' });
    return;
  }
  if (!os || !arch || !version) return refuse('os, arch, and version are required');

  const validOs = ['linux', 'windows'];
  const validArch = ['x64', 'arm64', 'armv7l'];
  if (!validOs.includes(os)) return refuse(`invalid os: ${os}. Must be one of: ${validOs.join(', ')}`);
  if (!validArch.includes(arch)) return refuse(`invalid arch: ${arch}. Must be one of: ${validArch.join(', ')}`);
  // The version becomes part of a file name.
  if (typeof version !== 'string' || !/^[0-9A-Za-z][0-9A-Za-z._+-]{0,49}$/.test(version)) {
    return refuse('invalid version: use letters, digits, dots, dashes and plus signs only');
  }

  try {
    const info = agentBinaryStore.addBinaryFromFile(os, arch, version, file.path, file.sha256 as string, file.size);
    res.json({ success: true, binary: info });
  } catch (err) {
    console.error('Agent binary upload failed:', err);
    removeUpload(file.path);
    res.status(500).json({ error: 'Failed to store the binary' });
  }
});

/**
 * GET /api/agent/binaries - List all uploaded agent binaries (admin)
 */
app.get('/api/agent/binaries', authMiddleware, (_req: Request, res: Response) => {
  res.json({ binaries: agentBinaryStore.listBinaries() });
});

// Rate limiter for public agent downloads
const agentDownloadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50, // 50 downloads per IP per 15 minutes
  message: { error: 'Too many download requests, please try again later' },
});

/**
 * GET /api/downloads/agent/:platform - Simple agent download for deployment scripts
 * :platform is "windows" or "linux", optional ?arch= query (defaults to x64)
 * This endpoint is public (no auth) so deployment one-liners can download directly.
 */
app.get('/api/downloads/agent/:platform', agentDownloadLimiter, (req: Request, res: Response) => {
  const { platform } = req.params;
  const arch = (req.query.arch as string) || 'x64';

  // Map platform names to os values used by agentBinaryStore
  const osMap: Record<string, string> = { windows: 'windows', linux: 'linux' };
  const os = osMap[platform];
  if (!os) {
    res.status(400).json({ error: `invalid platform: ${platform}. Use "windows" or "linux"` });
    return;
  }

  const info = agentBinaryStore.getLatest(os, arch);
  if (!info) {
    res.status(404).json({ error: `no agent binary available for ${platform}/${arch}` });
    return;
  }

  const filePath = agentBinaryStore.getBinaryPath(info);
  if (!require('fs').existsSync(filePath)) {
    res.status(404).json({ error: 'binary file not found on disk' });
    return;
  }

  const ext = platform === 'windows' ? '.exe' : '';
  res.download(filePath, `android-remote-agent${ext}`);
});

// ============================================
// Pre-Configured Installer Downloads
// ============================================

/**
 * Installer binary storage directory.
 * Upload a base NSIS installer via POST /api/agent/upload-installer,
 * or place it manually at server/data/installers/windows-x64.exe
 */
const INSTALLERS_DIR = process.env.INSTALLERS_DIR || path.join(__dirname, '..', 'data', 'installers');

/**
 * GET /api/downloads/installer/:platform - Download a pre-configured installer
 * Query: ?token=ABC123 (enrollment token value)
 *
 * For Windows: reads the base NSIS .exe and appends a JSON config trailer
 * containing the server URL and enrollment token. The NSIS script reads
 * this trailer at startup so the user doesn't need to enter anything.
 *
 * Trailer format: [original exe bytes][JSON][4-byte JSON length LE][8-byte magic "ARCFG\x00\x00\x00"]
 */
app.get('/api/downloads/installer/:platform', agentDownloadLimiter, (req: Request, res: Response) => {
  const { platform } = req.params;
  const tokenValue = req.query.token as string;

  if (!tokenValue) {
    res.status(400).json({ error: 'token query parameter is required' });
    return;
  }

  // Validate the enrollment token is active
  const tokenRecord = enrollmentStore.getTokenByValue(tokenValue);
  if (!tokenRecord) {
    res.status(404).json({ error: 'enrollment token not found' });
    return;
  }
  if (tokenRecord.status !== 'active') {
    res.status(410).json({ error: `enrollment token is ${tokenRecord.status}` });
    return;
  }

  // Determine installer file path
  const installerMap: Record<string, string> = {
    windows: 'windows-x64.exe',
  };
  const installerFile = installerMap[platform];
  if (!installerFile) {
    res.status(400).json({ error: `no installer available for platform: ${platform}. Currently only "windows" is supported.` });
    return;
  }

  const installerPath = path.join(INSTALLERS_DIR, installerFile);
  if (!require('fs').existsSync(installerPath)) {
    res.status(404).json({ error: `installer binary not found. Upload one via POST /api/agent/upload-installer or place it at data/installers/${installerFile}` });
    return;
  }

  // Read the base installer
  const baseExe = require('fs').readFileSync(installerPath) as Buffer;

  // Build the server URL from the current request
  const serverUrl = getBaseUrl(req);

  // Create JSON config trailer
  const config = JSON.stringify({ serverUrl, enrollToken: tokenValue });
  const configBuf = Buffer.from(config, 'utf-8');

  // Build trailer: [JSON bytes][4-byte length LE][8-byte magic]
  const lengthBuf = Buffer.alloc(4);
  lengthBuf.writeUInt32LE(configBuf.length, 0);

  // Magic: "ARCFG\x00\x00\x00" (8 bytes)
  const magicBuf = Buffer.alloc(8, 0);
  magicBuf.write('ARCFG', 0, 'ascii');

  const result = Buffer.concat([baseExe, configBuf, lengthBuf, magicBuf]);

  // Serve as a download
  const filename = platform === 'windows' ? 'Setup-AndroidRemote.exe' : `setup-android-remote-${platform}`;
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', result.length);
  res.send(result);
});

/**
 * POST /api/agent/upload-installer - Upload a base installer binary (admin only)
 * Body: multipart form with 'file' and 'platform' (e.g. "windows")
 */
const installerUpload = multer({
  storage: new LazyHashingDiskStorage(() => INSTALLERS_DIR),
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB max
});

app.post('/api/agent/upload-installer', authMiddleware, installerUpload.single('file'), (req: Request, res: Response) => {
  const { platform } = req.body;
  const file = req.file;

  const refuse = (error: string) => {
    if (file?.path) removeUpload(file.path);
    res.status(400).json({ error });
  };

  if (!file) {
    res.status(400).json({ error: 'file is required' });
    return;
  }
  if (!platform) return refuse('platform is required (e.g. "windows")');

  const platformMap: Record<string, string> = {
    windows: 'windows-x64.exe',
  };
  const filename = platformMap[platform];
  if (!filename) return refuse(`unsupported platform: ${platform}`);

  try {
    moveFile(file.path, path.join(INSTALLERS_DIR, filename));
  } catch (err) {
    console.error('Installer upload failed:', err);
    removeUpload(file.path);
    res.status(500).json({ error: 'Failed to store the installer' });
    return;
  }

  res.json({
    success: true,
    platform,
    filename,
    size: file.size,
  });
});

// ============================================
// Device Command Queue
// ============================================

/**
 * Server-side completion of a command payload before it is queued:
 *  - START_REMOTE gets the signaling URL (from PUBLIC_BASE_URL) and ICE servers with fresh TURN credentials (C7);
 *  - INSTALL_APK gets its sha256 (C6): from our own store when the URL points at an uploaded package, otherwise
 *    from the caller, who must supply a 64-hex value. A client-supplied hash never overrides a stored one.
 *    Policy flags (autoStart, foreground) are merged in as before.
 */
function finalizeCommandPayload(
  req: Request,
  device: { id: string; policyId?: string | null },
  type: string,
  payload: Record<string, unknown> | undefined
): { payload: Record<string, unknown> } | { error: string } {
  const checked = validateCommandPayload(type, { ...(payload || {}) }, device.id);
  if ('error' in checked) return { error: checked.error };
  const out: Record<string, unknown> = checked.payload;

  if (type === 'START_REMOTE') {
    out.signalingUrl = getSignalingUrl(req);
    out.iceServers = buildIceServers(device.id);
  }

  if (type === 'INSTALL_APK') {
    const stored = typeof out.url === 'string' ? appPackageStore.getSha256ForDownloadUrl(out.url, getBaseUrl(req)) : null;
    if (stored) {
      out.sha256 = stored;
    } else if (typeof out.sha256 === 'string' && /^[0-9a-fA-F]{64}$/.test(out.sha256)) {
      out.sha256 = out.sha256.toLowerCase();
    } else {
      return {
        error: 'INSTALL_APK requires payload.sha256 (64 hex characters) unless the url points at an APK uploaded to this server',
      };
    }

    if (device.policyId && typeof out.packageName === 'string') {
      const policy = policyStore.getPolicy(device.policyId);
      const appConfig = policy?.requiredApps?.find(
        (a: { packageName: string }) => a.packageName === out.packageName
      );
      if (appConfig) {
        out.autoStartAfterInstall = appConfig.autoStartAfterInstall || false;
        out.foregroundApp = appConfig.foregroundApp || false;
        out.autoStartOnBoot = appConfig.autoStartOnBoot || false;
      }
    }
  }

  return { payload: out };
}

/**
 * POST /api/commands - Queue a command for a device (used by web UI)
 */
app.post('/api/commands', (req: Request, res: Response) => {
  const { deviceId, type, payload } = req.body;

  if (!deviceId || typeof deviceId !== 'string') {
    res.status(400).json({ error: 'deviceId is required' });
    return;
  }

  // Validate device exists
  const device = deviceStore.getDevice(deviceId);
  if (!device) {
    res.status(404).json({ error: 'Device not found' });
    return;
  }

  // Validate command type
  if (!type || !COMMAND_TYPES.includes(type)) {
    res.status(400).json({
      error: `Invalid command type. Must be one of: ${COMMAND_TYPES.join(', ')}`,
    });
    return;
  }

  // Validate payload for specific commands
  if (type === 'INSTALL_APK') {
    if (!payload?.url || !payload?.packageName) {
      res.status(400).json({
        error: 'INSTALL_APK requires payload with url and packageName',
      });
      return;
    }
  }

  if (type === 'UNINSTALL_APP') {
    if (!payload?.packageName) {
      res.status(400).json({
        error: 'UNINSTALL_APP requires payload with packageName',
      });
      return;
    }
  }

  const prepared = finalizeCommandPayload(req, device, type, payload);
  if ('error' in prepared) {
    res.status(400).json({ error: prepared.error });
    return;
  }

  const command = commandStore.queueCommand(deviceId, type as CommandType, prepared.payload);
  auditCommandQueued(req, command);

  res.status(201).json({ command });
});

/**
 * GET /api/commands - List all commands with optional filters (used by web UI)
 */
app.get('/api/commands', (req: Request, res: Response) => {
  const { deviceId, status } = req.query;

  let commands;
  if (deviceId) {
    commands = commandStore.getCommandHistory(deviceId as string, {
      status: status as CommandStatus | undefined,
    });
  } else {
    // Get all commands (limited to recent ones for performance)
    commands = commandStore.getAllCommands();
  }

  res.json({ commands });
});

/**
 * POST /api/devices/:id/commands - Queue a command for a device
 */
app.post('/api/devices/:id/commands', (req: Request, res: Response) => {
  const { id } = req.params;
  const { type, payload } = req.body;

  // Validate device exists
  const device = deviceStore.getDevice(id);
  if (!device) {
    res.status(404).json({ error: 'Device not found' });
    return;
  }

  // Validate command type
  if (!type || !COMMAND_TYPES.includes(type)) {
    res.status(400).json({
      error: `Invalid command type. Must be one of: ${COMMAND_TYPES.join(', ')}`,
    });
    return;
  }

  // Validate payload for specific commands
  if (type === 'INSTALL_APK') {
    if (!payload?.url || !payload?.packageName) {
      res.status(400).json({
        error: 'INSTALL_APK requires payload with url and packageName',
      });
      return;
    }
  }

  if (type === 'UNINSTALL_APP') {
    if (!payload?.packageName) {
      res.status(400).json({
        error: 'UNINSTALL_APP requires payload with packageName',
      });
      return;
    }
  }

  const prepared = finalizeCommandPayload(req, device, type, payload);
  if ('error' in prepared) {
    res.status(400).json({ error: prepared.error });
    return;
  }

  const command = commandStore.queueCommand(id, type as CommandType, prepared.payload);
  auditCommandQueued(req, command);

  res.status(201).json(command);
});

/**
 * GET /api/devices/:id/commands/pending - Get pending commands for a device (device polling)
 */
app.get('/api/devices/:id/commands/pending', (req: Request, res: Response) => {
  const { id } = req.params;

  // Update last seen when device polls (and raise device-online if it had been offline)
  noteDeviceSeen(id);

  const commands = commandStore.getPendingCommands(id);

  res.json({ commands });
});

/**
 * GET /api/devices/:id/commands - Get command history for a device
 */
app.get('/api/devices/:id/commands', (req: Request, res: Response) => {
  const { id } = req.params;
  const { status } = req.query;

  const commands = commandStore.getCommandHistory(id, {
    status: status as 'pending' | 'delivered' | 'executing' | 'completed' | 'failed' | 'expired' | undefined,
    ...parsePagination(req.query),
  });

  res.json({ commands });
});

/**
 * PATCH /api/devices/:id/commands/:cmdId - Acknowledge command status
 */
app.patch('/api/devices/:id/commands/:cmdId', (req: Request, res: Response) => {
  const { id: deviceId, cmdId } = req.params;
  const { status, error } = req.body;

  const validStatuses = ['executing', 'completed', 'failed'];
  if (!status || !validStatuses.includes(status)) {
    res.status(400).json({
      error: `Invalid status. Must be one of: ${validStatuses.join(', ')}`,
    });
    return;
  }

  // Commands past their expiry turn 'expired' even if no poll has swept them yet, so the ack sees 410.
  commandStore.expireStale(deviceId);

  // The device in the URL must own the command. Another device's command looks like an unknown one.
  const command = commandStore.getCommand(cmdId);
  if (!command || command.deviceId !== deviceId) {
    res.status(404).json({ error: 'Command not found' });
    return;
  }

  // The device treats any 4xx other than 401 as permanent, so terminal states answer 409/410.
  const current = command.status as string;
  if (current === 'expired') {
    res.status(410).json({ error: 'Command expired', status: current });
    return;
  }
  if (current === 'completed' || current === 'failed') {
    res.status(409).json({ error: `Command already ${current}`, status: current });
    return;
  }
  // A retried "executing" ack after a lost response is not an error.
  if (status === 'executing' && current === 'executing') {
    res.json({ success: true, commandId: cmdId, status });
    return;
  }

  const updated = commandStore.acknowledgeCommand(
    cmdId,
    status as 'executing' | 'completed' | 'failed',
    error,
    deviceId
  );

  if (!updated) {
    res.status(409).json({ error: 'Command is no longer awaiting an acknowledgement' });
    return;
  }

  // Generate command completion/failure events
  if (status === 'completed' && command) {
    eventStore.recordEvent({
      deviceId,
      eventType: 'command-completed',
      severity: 'info',
      data: { commandType: command.type, commandId: cmdId },
    });

    // Policy-synced event for SYNC_POLICY commands
    if (command.type === 'SYNC_POLICY') {
      eventStore.recordEvent({
        deviceId,
        eventType: 'policy-synced',
        severity: 'info',
        data: { commandId: cmdId },
      });
    }
  } else if (status === 'failed' && command) {
    eventStore.recordEvent({
      deviceId,
      eventType: 'command-failed',
      severity: 'warning',
      data: { commandType: command.type, commandId: cmdId, error },
    });
  }

  res.json({ success: true, commandId: cmdId, status });
});

/**
 * DELETE /api/devices/:id/commands/:cmdId - Cancel a pending command
 */
app.delete('/api/devices/:id/commands/:cmdId', (req: Request, res: Response) => {
  const { id: deviceId, cmdId } = req.params;

  const cancelled = commandStore.cancelCommand(cmdId, deviceId);

  if (!cancelled) {
    res.status(404).json({ error: 'Command not found or not pending' });
    return;
  }

  res.json({ success: true, message: 'Command cancelled' });
});

// ============================================
// Phase 2: Application Inventory
// ============================================

/**
 * POST /api/devices/:id/apps - Device reports installed apps
 */
app.post('/api/devices/:id/apps', (req: Request, res: Response) => {
  const { id } = req.params;
  const { apps } = req.body;

  const device = deviceStore.getDevice(id);
  if (!device) {
    res.status(404).json({ error: 'Device not found' });
    return;
  }

  if (!Array.isArray(apps)) {
    res.status(400).json({ error: 'apps must be an array' });
    return;
  }

  appInventoryStore.syncDeviceApps(id, apps as AppInput[]);
  deviceStore.updateLastSeen(id);

  res.json({ success: true, appCount: apps.length });
});

/**
 * GET /api/devices/:id/apps - Get installed apps for device
 */
app.get('/api/devices/:id/apps', (req: Request, res: Response) => {
  const { id } = req.params;
  const { systemApps, search } = req.query;

  const apps = appInventoryStore.getDeviceApps(id, {
    includeSystemApps: systemApps === 'true',
    search: search as string | undefined,
  });

  res.json({ apps, count: apps.length });
});

/**
 * GET /api/apps - Get app catalog
 */
app.get('/api/apps', (req: Request, res: Response) => {
  const { approved, blocked, search, limit, offset } = req.query;

  const catalog = appInventoryStore.getCatalog({
    approved: approved !== undefined ? approved === 'true' : undefined,
    blocked: blocked !== undefined ? blocked === 'true' : undefined,
    search: search as string | undefined,
    limit: limit ? parseInt(limit as string, 10) : undefined,
    offset: offset ? parseInt(offset as string, 10) : undefined,
  });

  res.json({ apps: catalog, count: catalog.length });
});

// ============================================
// ICE servers (C7)
// ============================================

/**
 * GET /api/ice-servers - STUN/TURN list with short-lived TURN credentials. Admin JWT or device session token.
 */
app.get('/api/ice-servers', (req: Request, res: Response) => {
  const id: string = typeof res.locals.deviceId === 'string' ? res.locals.deviceId : adminSubject(req);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ iceServers: buildIceServers(id) });
});

// ============================================
// Uploaded APK downloads: admin JWT or an enrolled device's session token (checked in apiGate)
// ============================================

app.get(/^\/api\/uploads\/(.+)$/, (req: Request, res: Response) => {
  let relative: string;
  try {
    relative = decodeURIComponent(req.params[0]);
  } catch {
    res.status(400).json({ error: 'Bad path' });
    return;
  }
  let full: string;
  try {
    // Only stored APKs are served; the temp upload directory and anything outside the root are not.
    if (!relative.startsWith('apks/')) throw new Error('not an apk path');
    full = storageProvider.resolveSafe(relative);
  } catch {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  res.sendFile(full, { dotfiles: 'deny' }, err => {
    if (err && !res.headersSent) res.status(404).json({ error: 'Not found' });
  });
});

// ============================================
// App Packages (APK Upload & Install)
// IMPORTANT: These routes must come BEFORE /api/apps/:packageName
// to avoid "packages" being matched as a packageName parameter
// ============================================

/**
 * GET /api/apps/packages - List uploaded APK packages
 */
app.get('/api/apps/packages', (_req: Request, res: Response) => {
  const packages = appPackageStore.listAppPackages();
  res.json({ packages });
});

/**
 * GET /api/apps/:packageName - Get app catalog entry
 */
app.get('/api/apps/:packageName', (req: Request, res: Response) => {
  const { packageName } = req.params;

  const entry = appInventoryStore.getCatalogEntry(packageName);
  if (!entry) {
    res.status(404).json({ error: 'App not found in catalog' });
    return;
  }

  // Get devices with this app
  const deviceIds = appInventoryStore.getDevicesWithApp(packageName);

  res.json({ ...entry, installedOn: deviceIds });
});

/**
 * PUT /api/apps/:packageName - Update app catalog entry
 */
app.put('/api/apps/:packageName', (req: Request, res: Response) => {
  const { packageName } = req.params;
  const { isApproved, isBlocked, notes, category } = req.body;

  const entry = appInventoryStore.updateCatalogEntry(packageName, {
    isApproved,
    isBlocked,
    notes,
    category,
  });

  if (!entry) {
    res.status(404).json({ error: 'App not found in catalog' });
    return;
  }

  // Audit log
  auditStore.log({
    actorType: 'admin',
    action: isBlocked ? 'app.blocked' : 'app.approved',
    resourceType: 'app',
    resourceId: packageName,
    details: { isApproved, isBlocked },
  });

  res.json(entry);
});

/**
 * POST /api/apps/upload - Upload an APK file
 */
// multer errors (size limit, rejected file name) become JSON 4xx instead of the generic error handler's 500.
function uploadApk(req: Request, res: Response, next: NextFunction): void {
  upload.single('file')(req, res, (err: unknown) => {
    if (!err) return next();
    const code = (err as { code?: string }).code;
    if (code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ error: 'APK is larger than the 500 MB limit' });
    } else {
      res.status(400).json({ error: (err as Error).message || 'Invalid upload' });
    }
  });
}

app.post('/api/apps/upload', uploadApk, async (req: Request, res: Response) => {
  // The file is already on disk (uploads/.incoming/...) with its sha256 computed. Whatever happens, it must
  // end up either stored under apks/ or deleted.
  const file = req.file as (Express.Multer.File & { sha256?: string }) | undefined;
  const tempPath = file?.path;
  let storedPath: string | undefined;
  const cleanup = async () => {
    if (storedPath) await getStorageProvider().delete(storedPath).catch(() => undefined);
    if (tempPath) await fs.promises.unlink(tempPath).catch(() => undefined);
  };

  try {
    if (!file || !tempPath || !file.sha256) {
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }

    const { packageName, appName, versionName, versionCode } = req.body;

    if (!isValidPackageName(packageName)) {
      await cleanup();
      res.status(400).json({ error: 'packageName is required and must look like com.example.app' });
      return;
    }

    const apk = await inspectApk(tempPath);
    if (!apk.ok) {
      await cleanup();
      res.status(400).json({ error: apk.reason });
      return;
    }

    // Generate unique filename. packageName matches the package-name pattern, so it has no path separators;
    // the storage provider checks containment again.
    const timestamp = Date.now();
    const filename = `apks/${packageName}-${timestamp}.apk`;

    const storage = getStorageProvider();
    const filePath = await storage.adopt(tempPath, filename);
    storedPath = filePath;

    // Check if package already exists
    const existing = appPackageStore.getAppPackageByName(packageName);
    const parsedVersionCode = versionCode ? parseInt(versionCode, 10) : undefined;

    // Package row and version history change together or not at all.
    const pkg = appPackageStore.runInTransaction(() => {
      if (existing) {
        // Save old version to version history before overwriting
        appPackageStore.createVersion(existing.id, {
          versionName: existing.versionName || undefined,
          versionCode: existing.versionCode || undefined,
          filePath: existing.filePath,
          fileSize: existing.fileSize || undefined,
          sha256: existing.sha256,
        });
        // Update the active entry (don't delete old file: it is now referenced by the version record)
        return appPackageStore.updateAppPackage(packageName, {
          appName,
          versionName,
          versionCode: parsedVersionCode,
          fileSize: file.size,
          filePath,
          sha256: file.sha256,
        });
      }
      return appPackageStore.createAppPackage({
        packageName,
        appName,
        versionName,
        versionCode: parsedVersionCode,
        fileSize: file.size,
        filePath,
        sha256: file.sha256,
      });
    });
    storedPath = undefined; // now referenced by the database

    auditStore.log({
      actorType: 'admin',
      action: existing ? 'app.updated' : 'app.uploaded',
      resourceType: 'app',
      resourceId: packageName,
      details: { versionName, fileSize: file.size, sha256: file.sha256 },
    });

    res.status(201).json(pkg);
  } catch (err) {
    console.error('Upload error:', err);
    await cleanup();
    res.status(500).json({ error: 'Failed to upload APK' });
  }
});

/**
 * GET /api/apps/packages/:packageName - Get package details
 */
app.get('/api/apps/packages/:packageName', (req: Request, res: Response) => {
  const { packageName } = req.params;

  const pkg = appPackageStore.getAppPackageByName(packageName);
  if (!pkg) {
    res.status(404).json({ error: 'Package not found' });
    return;
  }

  res.json(pkg);
});

/**
 * GET /api/apps/packages/:packageName/versions - List version history for a package
 */
app.get('/api/apps/packages/:packageName/versions', (req: Request, res: Response) => {
  const { packageName } = req.params;

  const pkg = appPackageStore.getAppPackageByName(packageName);
  if (!pkg) {
    res.status(404).json({ error: 'Package not found' });
    return;
  }

  const versions = appPackageStore.listVersions(pkg.id);
  res.json({ versions });
});

/**
 * DELETE /api/apps/packages/:packageName - Delete an uploaded package
 */
app.delete('/api/apps/packages/:packageName', async (req: Request, res: Response) => {
  const { packageName } = req.params;

  // Delete version history files first
  const pkg = appPackageStore.getAppPackageByName(packageName);
  if (pkg) {
    const versions = appPackageStore.listVersions(pkg.id);
    const storage = getStorageProvider();
    for (const v of versions) {
      await storage.delete(v.filePath);
    }
  }

  const deleted = await appPackageStore.deleteAppPackage(packageName);
  if (!deleted) {
    res.status(404).json({ error: 'Package not found' });
    return;
  }

  auditStore.log({
    actorType: 'admin',
    action: 'app.deleted',
    resourceType: 'app',
    resourceId: packageName,
  });

  res.json({ success: true });
});

/**
 * POST /api/apps/packages/:packageName/install - Install package on devices
 */
app.post('/api/apps/packages/:packageName/install', (req: Request, res: Response) => {
  const { packageName } = req.params;
  const { deviceIds } = req.body;

  const pkg = appPackageStore.getAppPackageByName(packageName);
  if (!pkg) {
    res.status(404).json({ error: 'Package not found' });
    return;
  }

  if (!Array.isArray(deviceIds) || deviceIds.length === 0) {
    res.status(400).json({ error: 'deviceIds array is required' });
    return;
  }

  const sha256 = appPackageStore.ensurePackageSha256(pkg);
  if (!sha256) {
    res.status(500).json({ error: 'APK file for this package is missing or unreadable' });
    return;
  }

  const commands = [];
  for (const deviceId of deviceIds) {
    const device = deviceStore.getDevice(deviceId);
    if (device) {
      // Enrich with policy settings if device has a policy with this app configured
      const installPayload: Record<string, unknown> = {
        url: pkg.downloadUrl,
        packageName: pkg.packageName,
        sha256,
        appName: pkg.appName,
        versionName: pkg.versionName,
      };
      if (device.policyId) {
        const policy = policyStore.getPolicy(device.policyId);
        const appConfig = policy?.requiredApps?.find(
          (a: { packageName: string }) => a.packageName === pkg.packageName
        );
        if (appConfig) {
          installPayload.autoStartAfterInstall = appConfig.autoStartAfterInstall || false;
          installPayload.foregroundApp = appConfig.foregroundApp || false;
          installPayload.autoStartOnBoot = appConfig.autoStartOnBoot || false;
        }
      }

      const cmd = commandStore.queueCommand(deviceId, 'INSTALL_APK', installPayload);
      commands.push(cmd);
      auditCommandQueued(req, cmd);

      auditStore.log({
        actorType: 'admin',
        action: 'command.queued',
        resourceType: 'command',
        resourceId: cmd.id,
        details: { deviceId, type: 'INSTALL_APK', packageName },
      });
    }
  }

  res.json({ success: true, commands, queued: commands.length });
});

/**
 * POST /api/apps/packages/:packageName/deploy - Deploy latest version to all devices (or filtered)
 */
app.post('/api/apps/packages/:packageName/deploy', (req: Request, res: Response) => {
  const { packageName } = req.params;
  const { deviceIds } = req.body; // optional: specific device IDs

  const pkg = appPackageStore.getAppPackageByName(packageName);
  if (!pkg) {
    res.status(404).json({ error: 'Package not found' });
    return;
  }

  // If no deviceIds specified, deploy to all devices
  let targets: string[];
  if (Array.isArray(deviceIds) && deviceIds.length > 0) {
    targets = deviceIds;
  } else {
    targets = deviceStore.getAllDevices().map(d => d.id);
  }

  const sha256 = appPackageStore.ensurePackageSha256(pkg);
  if (!sha256) {
    res.status(500).json({ error: 'APK file for this package is missing or unreadable' });
    return;
  }

  const commands = [];
  for (const deviceId of targets) {
    const device = deviceStore.getDevice(deviceId);
    if (device) {
      // Enrich with policy settings if device has a policy with this app configured
      const installPayload: Record<string, unknown> = {
        url: pkg.downloadUrl,
        packageName: pkg.packageName,
        sha256,
        appName: pkg.appName,
        versionName: pkg.versionName,
      };
      if (device.policyId) {
        const policy = policyStore.getPolicy(device.policyId);
        const appConfig = policy?.requiredApps?.find(
          (a: { packageName: string }) => a.packageName === pkg.packageName
        );
        if (appConfig) {
          installPayload.autoStartAfterInstall = appConfig.autoStartAfterInstall || false;
          installPayload.foregroundApp = appConfig.foregroundApp || false;
          installPayload.autoStartOnBoot = appConfig.autoStartOnBoot || false;
        }
      }

      const cmd = commandStore.queueCommand(deviceId, 'INSTALL_APK', installPayload);
      commands.push(cmd);
      auditCommandQueued(req, cmd);
    }
  }

  auditStore.log({
    actorType: 'admin',
    action: 'app.deployed',
    resourceType: 'app',
    resourceId: packageName,
    details: { deviceCount: commands.length, versionName: pkg.versionName },
  });

  res.json({ success: true, queued: commands.length });
});

/**
 * GET /api/devices/:id/app-updates - Check which installed apps have newer uploaded versions
 */
app.get('/api/devices/:id/app-updates', (req: Request, res: Response) => {
  const { id } = req.params;

  const device = deviceStore.getDevice(id);
  if (!device) {
    res.status(404).json({ error: 'Device not found' });
    return;
  }

  // Get all uploaded packages
  const packages = appPackageStore.listAppPackages();

  // Get device's installed apps
  const updates: Array<{
    packageName: string;
    currentVersionCode: number | null;
    currentVersionName: string | null;
    latestVersionCode: number | null;
    latestVersionName: string | null;
    apkUrl: string | undefined;
    sha256: string | null;
  }> = [];

  for (const pkg of packages) {
    const installed = appInventoryStore.getDeviceApp(id, pkg.packageName);
    if (!installed) continue;

    // Compare version codes if both available
    const installedCode = installed.versionCode;
    const latestCode = pkg.versionCode;

    if (latestCode != null && installedCode != null && latestCode > installedCode) {
      updates.push({
        packageName: pkg.packageName,
        currentVersionCode: installedCode,
        currentVersionName: installed.versionName,
        latestVersionCode: latestCode,
        latestVersionName: pkg.versionName,
        apkUrl: pkg.downloadUrl,
        sha256: appPackageStore.ensurePackageSha256(pkg),
      });
    }
  }

  res.json({ updates });
});

/**
 * POST /api/commands/batch - Queue the same command to multiple devices
 */
app.post('/api/commands/batch', (req: Request, res: Response) => {
  const { deviceIds, type, payload } = req.body;

  if (!Array.isArray(deviceIds) || deviceIds.length === 0) {
    res.status(400).json({ error: 'deviceIds array is required' });
    return;
  }

  if (!type) {
    res.status(400).json({ error: 'type is required' });
    return;
  }

  const commands = [];
  const errors: string[] = [];

  for (const deviceId of deviceIds) {
    const device = deviceStore.getDevice(deviceId);
    if (!device) {
      errors.push(`Device ${deviceId} not found`);
      continue;
    }
    try {
      const prepared = finalizeCommandPayload(req, device, type, payload);
      if ('error' in prepared) {
        errors.push(`Device ${deviceId}: ${prepared.error}`);
        continue;
      }
      const cmd = commandStore.queueCommand(deviceId, type, prepared.payload);
      commands.push(cmd);
      auditCommandQueued(req, cmd);
    } catch {
      errors.push(`Failed to queue command for device ${deviceId}`);
    }
  }

  auditStore.log({
    actorType: 'admin',
    action: 'command.batch_queued',
    resourceType: 'command',
    details: { type, deviceCount: commands.length, errorCount: errors.length },
  });

  res.json({ success: true, queued: commands.length, errors });
});

// ============================================
// Phase 3: Groups
// ============================================

/**
 * GET /api/groups - List all groups
 */
app.get('/api/groups', (_req: Request, res: Response) => {
  const groups = groupStore.getAllGroups();
  res.json({ groups });
});

/**
 * POST /api/groups - Create group
 */
app.post('/api/groups', (req: Request, res: Response) => {
  const { name, description, policyId, parentGroupId } = req.body;

  if (!name) {
    res.status(400).json({ error: 'name is required' });
    return;
  }

  // Check if name already exists
  if (groupStore.getGroupByName(name)) {
    res.status(409).json({ error: 'Group name already exists' });
    return;
  }

  const group = groupStore.createGroup({
    name,
    description,
    policyId,
    parentGroupId,
  });

  auditStore.log({
    actorType: 'admin',
    action: 'group.created',
    resourceType: 'group',
    resourceId: group.id,
    details: { name },
  });

  res.status(201).json(group);
});

/**
 * GET /api/groups/:id - Get group details
 */
app.get('/api/groups/:id', (req: Request, res: Response) => {
  const { id } = req.params;

  const group = groupStore.getGroup(id);
  if (!group) {
    res.status(404).json({ error: 'Group not found' });
    return;
  }

  const deviceIds = groupStore.getGroupDevices(id);
  const childGroups = groupStore.getChildGroups(id);

  res.json({ ...group, deviceIds, childGroups });
});

/**
 * PUT /api/groups/:id - Update group
 */
app.put('/api/groups/:id', (req: Request, res: Response) => {
  const { id } = req.params;
  const { name, description, policyId, parentGroupId } = req.body;

  const group = groupStore.updateGroup(id, {
    name,
    description,
    policyId,
    parentGroupId,
  });

  if (!group) {
    res.status(404).json({ error: 'Group not found' });
    return;
  }

  auditStore.log({
    actorType: 'admin',
    action: 'group.updated',
    resourceType: 'group',
    resourceId: id,
    details: { name, policyId },
  });

  res.json(group);
});

/**
 * DELETE /api/groups/:id - Delete group
 */
app.delete('/api/groups/:id', (req: Request, res: Response) => {
  const { id } = req.params;

  const deleted = groupStore.deleteGroup(id);
  if (!deleted) {
    res.status(404).json({ error: 'Group not found' });
    return;
  }

  auditStore.log({
    actorType: 'admin',
    action: 'group.deleted',
    resourceType: 'group',
    resourceId: id,
  });

  res.json({ success: true });
});

/**
 * GET /api/groups/:id/devices - Get devices in group
 */
app.get('/api/groups/:id/devices', (req: Request, res: Response) => {
  const { id } = req.params;

  const group = groupStore.getGroup(id);
  if (!group) {
    res.status(404).json({ error: 'Group not found' });
    return;
  }

  const deviceIds = groupStore.getGroupDevices(id);
  const devices = deviceIds.map(did => deviceStore.getDevice(did)).filter(Boolean);

  res.json({ devices });
});

/**
 * POST /api/groups/:id/devices - Add devices to group
 */
app.post('/api/groups/:id/devices', (req: Request, res: Response) => {
  const { id } = req.params;
  const { deviceIds } = req.body;

  const group = groupStore.getGroup(id);
  if (!group) {
    res.status(404).json({ error: 'Group not found' });
    return;
  }

  if (!Array.isArray(deviceIds)) {
    res.status(400).json({ error: 'deviceIds must be an array' });
    return;
  }

  let added = 0;
  for (const deviceId of deviceIds) {
    if (groupStore.addDeviceToGroup(id, deviceId)) {
      added++;
      auditStore.log({
        actorType: 'admin',
        action: 'group.device_added',
        resourceType: 'group',
        resourceId: id,
        details: { deviceId },
      });
    }
  }

  res.json({ success: true, added });
});

/**
 * DELETE /api/groups/:id/devices/:deviceId - Remove device from group
 */
app.delete('/api/groups/:id/devices/:deviceId', (req: Request, res: Response) => {
  const { id, deviceId } = req.params;

  const removed = groupStore.removeDeviceFromGroup(id, deviceId);
  if (!removed) {
    res.status(404).json({ error: 'Device not in group' });
    return;
  }

  auditStore.log({
    actorType: 'admin',
    action: 'group.device_removed',
    resourceType: 'group',
    resourceId: id,
    details: { deviceId },
  });

  res.json({ success: true });
});

// ============================================
// Phase 3: Policies
// ============================================

/**
 * GET /api/policies - List all policies
 */
app.get('/api/policies', (_req: Request, res: Response) => {
  const policies = policyStore.getAllPolicies();
  res.json({ policies });
});

/**
 * POST /api/policies - Create policy
 * Translates frontend field names to server field names
 */
app.post('/api/policies', (req: Request, res: Response) => {
  try {
    const body = req.body;

    if (!body.name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }

    // Translate frontend field names to server field names
    const input: PolicyInput = {
      name: body.name,
      description: body.description,
      priority: body.priority ?? 0,
      kioskMode: body.kioskMode,
      kioskPackage: body.kioskPackage,
      kioskExitPassword: body.kioskExitPassword,
      // Frontend uses allowedApps/blockedApps, server uses appWhitelist/appBlacklist
      appWhitelist: body.appWhitelist ?? body.allowedApps,
      appBlacklist: body.appBlacklist ?? body.blockedApps,
      // Frontend uses playStoreEnabled/unknownSourcesEnabled
      allowPlayStore: body.allowPlayStore ?? body.playStoreEnabled,
      allowUnknownSources: body.allowUnknownSources ?? body.unknownSourcesEnabled,
      passwordRequired: body.passwordRequired,
      passwordMinLength: body.passwordMinLength,
      passwordRequireNumeric: body.passwordRequireNumeric,
      passwordRequireSymbol: body.passwordRequireSymbol,
      maxPasswordAge: body.maxPasswordAge,
      maxFailedAttempts: body.maxFailedAttempts,
      lockAfterInactivity: body.lockAfterInactivity,
      encryptionRequired: body.encryptionRequired,
      cameraEnabled: body.cameraEnabled,
      microphoneEnabled: body.microphoneEnabled,
      bluetoothEnabled: body.bluetoothEnabled,
      wifiEnabled: body.wifiEnabled,
      nfcEnabled: body.nfcEnabled,
      usbEnabled: body.usbEnabled,
      sdCardEnabled: body.sdCardEnabled,
      vpnRequired: body.vpnRequired,
      vpnPackage: body.vpnPackage,
      allowedWifiSsids: body.allowedWifiSsids,
      adbEnabled: body.adbEnabled,
      developerOptionsEnabled: body.developerOptionsEnabled,
      // Frontend uses factoryResetEnabled/otaUpdatesEnabled
      allowFactoryReset: body.allowFactoryReset ?? body.factoryResetEnabled,
      allowOtaUpdates: body.allowOtaUpdates ?? body.otaUpdatesEnabled,
      allowDateTimeChange: body.allowDateTimeChange,
      requiredApps: body.requiredApps,
      isDefault: body.isDefault,
    };

    const policy = policyStore.createPolicy(input);

    auditStore.log({
      actorType: 'admin',
      action: 'policy.created',
      resourceType: 'policy',
      resourceId: policy.id,
      details: { name: input.name },
    });

    res.status(201).json(policy);
  } catch (err) {
    console.error('Failed to create policy:', err);
    res.status(500).json({ error: 'Failed to create policy', details: String(err) });
  }
});

/**
 * GET /api/policies/:id - Get policy details
 */
app.get('/api/policies/:id', (req: Request, res: Response) => {
  const { id } = req.params;

  const policy = policyStore.getPolicy(id);
  if (!policy) {
    res.status(404).json({ error: 'Policy not found' });
    return;
  }

  // Get devices and groups using this policy
  const devices = deviceStore.getDevicesByPolicy(id);

  res.json({ ...policy, deviceCount: devices.length });
});

/**
 * PUT /api/policies/:id - Update policy
 * Translates frontend field names to server field names
 */
app.put('/api/policies/:id', (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const body = req.body;

    // Translate frontend field names to server field names
    const input: Partial<PolicyInput> = {};

    // Copy directly compatible fields
    if (body.name !== undefined) input.name = body.name;
    if (body.description !== undefined) input.description = body.description;
    if (body.priority !== undefined) input.priority = body.priority;
    if (body.kioskMode !== undefined) input.kioskMode = body.kioskMode;
    if (body.kioskPackage !== undefined) input.kioskPackage = body.kioskPackage;
    if (body.kioskExitPassword !== undefined) input.kioskExitPassword = body.kioskExitPassword;

    // Translate allowedApps/blockedApps to appWhitelist/appBlacklist
    if (body.appWhitelist !== undefined) input.appWhitelist = body.appWhitelist;
    else if (body.allowedApps !== undefined) input.appWhitelist = body.allowedApps;
    if (body.appBlacklist !== undefined) input.appBlacklist = body.appBlacklist;
    else if (body.blockedApps !== undefined) input.appBlacklist = body.blockedApps;

    // Translate playStoreEnabled/unknownSourcesEnabled
    if (body.allowPlayStore !== undefined) input.allowPlayStore = body.allowPlayStore;
    else if (body.playStoreEnabled !== undefined) input.allowPlayStore = body.playStoreEnabled;
    if (body.allowUnknownSources !== undefined) input.allowUnknownSources = body.allowUnknownSources;
    else if (body.unknownSourcesEnabled !== undefined) input.allowUnknownSources = body.unknownSourcesEnabled;

    // Security fields
    if (body.passwordRequired !== undefined) input.passwordRequired = body.passwordRequired;
    if (body.passwordMinLength !== undefined) input.passwordMinLength = body.passwordMinLength;
    if (body.passwordRequireNumeric !== undefined) input.passwordRequireNumeric = body.passwordRequireNumeric;
    if (body.passwordRequireSymbol !== undefined) input.passwordRequireSymbol = body.passwordRequireSymbol;
    if (body.maxPasswordAge !== undefined) input.maxPasswordAge = body.maxPasswordAge;
    if (body.maxFailedAttempts !== undefined) input.maxFailedAttempts = body.maxFailedAttempts;
    if (body.lockAfterInactivity !== undefined) input.lockAfterInactivity = body.lockAfterInactivity;
    if (body.encryptionRequired !== undefined) input.encryptionRequired = body.encryptionRequired;

    // Hardware fields
    if (body.cameraEnabled !== undefined) input.cameraEnabled = body.cameraEnabled;
    if (body.microphoneEnabled !== undefined) input.microphoneEnabled = body.microphoneEnabled;
    if (body.bluetoothEnabled !== undefined) input.bluetoothEnabled = body.bluetoothEnabled;
    if (body.wifiEnabled !== undefined) input.wifiEnabled = body.wifiEnabled;
    if (body.nfcEnabled !== undefined) input.nfcEnabled = body.nfcEnabled;
    if (body.usbEnabled !== undefined) input.usbEnabled = body.usbEnabled;
    if (body.sdCardEnabled !== undefined) input.sdCardEnabled = body.sdCardEnabled;

    // Network fields
    if (body.vpnRequired !== undefined) input.vpnRequired = body.vpnRequired;
    if (body.vpnPackage !== undefined) input.vpnPackage = body.vpnPackage;
    if (body.allowedWifiSsids !== undefined) input.allowedWifiSsids = body.allowedWifiSsids;

    // Development fields
    if (body.adbEnabled !== undefined) input.adbEnabled = body.adbEnabled;
    if (body.developerOptionsEnabled !== undefined) input.developerOptionsEnabled = body.developerOptionsEnabled;

    // System fields - translate factoryResetEnabled/otaUpdatesEnabled
    if (body.allowFactoryReset !== undefined) input.allowFactoryReset = body.allowFactoryReset;
    else if (body.factoryResetEnabled !== undefined) input.allowFactoryReset = body.factoryResetEnabled;
    if (body.allowOtaUpdates !== undefined) input.allowOtaUpdates = body.allowOtaUpdates;
    else if (body.otaUpdatesEnabled !== undefined) input.allowOtaUpdates = body.otaUpdatesEnabled;
    if (body.allowDateTimeChange !== undefined) input.allowDateTimeChange = body.allowDateTimeChange;

    // Required apps
    if (body.requiredApps !== undefined) input.requiredApps = body.requiredApps;

    // Default policy
    if (body.isDefault !== undefined) input.isDefault = body.isDefault;

    // Sound/Notifications
    if (body.silentMode !== undefined) input.silentMode = body.silentMode;

    const policy = policyStore.updatePolicy(id, input);
    if (!policy) {
      res.status(404).json({ error: 'Policy not found' });
      return;
    }

    // Sync required apps to all devices if requiredApps changed
    let commandsQueued = 0;
    if (input.requiredApps !== undefined) {
      commandsQueued = syncPolicyRequiredApps(id);
    }

    // Sync policy settings to all devices with this policy
    // Always send full policy when relevant settings change
    if (input.silentMode !== undefined || input.requiredApps !== undefined || input.kioskMode !== undefined) {
      for (const deviceId of policyStore.getDeviceIdsForPolicy(id)) {
        auditCommandQueued(req, queueSyncPolicy(deviceId, policy));
        commandsQueued++;
      }
    }

    auditStore.log({
      actorType: 'admin',
      action: 'policy.updated',
      resourceType: 'policy',
      resourceId: id,
      details: { ...input, commandsQueued },
    });

    res.json({ ...policy, commandsQueued });
  } catch (err) {
    console.error('Failed to update policy:', err);
    res.status(500).json({ error: 'Failed to update policy', details: String(err) });
  }
});

/**
 * DELETE /api/policies/:id - Delete policy
 */
app.delete('/api/policies/:id', (req: Request, res: Response) => {
  const { id } = req.params;

  const deleted = policyStore.deletePolicy(id);
  if (!deleted) {
    res.status(404).json({ error: 'Policy not found' });
    return;
  }

  auditStore.log({
    actorType: 'admin',
    action: 'policy.deleted',
    resourceType: 'policy',
    resourceId: id,
  });

  res.json({ success: true });
});

/**
 * GET /api/devices/:id/policy - Get effective policy for device
 */
app.get('/api/devices/:id/policy', (req: Request, res: Response) => {
  const { id } = req.params;

  const device = deviceStore.getDevice(id);
  if (!device) {
    res.status(404).json({ error: 'Device not found' });
    return;
  }

  // Check direct policy assignment
  if (device.policyId) {
    const policy = policyStore.getPolicy(device.policyId);
    if (policy) {
      res.json({ policy, source: 'device' });
      return;
    }
  }

  // Check group policy
  const groups = groupStore.getDeviceGroups(id);
  for (const group of groups.sort((a, b) => (b.policyId ? 1 : 0) - (a.policyId ? 1 : 0))) {
    if (group.policyId) {
      const policy = policyStore.getPolicy(group.policyId);
      if (policy) {
        res.json({ policy, source: 'group', groupId: group.id, groupName: group.name });
        return;
      }
    }
  }

  // Default policy
  const defaultPolicy = policyStore.getDefaultPolicy();
  if (defaultPolicy) {
    res.json({ policy: defaultPolicy, source: 'default' });
    return;
  }

  res.json({ policy: null, source: 'none' });
});

/**
 * PUT /api/devices/:id/policy - Assign policy to device
 */
app.put('/api/devices/:id/policy', (req: Request, res: Response) => {
  const { id } = req.params;
  const { policyId } = req.body;

  const device = deviceStore.getDevice(id);
  if (!device) {
    res.status(404).json({ error: 'Device not found' });
    return;
  }

  if (policyId) {
    const policy = policyStore.getPolicy(policyId);
    if (!policy) {
      res.status(404).json({ error: 'Policy not found' });
      return;
    }
  }

  deviceStore.updateDevicePolicy(id, policyId || null);

  // Record policy-assigned event
  eventStore.recordEvent({
    deviceId: id,
    eventType: 'policy-assigned',
    severity: 'info',
    data: { policyId: policyId || null, deviceName: device.name },
  });

  // Sync required apps if policy has them
  let commandsQueued = 0;
  if (policyId) {
    const policy = policyStore.getPolicy(policyId);
    if (policy) {
      // Queue app installations
      commandsQueued = syncRequiredApps(id, policyId);

      // Also send SYNC_POLICY with full settings so device can apply
      // boot preferences for already-installed apps
      auditCommandQueued(req, queueSyncPolicy(id, policy));
      commandsQueued++;
    }
  }

  auditStore.log({
    actorType: 'admin',
    action: 'policy.assigned',
    resourceType: 'device',
    resourceId: id,
    details: { policyId, commandsQueued },
  });

  res.json({ success: true, commandsQueued });
});

// ============================================
// Phase 5: Events
// ============================================

// ============================================
// Phase 6: File Transfers
// ============================================

/**
 * GET /api/devices/:id/files - List pending file transfers
 */
app.get('/api/devices/:id/files', (req: Request, res: Response) => {
  const { id } = req.params;
  const { status, direction, limit } = req.query;

  const transfers = fileTransferStore.getDeviceTransfers(id, {
    status: status as 'pending' | 'transferring' | 'completed' | 'failed' | 'cancelled' | undefined,
    direction: direction as 'upload' | 'download' | undefined,
    limit: limit ? parseInt(limit as string, 10) : 50,
  });

  res.json({ transfers });
});

/**
 * POST /api/devices/:id/files/download - Request file download from device
 */
app.post('/api/devices/:id/files/download', (req: Request, res: Response) => {
  const { id } = req.params;
  const { path } = req.body;

  const device = deviceStore.getDevice(id);
  if (!device) {
    res.status(404).json({ error: 'Device not found' });
    return;
  }

  if (!path) {
    res.status(400).json({ error: 'path is required' });
    return;
  }

  const transfer = fileTransferStore.createTransfer({
    deviceId: id,
    direction: 'download',
    devicePath: path,
  });

  // Queue command for device
  commandStore.queueCommand(id, 'DOWNLOAD_FILE', {
    transferId: transfer.id,
    path,
  });

  auditStore.log({
    actorType: 'admin',
    action: 'file.download_requested',
    resourceType: 'file',
    resourceId: transfer.id,
    details: { deviceId: id, path },
  });

  res.status(201).json(transfer);
});

/**
 * POST /api/devices/:id/files/upload - Upload file to device
 */
app.post('/api/devices/:id/files/upload', (req: Request, res: Response) => {
  const { id } = req.params;
  const { destinationPath, sourceUrl, fileName } = req.body;

  const device = deviceStore.getDevice(id);
  if (!device) {
    res.status(404).json({ error: 'Device not found' });
    return;
  }

  if (!destinationPath || !sourceUrl) {
    res.status(400).json({ error: 'destinationPath and sourceUrl are required' });
    return;
  }

  const transfer = fileTransferStore.createTransfer({
    deviceId: id,
    direction: 'upload',
    devicePath: destinationPath,
    serverPath: sourceUrl,
    fileName,
  });

  // Queue command for device
  commandStore.queueCommand(id, 'UPLOAD_FILE', {
    transferId: transfer.id,
    downloadUrl: sourceUrl,
    destinationPath,
  });

  auditStore.log({
    actorType: 'admin',
    action: 'file.upload_requested',
    resourceType: 'file',
    resourceId: transfer.id,
    details: { deviceId: id, destinationPath },
  });

  res.status(201).json(transfer);
});

/**
 * GET /api/files/:id - Get transfer status
 */
app.get('/api/files/:id', (req: Request, res: Response) => {
  const { id } = req.params;

  const transfer = fileTransferStore.getTransfer(id);
  if (!transfer) {
    res.status(404).json({ error: 'Transfer not found' });
    return;
  }

  res.json(transfer);
});

/**
 * PATCH /api/files/:id - Update transfer status (device callback)
 */
app.patch('/api/files/:id', (req: Request, res: Response) => {
  const { id } = req.params;
  const { status, progress, error, serverPath, fileSize } = req.body;

  const transfer = fileTransferStore.getTransfer(id);
  if (!transfer) {
    res.status(404).json({ error: 'Transfer not found' });
    return;
  }

  if (progress !== undefined) {
    fileTransferStore.updateProgress(id, progress);
  }

  if (status === 'completed') {
    fileTransferStore.completeTransfer(id, serverPath, fileSize);
    auditStore.log({
      actorType: 'device',
      actorId: transfer.deviceId,
      action: 'file.transfer_completed',
      resourceType: 'file',
      resourceId: id,
    });
  } else if (status === 'failed') {
    fileTransferStore.failTransfer(id, error || 'Unknown error');
    auditStore.log({
      actorType: 'device',
      actorId: transfer.deviceId,
      action: 'file.transfer_failed',
      resourceType: 'file',
      resourceId: id,
      details: { error },
    });
  } else if (status) {
    fileTransferStore.updateStatus(id, status, error);
  }

  res.json({ success: true });
});

/**
 * DELETE /api/files/:id - Cancel transfer
 */
app.delete('/api/files/:id', (req: Request, res: Response) => {
  const { id } = req.params;

  const cancelled = fileTransferStore.cancelTransfer(id);
  if (!cancelled) {
    res.status(404).json({ error: 'Transfer not found or not cancellable' });
    return;
  }

  res.json({ success: true });
});

// ============================================
// Phase 7: Audit Logs
// ============================================

// Error handling middleware — sanitize error responses
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  // Always log full error server-side
  // eslint-disable-next-line no-console
  console.error('Server error:', err);

  // In production, never expose stack traces or internal details to clients
  if (process.env.NODE_ENV === 'production') {
    res.status(500).json({
      error: 'Internal server error',
    });
  } else {
    res.status(500).json({
      error: 'Internal server error',
      message: err.message,
    });
  }
});
