import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import type Database from 'better-sqlite3';
import { getDatabase } from '../db/connection';

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

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required. Provide a Bearer token.' });
    return;
  }

  const token = authHeader.slice(7);

  try {
    const decoded = jwt.verify(token, getJwtSecret());
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

export async function loginHandler(req: Request, res: Response): Promise<void> {
  const { username, password } = req.body;

  if (!username || !password) {
    res.status(401).json({ error: 'Username and password are required.' });
    return;
  }

  const expectedUsername = process.env.ADMIN_USER || 'admin';

  if (username !== expectedUsername) {
    res.status(401).json({ error: 'Invalid credentials.' });
    return;
  }

  // Check settings table first, then env var
  const storedHash = await getStoredPasswordHash();
  const envHash = process.env.ADMIN_PASSWORD_HASH || null;
  const passwordHash = storedHash ?? envHash;

  if (!passwordHash) {
    console.error('Login refused: ' + NOT_CONFIGURED_MESSAGE);
    res.status(401).json({ error: NOT_CONFIGURED_MESSAGE });
    return;
  }

  const isValid = await bcrypt.compare(password, passwordHash);
  if (!isValid) {
    res.status(401).json({ error: 'Invalid credentials.' });
    return;
  }

  const token = jwt.sign({ username }, getJwtSecret(), { expiresIn: '24h' });
  res.json({ token, username, mustChangePassword: false });
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
    res.json({ message: 'Password updated successfully.' });
  } catch {
    res.status(500).json({ error: 'Failed to update password.' });
  }
}

