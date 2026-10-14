import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import type Database from 'better-sqlite3';
import { getDatabase } from '../db/connection';
import { auditStore, AuditAction } from '../services/auditStore';

// Extend Express Request to include user payload
declare global {
  namespace Express {
    interface Request {
      user?: jwt.JwtPayload | string;
    }
  }
}

let jwtSecret: string;

export function getJwtSecret(): string {
  if (!jwtSecret) {
    const envSecret = process.env.JWT_SECRET;
    if (envSecret) {
      jwtSecret = envSecret;
    } else {
      console.warn(
        'WARNING: JWT_SECRET is not set. Using a randomly generated secret. Tokens will be invalidated on server restart.'
      );
      jwtSecret = crypto.randomBytes(64).toString('hex');
    }
  }
  return jwtSecret;
}

let authDb: Database.Database | null = null;

/** Point the credential store at a specific database (tests). Pass null to go back to the default. */
export function setAuthDatabase(db: Database.Database | null): void {
  authDb = db;
}

function credentialDb(): Database.Database {
  return authDb ?? getDatabase();
}

const NOT_CONFIGURED_MESSAGE =
  'Admin password is not configured. Set ADMIN_INITIAL_PASSWORD (first start) or ADMIN_PASSWORD_HASH on the server.';

/**
 * One-time setup: when no password hash is stored and ADMIN_PASSWORD_HASH is not set,
 * hash ADMIN_INITIAL_PASSWORD and store it. Once a hash is stored the variable is ignored.
 * Returns true when a password was stored.
 */
export async function ensureInitialAdminPassword(): Promise<boolean> {
  const initial = process.env.ADMIN_INITIAL_PASSWORD;
  if (!initial) return false;
  if (process.env.ADMIN_PASSWORD_HASH) return false;
  if ((await getStoredPasswordHash()) !== null) return false;
  if (initial.length < 8) {
    console.error('ADMIN_INITIAL_PASSWORD is shorter than 8 characters and was ignored.');
    return false;
  }
  await storePasswordHash(await bcrypt.hash(initial, 12));
  console.warn('Admin password initialised from ADMIN_INITIAL_PASSWORD. Remove the variable from the environment.');
  return true;
}

/** Identity of the authenticated admin, for audit entries and ticket subjects. */
export function adminSubject(req: Request): string {
  const u = req.user;
  if (u && typeof u === 'object') {
    if (typeof u.sub === 'string' && u.sub) return u.sub;
    if (typeof (u as { username?: unknown }).username === 'string') return (u as { username: string }).username;
  }
  return 'admin';
}

