import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import path from 'path';
import rateLimit, { MemoryStore } from 'express-rate-limit';
import multer from 'multer';
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
import { syncRequiredApps, syncPolicyRequiredApps } from './services/appSyncService';
import { getDatabase } from './db/connection';

// Initialize storage provider
const uploadsDir = path.join(__dirname, '..', 'uploads');
const storageProvider = new LocalStorageProvider(uploadsDir, '/api/uploads');
setStorageProvider(storageProvider);

// Configure multer for APK uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB max
  fileFilter: (_req, file, cb) => {
    if (file.originalname.endsWith('.apk')) {
      cb(null, true);
    } else {
      cb(new Error('Only APK files are allowed'));
    }
  },
});

export const app = express();

// Serve uploaded files statically
app.use('/api/uploads', express.static(uploadsDir));

// Middleware
app.use(cors({
  origin: (origin, callback) => {
    // Allow localhost and local network IPs for development
    const allowedPatterns = [
      /^http:\/\/localhost:\d+$/,
      /^http:\/\/127\.0\.0\.1:\d+$/,
      /^http:\/\/192\.168\.\d+\.\d+:\d+$/,  // Local network
      /^http:\/\/10\.\d+\.\d+\.\d+:\d+$/,   // Private network
      /^https?:\/\/mdmadmin\.footprints\.media$/,   // Production admin UI
      /^https?:\/\/proxymdm\.footprints\.media$/,   // Production API domain
    ];
    if (!origin || allowedPatterns.some(p => p.test(origin))) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
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

  // Map 'paired' status to 'completed' for Android app compatibility
  const status = session.status === 'paired' ? 'completed' : session.status;

  const response: Record<string, unknown> = {
    status,
    deviceId: session.deviceId,
  };

  // Include sessionToken and serverUrl when pairing is complete
  if (session.status === 'paired' && session.sessionToken) {
    response.sessionToken = session.sessionToken;
    // Use the same server for WebSocket signaling
    const protocol = req.protocol === 'https' ? 'wss' : 'ws';
    const host = req.get('host') || 'localhost:7899';
    response.serverUrl = `${protocol}://${host}/ws`;
  }

  // eslint-disable-next-line no-console
  console.log(`[STATUS] Returning:`, JSON.stringify(response));
  res.json(response);
});

// Device management endpoints

/**
 * GET /api/devices - List all enrolled devices
 */
app.get('/api/devices', (_req: Request, res: Response) => {
  const devices = deviceStore.getAllDevices();
  res.json({ devices });
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

  res.json(device);
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
  const updated = deviceStore.updateLastSeen(id);

  if (!updated) {
    res.status(404).json({ error: 'Device not found' });
    return;
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
 * DELETE /api/enroll/tokens/:id - Revoke an enrollment token
 */
app.delete('/api/enroll/tokens/:id', (req: Request, res: Response) => {
  const { id } = req.params;
  const revoked = enrollmentStore.revokeToken(id);

  if (!revoked) {
    res.status(404).json({ error: 'Token not found or already inactive' });
    return;
  }

  res.json({ success: true, message: 'Token revoked' });
});

/**
 * POST /api/enroll/device - Enroll a device using a token
 */
app.post('/api/enroll/device', (req: Request, res: Response) => {
  const { token, deviceName, deviceModel, androidVersion, publicKey } = req.body;

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
  });

  if (!result) {
    res.status(401).json({ error: 'Invalid, expired, or exhausted enrollment token' });
    return;
  }

  // Build server URL from request (HTTP base URL for API calls)
  const protocol = req.protocol || 'http';
  const host = req.get('host') || 'localhost:7899';

  res.status(201).json({
    deviceId: result.deviceId,
    sessionToken: result.sessionToken,
    serverUrl: `${protocol}://${host}`,
  });
});

// ============================================
// Device Command Queue
// ============================================

/**
 * POST /api/commands - Queue a command for a device (used by web UI)
 */
app.post('/api/commands', (req: Request, res: Response) => {
  const { deviceId, type, payload } = req.body;

  if (!deviceId) {
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

  const command = commandStore.queueCommand(deviceId, type as CommandType, payload || {});

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

  const command = commandStore.queueCommand(id, type as CommandType, payload || {});

  res.status(201).json(command);
});

/**
 * GET /api/devices/:id/commands/pending - Get pending commands for a device (device polling)
 */
app.get('/api/devices/:id/commands/pending', (req: Request, res: Response) => {
  const { id } = req.params;

  // Update last seen when device polls
  deviceStore.updateLastSeen(id);

  const commands = commandStore.getPendingCommands(id);

  res.json({ commands });
});

/**
 * GET /api/devices/:id/commands - Get command history for a device
 */
app.get('/api/devices/:id/commands', (req: Request, res: Response) => {
  const { id } = req.params;
  const { status, limit, offset } = req.query;

  const commands = commandStore.getCommandHistory(id, {
    status: status as 'pending' | 'delivered' | 'executing' | 'completed' | 'failed' | undefined,
    limit: limit ? parseInt(limit as string, 10) : undefined,
    offset: offset ? parseInt(offset as string, 10) : undefined,
  });

  res.json({ commands });
});

/**
 * PATCH /api/devices/:id/commands/:cmdId - Acknowledge command status
 */
app.patch('/api/devices/:id/commands/:cmdId', (req: Request, res: Response) => {
  const { cmdId } = req.params;
  const { status, error } = req.body;

  const validStatuses = ['executing', 'completed', 'failed'];
  if (!status || !validStatuses.includes(status)) {
    res.status(400).json({
      error: `Invalid status. Must be one of: ${validStatuses.join(', ')}`,
    });
    return;
  }

  const updated = commandStore.acknowledgeCommand(
    cmdId,
    status as 'executing' | 'completed' | 'failed',
    error
  );

  if (!updated) {
    res.status(404).json({ error: 'Command not found or already completed' });
    return;
  }

  res.json({ success: true, commandId: cmdId, status });
});

/**
 * DELETE /api/devices/:id/commands/:cmdId - Cancel a pending command
 */
app.delete('/api/devices/:id/commands/:cmdId', (req: Request, res: Response) => {
  const { cmdId } = req.params;

  const cancelled = commandStore.cancelCommand(cmdId);

  if (!cancelled) {
    res.status(404).json({ error: 'Command not found or not pending' });
    return;
  }

  res.json({ success: true, message: 'Command cancelled' });
});

// ============================================
// Phase 1: Device Telemetry
// ============================================

/**
 * POST /api/devices/:id/telemetry - Device pushes telemetry
 */
app.post('/api/devices/:id/telemetry', (req: Request, res: Response) => {
  const { id } = req.params;
  const device = deviceStore.getDevice(id);

  if (!device) {
    res.status(404).json({ error: 'Device not found' });
    return;
  }

  // Update device last seen
  deviceStore.updateLastSeen(id);

  const input: TelemetryInput = {
    deviceId: id,
    ...req.body,
  };

  const telemetry = telemetryStore.updateTelemetry(input);

  // Check for alert conditions and create events
  if (input.batteryLevel !== undefined && input.batteryLevel < 5) {
    eventStore.recordEvent({
      deviceId: id,
      eventType: 'battery-critical',
      severity: 'critical',
      data: { batteryLevel: input.batteryLevel },
    });
  } else if (input.batteryLevel !== undefined && input.batteryLevel < 20) {
    eventStore.recordEvent({
      deviceId: id,
      eventType: 'battery-low',
      severity: 'warning',
      data: { batteryLevel: input.batteryLevel },
    });
  }

  res.json({
    success: true,
    nextReportIn: 60000, // 1 minute
  });
});

/**
 * GET /api/devices/:id/telemetry - Get latest telemetry
 */
app.get('/api/devices/:id/telemetry', (req: Request, res: Response) => {
  const { id } = req.params;

  const telemetry = telemetryStore.getTelemetry(id);
  if (!telemetry) {
    // Return empty telemetry object instead of 404 when no data exists yet
    res.json({
      deviceId: id,
      timestamp: null,
      batteryLevel: null,
      batteryCharging: null,
      networkType: null,
      storageUsedBytes: null,
      storageTotalBytes: null,
      memoryUsedBytes: null,
      memoryTotalBytes: null,
    });
    return;
  }

  res.json(telemetry);
});

/**
 * GET /api/devices/:id/telemetry/history - Get telemetry history
 */
app.get('/api/devices/:id/telemetry/history', (req: Request, res: Response) => {
  const { id } = req.params;
  const { from, to } = req.query;

  const now = Date.now();
  const fromTs = from ? parseInt(from as string, 10) : now - 24 * 60 * 60 * 1000;
  const toTs = to ? parseInt(to as string, 10) : now;

  const history = telemetryStore.getHistory(id, fromTs, toTs);

  res.json({
    deviceId: id,
    from: fromTs,
    to: toTs,
    dataPoints: history,
  });
});

/**
 * GET /api/telemetry - Get telemetry for all devices (dashboard)
 */
app.get('/api/telemetry', (_req: Request, res: Response) => {
  const telemetry = telemetryStore.getAllTelemetry();
  res.json({ telemetry });
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
app.post('/api/apps/upload', upload.single('file'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }

    const { packageName, appName, versionName, versionCode } = req.body;

    if (!packageName) {
      res.status(400).json({ error: 'packageName is required' });
      return;
    }

    // Generate unique filename
    const timestamp = Date.now();
    const filename = `apks/${packageName}-${timestamp}.apk`;

    // Save file using storage provider
    const storage = getStorageProvider();
    const filePath = await storage.save(filename, req.file.buffer);

    // Check if package already exists
    const existing = appPackageStore.getAppPackageByName(packageName);

    let pkg;
    if (existing) {
      // Delete old file
      await storage.delete(existing.filePath);
      // Update existing entry
      pkg = appPackageStore.updateAppPackage(packageName, {
        appName,
        versionName,
        versionCode: versionCode ? parseInt(versionCode, 10) : undefined,
        fileSize: req.file.size,
        filePath,
      });
    } else {
      // Create new entry
      pkg = appPackageStore.createAppPackage({
        packageName,
        appName,
        versionName,
        versionCode: versionCode ? parseInt(versionCode, 10) : undefined,
        fileSize: req.file.size,
        filePath,
      });
    }

    auditStore.log({
      actorType: 'admin',
      action: existing ? 'app.updated' : 'app.uploaded',
      resourceType: 'app',
      resourceId: packageName,
      details: { versionName, fileSize: req.file.size },
    });

    res.status(201).json(pkg);
  } catch (err) {
    console.error('Upload error:', err);
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
 * DELETE /api/apps/packages/:packageName - Delete an uploaded package
 */
app.delete('/api/apps/packages/:packageName', async (req: Request, res: Response) => {
  const { packageName } = req.params;

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

  const commands = [];
  for (const deviceId of deviceIds) {
    const device = deviceStore.getDevice(deviceId);
    if (device) {
      const cmd = commandStore.queueCommand(deviceId, 'INSTALL_APK', {
        url: pkg.downloadUrl,
        packageName: pkg.packageName,
        appName: pkg.appName,
        versionName: pkg.versionName,
      });
      commands.push(cmd);

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
      const db = getDatabase();
      const devices = db.prepare(`SELECT id FROM devices WHERE policy_id = ?`).all(id) as { id: string }[];
      for (const device of devices) {
        commandStore.queueCommand(device.id, 'SYNC_POLICY', {
          silentMode: policy.silentMode,
          kioskMode: policy.kioskMode,
          requiredApps: policy.requiredApps || [],
        });
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

  // Sync required apps if policy has them
  let commandsQueued = 0;
  if (policyId) {
    const policy = policyStore.getPolicy(policyId);
    if (policy) {
      // Queue app installations
      commandsQueued = syncRequiredApps(id, policyId);

      // Also send SYNC_POLICY with full settings so device can apply
      // boot preferences for already-installed apps
      commandStore.queueCommand(id, 'SYNC_POLICY', {
        silentMode: policy.silentMode,
        kioskMode: policy.kioskMode,
        requiredApps: policy.requiredApps || [],
      });
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

/**
 * GET /api/events - List all events
 */
app.get('/api/events', (req: Request, res: Response) => {
  const { severity, acknowledged, limit, offset, from, to } = req.query;

  const events = eventStore.getAllEvents({
    severity: severity as EventSeverity | undefined,
    acknowledged: acknowledged !== undefined ? acknowledged === 'true' : undefined,
    limit: limit ? parseInt(limit as string, 10) : 100,
    offset: offset ? parseInt(offset as string, 10) : undefined,
    from: from ? parseInt(from as string, 10) : undefined,
    to: to ? parseInt(to as string, 10) : undefined,
  });

  res.json({ events, count: events.length });
});

/**
 * GET /api/events/unread - Get unread critical/warning events
 */
app.get('/api/events/unread', (req: Request, res: Response) => {
  const { minSeverity } = req.query;

  const events = eventStore.getUnacknowledgedEvents(
    (minSeverity as EventSeverity) || 'warning'
  );
  const count = eventStore.getUnacknowledgedCount(
    (minSeverity as EventSeverity) || 'warning'
  );

  res.json({ events, count });
});

/**
 * GET /api/events/stats - Get event statistics
 */
app.get('/api/events/stats', (_req: Request, res: Response) => {
  const unreadCount = eventStore.getUnacknowledgedCount('info');
  const criticalCount = eventStore.getUnacknowledgedCount('critical');
  const warningCount = eventStore.getUnacknowledgedCount('warning');

  res.json({
    unread: unreadCount,
    critical: criticalCount,
    warning: warningCount,
  });
});

/**
 * GET /api/devices/:id/events - Get events for device
 */
app.get('/api/devices/:id/events', (req: Request, res: Response) => {
  const { id } = req.params;
  const { severity, acknowledged, limit, offset } = req.query;

  const events = eventStore.getDeviceEvents(id, {
    severity: severity as EventSeverity | undefined,
    acknowledged: acknowledged !== undefined ? acknowledged === 'true' : undefined,
    limit: limit ? parseInt(limit as string, 10) : 100,
    offset: offset ? parseInt(offset as string, 10) : undefined,
  });

  res.json({ events, count: events.length });
});

/**
 * POST /api/devices/:id/events - Device reports an event
 */
app.post('/api/devices/:id/events', (req: Request, res: Response) => {
  const { id } = req.params;
  const { eventType, severity, data } = req.body;

  const device = deviceStore.getDevice(id);
  if (!device) {
    res.status(404).json({ error: 'Device not found' });
    return;
  }

  const event = eventStore.recordEvent({
    deviceId: id,
    eventType: eventType as DeviceEventType,
    severity: severity as EventSeverity,
    data,
  });

  res.status(201).json(event);
});

/**
 * POST /api/events/:id/acknowledge - Acknowledge an event
 */
app.post('/api/events/:id/acknowledge', (req: Request, res: Response) => {
  const { id } = req.params;
  const { acknowledgedBy } = req.body;

  const acknowledged = eventStore.acknowledgeEvent(
    parseInt(id, 10),
    acknowledgedBy
  );

  if (!acknowledged) {
    res.status(404).json({ error: 'Event not found or already acknowledged' });
    return;
  }

  auditStore.log({
    actorType: 'admin',
    actorId: acknowledgedBy,
    action: 'event.acknowledged',
    resourceType: 'event',
    resourceId: id,
  });

  res.json({ success: true });
});

/**
 * POST /api/events/acknowledge - Acknowledge multiple events
 */
app.post('/api/events/acknowledge', (req: Request, res: Response) => {
  const { eventIds, acknowledgedBy } = req.body;

  if (!Array.isArray(eventIds)) {
    res.status(400).json({ error: 'eventIds must be an array' });
    return;
  }

  const count = eventStore.acknowledgeEvents(eventIds, acknowledgedBy);

  res.json({ success: true, acknowledged: count });
});

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

/**
 * GET /api/audit - List audit logs
 */
app.get('/api/audit', (req: Request, res: Response) => {
  const { actorType, actorId, action, resourceType, resourceId, from, to, limit, offset } = req.query;

  const logs = auditStore.getLogs({
    actorType: actorType as 'admin' | 'device' | 'system' | undefined,
    actorId: actorId as string | undefined,
    action: action as any,
    resourceType: resourceType as any,
    resourceId: resourceId as string | undefined,
    from: from ? parseInt(from as string, 10) : undefined,
    to: to ? parseInt(to as string, 10) : undefined,
    limit: limit ? parseInt(limit as string, 10) : 100,
    offset: offset ? parseInt(offset as string, 10) : undefined,
  });

  res.json({ logs, count: logs.length });
});

/**
 * GET /api/audit/export - Export audit logs as CSV
 */
app.get('/api/audit/export', (req: Request, res: Response) => {
  const { from, to } = req.query;

  const csv = auditStore.exportLogs({
    from: from ? parseInt(from as string, 10) : undefined,
    to: to ? parseInt(to as string, 10) : undefined,
  });

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="audit-logs-${Date.now()}.csv"`);
  res.send(csv);
});

/**
 * GET /api/devices/:id/audit - Get audit logs for device
 */
app.get('/api/devices/:id/audit', (req: Request, res: Response) => {
  const { id } = req.params;
  const { limit } = req.query;

  const logs = auditStore.getResourceLogs(
    'device',
    id,
    limit ? parseInt(limit as string, 10) : 100
  );

  res.json({ logs, count: logs.length });
});

// Error handling middleware
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  // eslint-disable-next-line no-console
  console.error('Server error:', err);
  res.status(500).json({
    error: 'Internal server error',
  });
});
