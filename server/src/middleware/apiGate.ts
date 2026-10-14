import { Request, Response, NextFunction } from 'express';
import { deviceStore } from '../services/deviceStore';
import { fileTransferStore } from '../services/fileTransferStore';
import { authMiddleware, verifyAdminToken } from './auth';

/**
 * Authentication gate for everything under /api (mounted with `app.use('/api', apiGate)`).
 * Paths here are relative to the mount point, so `/api/health` is `/health`.
 *
 * Three classes of route, each matched by method plus a regex anchored on the whole path:
 *  - public: no credential (liveness, device-side pairing/enrolment steps, public downloads);
 *  - device: the device's own session token (contract C1), optionally an admin JWT as well;
 *  - everything else: admin JWT.
 */

interface PublicRoute {
  method: string;
  pattern: RegExp;
}

export const PUBLIC_ROUTES: PublicRoute[] = [
  { method: 'GET', pattern: /^\/health$/ },
  // Device side of pairing. The step that issues the session token (/pair/complete) needs the admin JWT.
  { method: 'POST', pattern: /^\/pair\/initiate$/ },
  { method: 'GET', pattern: /^\/pair\/status\/[^/]+$/ },
  // Redemption of an admin-minted enrolment token. Minting/listing/revoking is admin only.
  { method: 'POST', pattern: /^\/enroll\/device$/ },
  // Deployment one-liners download the agent/installer without credentials.
  { method: 'GET', pattern: /^\/downloads\/(agent|installer)\/[^/]+$/ },
  // Android QR provisioning: a factory-fresh device downloads the agent APK without any credential.
  // Serves only the configured agent package (routes/provisioning.ts); every other upload needs a token.
  { method: 'GET', pattern: /^\/provisioning\/agent\.apk$/ },
];

interface DeviceRoute {
  method: string;
  pattern: RegExp;
  /** Also accept an admin JWT (routes the web UI uses as well). */
  allowAdmin?: boolean;
  /** Owning device ID, from the matched path. */
  deviceOf: (m: RegExpMatchArray) => string | null;
}

const fromGroup1 = (m: RegExpMatchArray): string | null => m[1];
const ID = '([^/]+)';

export const DEVICE_ROUTES: DeviceRoute[] = [
  { method: 'POST', pattern: new RegExp(`^/devices/${ID}/heartbeat$`), deviceOf: fromGroup1 },
  { method: 'GET', pattern: new RegExp(`^/devices/${ID}/commands/pending$`), deviceOf: fromGroup1 },
  { method: 'PATCH', pattern: new RegExp(`^/devices/${ID}/commands/[^/]+$`), allowAdmin: true, deviceOf: fromGroup1 },
  { method: 'POST', pattern: new RegExp(`^/devices/${ID}/telemetry$`), deviceOf: fromGroup1 },
  { method: 'POST', pattern: new RegExp(`^/devices/${ID}/telemetry/batch$`), deviceOf: fromGroup1 },
  { method: 'POST', pattern: new RegExp(`^/devices/${ID}/apps$`), deviceOf: fromGroup1 },
  { method: 'POST', pattern: new RegExp(`^/devices/${ID}/events$`), deviceOf: fromGroup1 },
  { method: 'GET', pattern: new RegExp(`^/devices/${ID}/app-updates$`), allowAdmin: true, deviceOf: fromGroup1 },
  { method: 'GET', pattern: new RegExp(`^/devices/${ID}/policy$`), allowAdmin: true, deviceOf: fromGroup1 },
  // File-transfer status callback: the token must belong to the device that owns the transfer.
  {
    method: 'PATCH',
    pattern: /^\/files\/([^/]+)$/,
    allowAdmin: true,
    deviceOf: m => fileTransferStore.getTransfer(m[1])?.deviceId ?? null,
  },
];

/**
 * Routes any enrolled device or the admin may call, not tied to one device ID in the path:
 * APK downloads (SS-10) and the ICE server list (C7). The device ID is left in `res.locals.deviceId`.
 */
const ANY_PRINCIPAL_ROUTES: PublicRoute[] = [
  { method: 'GET', pattern: /^\/uploads\/.+$/ },
  { method: 'GET', pattern: /^\/ice-servers$/ },
];

function extractDeviceToken(req: Request): string {
  const header = req.headers['x-session-token'];
  if (typeof header === 'string' && header) return header;
  const auth = req.headers.authorization;
  return auth && auth.startsWith('Bearer ') ? auth.slice(7) : '';
}

function adminJwtOk(req: Request): boolean {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return false;
  try {
    const payload = verifyAdminToken(auth.slice(7));
    if (!payload) return false;
    req.user = payload;
    return true;
  } catch {
    return false;
  }
}

export function apiGate(req: Request, res: Response, next: NextFunction): void {
  const path = req.path;
  const method = req.method === 'HEAD' ? 'GET' : req.method;

  if (PUBLIC_ROUTES.some(r => r.method === method && r.pattern.test(path))) return next();

  for (const route of DEVICE_ROUTES) {
    if (route.method !== method) continue;
    const m = path.match(route.pattern);
    if (!m) continue;

    if (route.allowAdmin && adminJwtOk(req)) return next();

    const token = extractDeviceToken(req);
    if (!token) {
      if (process.env.ALLOW_TOKENLESS_DEVICES === 'true') {
        console.warn(`[auth] ALLOW_TOKENLESS_DEVICES is on: accepting token-less ${method} /api${path}`);
        return next();
      }
      res.status(401).json({ error: 'Device session token required (X-Session-Token).' });
      return;
    }

    const deviceId = route.deviceOf(m);
    if (!deviceId || !deviceStore.validateDeviceSession(token, deviceId)) {
      res.status(401).json({ error: 'Invalid or expired session token.' });
      return;
    }
    return next();
  }

  if (ANY_PRINCIPAL_ROUTES.some(r => r.method === method && r.pattern.test(path))) {
    if (adminJwtOk(req)) return next();
    const token = extractDeviceToken(req);
    const deviceId = token ? deviceStore.getDeviceIdForSession(token) : null;
    if (!deviceId) {
      res.status(401).json({ error: 'Admin or device session token required.' });
      return;
    }
    res.locals.deviceId = deviceId;
    return next();
  }

  // Everything else is admin-only.
  authMiddleware(req, res, next);
}