async function getStoredPasswordHash(): Promise<string | null> {
  try {
    const db = credentialDb();
    const row = db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get('adminPasswordHash') as { value: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

async function storePasswordHash(hash: string): Promise<void> {
  const db = credentialDb();
  db.prepare(
    'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)'
  ).run('adminPasswordHash', hash);
}

const SESSIONS_VALID_AFTER_KEY = 'adminSessionsValidAfter';

function adminTokenTtl(): string {
  return process.env.JWT_EXPIRES_IN || '8h';
}

/** Mint an admin session token: unique `jti` (for revocation) and the issue time in ms (for revoke-all). */
export function issueAdminToken(username: string): string {
  return jwt.sign({ username, iatMs: Date.now() }, getJwtSecret(), {
    expiresIn: adminTokenTtl() as jwt.SignOptions['expiresIn'],
    jwtid: crypto.randomUUID(),
  });
}

function sessionsValidAfter(): number {
  try {
    const row = credentialDb().prepare('SELECT value FROM settings WHERE key = ?').get(SESSIONS_VALID_AFTER_KEY) as
      { value: string } | undefined;
    const v = row ? Number(row.value) : 0;
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}

/**
 * Verify an admin JWT (signature, expiry), then check that it was not revoked: not by logout (its jti is in
 * revoked_tokens) and not by a password change (issued before the sessions-valid-after mark). Returns the
 * payload or null.
 */
export function verifyAdminToken(token: string): jwt.JwtPayload | null {
  let decoded: jwt.JwtPayload | string;
  try {
    decoded = jwt.verify(token, getJwtSecret());
  } catch {
    return null;
  }
  if (typeof decoded !== 'object' || decoded === null) return null;
  const db = credentialDb();
  if (decoded.jti && db.prepare('SELECT 1 FROM revoked_tokens WHERE jti = ?').get(decoded.jti)) return null;
  const issuedMs = typeof decoded.iatMs === 'number' ? decoded.iatMs : (decoded.iat ?? 0) * 1000;
  if (issuedMs < sessionsValidAfter()) return null;
  return decoded;
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required. Provide a Bearer token.' });
    return;
  }

  let payload: jwt.JwtPayload | null = null;
  try {
    payload = verifyAdminToken(authHeader.slice(7));
  } catch (err) {
    console.error('Admin token check failed:', err);
  }
  if (!payload) {
    res.status(401).json({ error: 'Invalid or expired token.' });
    return;
  }
  req.user = payload;
  next();
}

function audit(req: Request, action: AuditAction, actorId: string | undefined, details?: Record<string, unknown>): void {
  try {
    auditStore.log({
      actorType: action === 'admin.login_failed' ? 'system' : 'admin',
      actorId,
      action,
      resourceType: 'session',
      details,
      ipAddress: req.ip,
    });
  } catch (err) {
    console.error('Failed to write audit entry:', err);
  }
}

/** Audit a failed login without ever recording the password. Used by the login handler and the rate limiter. */
export function auditLoginFailure(req: Request, reason: string): void {
  const raw = req.body && typeof req.body.username === 'string' ? req.body.username : '';
  audit(req, 'admin.login_failed', raw.slice(0, 100) || undefined, { reason });
}

export async function loginHandler(req: Request, res: Response): Promise<void> {
  const { username, password } = req.body;

  if (!username || !password) {
    auditLoginFailure(req, 'missing_fields');
    res.status(401).json({ error: 'Username and password are required.' });
    return;
  }

  const expectedUsername = process.env.ADMIN_USER || 'admin';

  if (username !== expectedUsername) {
    auditLoginFailure(req, 'invalid_credentials');
    res.status(401).json({ error: 'Invalid credentials.' });
    return;
  }

  // Check settings table first, then env var
  const storedHash = await getStoredPasswordHash();
  const envHash = process.env.ADMIN_PASSWORD_HASH || null;
  const passwordHash = storedHash ?? envHash;

  if (!passwordHash) {
    console.error('Login refused: ' + NOT_CONFIGURED_MESSAGE);
    auditLoginFailure(req, 'not_configured');
    res.status(401).json({ error: NOT_CONFIGURED_MESSAGE });
    return;
  }

  const isValid = await bcrypt.compare(password, passwordHash);
  if (!isValid) {
    auditLoginFailure(req, 'invalid_credentials');
    res.status(401).json({ error: 'Invalid credentials.' });
    return;
  }

  const token = issueAdminToken(username);
  audit(req, 'admin.login', username);
  res.json({ token, username, mustChangePassword: false });
}

/** POST /api/auth/logout: revoke the presented token (SS-09). */
export function logoutHandler(req: Request, res: Response): void {
  const user = req.user;
  const claims = user && typeof user === 'object' ? user : null;
  let revoked = false;
  if (claims?.jti) {
    const expiresAt = typeof claims.exp === 'number' ? claims.exp * 1000 : Date.now() + 24 * 60 * 60 * 1000;
    credentialDb().prepare('INSERT OR IGNORE INTO revoked_tokens (jti, expires_at) VALUES (?, ?)').run(claims.jti, expiresAt);
    revoked = true;
  }
  audit(req, 'admin.logout', adminSubject(req));
  res.json({ success: true, revoked });
}

export async function changePasswordHandler(req: Request, res: Response): Promise<void> {
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    res.status(400).json({ error: 'currentPassword and newPassword are required.' });
    return;
  }

  // Validate current password
  const storedHash = await getStoredPasswordHash();
  const envHash = process.env.ADMIN_PASSWORD_HASH || null;
  const passwordHash = storedHash ?? envHash;

  if (!passwordHash) {
    res.status(401).json({ error: NOT_CONFIGURED_MESSAGE });
    return;
  }
  const isValid = await bcrypt.compare(currentPassword, passwordHash);
  if (!isValid) {
    res.status(401).json({ error: 'Current password is incorrect.' });
    return;
  }

  // Hash and store the new password in the settings table
  const saltRounds = 12;
  const newHash = await bcrypt.hash(newPassword, saltRounds);

  try {
    await storePasswordHash(newHash);
    // Every session issued before this moment stops working, including the caller's (SS-09).
    credentialDb().prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .run(SESSIONS_VALID_AFTER_KEY, String(Date.now()));
    audit(req, 'admin.password_changed', adminSubject(req));
    res.json({ message: 'Password updated successfully.' });
  } catch {
    res.status(500).json({ error: 'Failed to update password.' });
  }
}
