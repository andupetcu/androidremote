import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
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

async function getStoredPasswordHash(): Promise<string | null> {
  try {
    const db = getDatabase();
    const row = db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get('adminPasswordHash') as { value: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

async function storePasswordHash(hash: string): Promise<void> {
  const db = getDatabase();
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
    // First-time setup: accept default password 'admin'
    console.warn(
      'WARNING: ADMIN_PASSWORD_HASH is not set and no password is stored. Accepting default password "admin". Change it immediately.'
    );
    if (password !== 'admin') {
      res.status(401).json({ error: 'Invalid credentials.' });
      return;
    }
  } else {
    const isValid = await bcrypt.compare(password, passwordHash);
    if (!isValid) {
      res.status(401).json({ error: 'Invalid credentials.' });
      return;
    }
  }

  const token = jwt.sign({ username }, getJwtSecret(), { expiresIn: '24h' });
  res.json({ token, username });
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
    // No hash stored yet — validate against default password
    if (currentPassword !== 'admin') {
      res.status(401).json({ error: 'Current password is incorrect.' });
      return;
    }
  } else {
    const isValid = await bcrypt.compare(currentPassword, passwordHash);
    if (!isValid) {
      res.status(401).json({ error: 'Current password is incorrect.' });
      return;
    }
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
