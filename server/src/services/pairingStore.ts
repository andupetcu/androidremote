import crypto from 'crypto';
import type Database from 'better-sqlite3';
import { getDatabase } from '../db/connection';
import { initializeSchema, cleanupExpiredSessions } from '../db/schema';
import { deviceStore } from './deviceStore';

export interface PairingSession {
  deviceId: string;
  devicePublicKey: string;
  pairingCode: string;
  createdAt: number;
  expiresAt: number;
  status: 'pending' | 'paired' | 'expired';
  controllerPublicKey?: string;
  sessionToken?: string;
}

interface PairingSessionRow {
  id: string;
  device_id: string;
  pairing_code: string;
  created_at: number;
  expires_at: number;
  status: string;
  controller_public_key: string | null;
  device_public_key: string | null;
  session_token: string | null;
}

class PairingStore {
  private db: Database.Database | null = null;
  private initialized = false;
  private readonly CODE_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

  private getDb(): Database.Database {
    if (!this.db) {
      this.db = getDatabase();
    }
    return this.db;
  }

  private initialize(): void {
    if (!this.initialized) {
      initializeSchema(this.getDb());
      this.initialized = true;
    }
  }

  /**
   * Set the database instance (for testing)
   */
  setDatabase(database: Database.Database): void {
    this.db = database;
    this.initialized = false;
    initializeSchema(database);
    this.initialized = true;
  }

  /**
   * Reset to default database (for testing cleanup)
   */
  resetDatabase(): void {
    this.db = null;
    this.initialized = false;
  }

  generateDeviceId(): string {
    return `device-${crypto.randomBytes(8).toString('hex')}`;
  }

  generatePairingCode(): string {
    this.initialize();
    const db = this.getDb();

    // Generate 6-digit code, ensuring uniqueness
    let code: string;
    let attempts = 0;
    do {
      code = Math.floor(100000 + Math.random() * 900000).toString();
      const existing = db.prepare(`
        SELECT 1 FROM pairing_sessions WHERE pairing_code = ? AND status = 'pending'
      `).get(code);
      if (!existing) break;
      attempts++;
    } while (attempts < 100);

    return code;
  }

  generateSessionToken(): string {
    return crypto.randomBytes(32).toString('base64url');
  }

  createSession(devicePublicKey: string): PairingSession {
    this.initialize();
    const db = this.getDb();

    const deviceId = this.generateDeviceId();
    const pairingCode = this.generatePairingCode();
    const sessionId = crypto.randomBytes(16).toString('hex');
    const now = Date.now();
    const expiresAt = now + this.CODE_EXPIRY_MS;

    db.prepare(`
      INSERT INTO pairing_sessions (id, device_id, pairing_code, device_public_key, created_at, expires_at, status)
      VALUES (?, ?, ?, ?, ?, ?, 'pending')
    `).run(sessionId, deviceId, pairingCode, devicePublicKey, now, expiresAt);

    return {
      deviceId,
      devicePublicKey,
      pairingCode,
      createdAt: now,
      expiresAt,
      status: 'pending',
    };
  }

  getSessionByDeviceId(deviceId: string): PairingSession | undefined {
    this.initialize();
    const db = this.getDb();

    // Clean up expired sessions first
    cleanupExpiredSessions(db);

    const row = db.prepare(`
      SELECT * FROM pairing_sessions WHERE device_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(deviceId) as PairingSessionRow | undefined;

    if (!row) return undefined;

    return this.rowToSession(row);
  }

  getSessionByCode(pairingCode: string): PairingSession | undefined {
    this.initialize();
    const db = this.getDb();

    // Clean up expired sessions first
    cleanupExpiredSessions(db);

    const row = db.prepare(`
      SELECT * FROM pairing_sessions WHERE pairing_code = ? ORDER BY created_at DESC LIMIT 1
    `).get(pairingCode) as PairingSessionRow | undefined;

    if (!row) return undefined;

    return this.rowToSession(row);
  }

  completeSession(
    pairingCode: string,
    controllerPublicKey: string
  ): PairingSession | null {
    this.initialize();
    const db = this.getDb();

    const session = this.getSessionByCode(pairingCode);

    if (!session) return null;
    if (session.status !== 'pending') return null;
    if (Date.now() > session.expiresAt) {
      this.expireSession(session.deviceId);
      return null;
    }

    const sessionToken = this.generateSessionToken();

    // Update the pairing session
    db.prepare(`
      UPDATE pairing_sessions
      SET status = 'paired', controller_public_key = ?, session_token = ?
      WHERE pairing_code = ? AND status = 'pending'
    `).run(controllerPublicKey, sessionToken, pairingCode);

    // Auto-enroll the device in the MDM
    deviceStore.enrollDevice({
      id: session.deviceId,
      name: `Android Device (${session.deviceId.slice(-6)})`,
      publicKey: session.devicePublicKey,
    });

    // Create a session entry
    db.prepare(`
      INSERT OR REPLACE INTO sessions (token, device_id, created_at, last_activity)
      VALUES (?, ?, ?, ?)
    `).run(sessionToken, session.deviceId, Date.now(), Date.now());

    return {
      ...session,
      status: 'paired',
      controllerPublicKey,
      sessionToken,
    };
  }

  expireSession(deviceId: string): void {
    this.initialize();
    const db = this.getDb();

    db.prepare(`
      UPDATE pairing_sessions
      SET status = 'expired', expires_at = ?
      WHERE device_id = ? AND status = 'pending'
    `).run(Date.now() - 1, deviceId);
  }

  /**
   * Clear all sessions (for testing)
   */
  clear(): void {
    this.initialize();
    const db = this.getDb();

    db.prepare('DELETE FROM pairing_sessions').run();
    db.prepare('DELETE FROM sessions').run();
  }

  /**
   * Convert database row to PairingSession object
   */
  private rowToSession(row: PairingSessionRow): PairingSession {
    return {
      deviceId: row.device_id,
      devicePublicKey: row.device_public_key || '',
      pairingCode: row.pairing_code,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      status: row.status as 'pending' | 'paired' | 'expired',
      controllerPublicKey: row.controller_public_key || undefined,
      sessionToken: row.session_token || undefined,
    };
  }
}

export const pairingStore = new PairingStore();
