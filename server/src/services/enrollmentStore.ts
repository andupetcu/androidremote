import crypto from 'crypto';
import type Database from 'better-sqlite3';
import { getDatabase } from '../db/connection';
import { initializeSchema, cleanupExpiredTokens } from '../db/schema';
import { deviceStore } from './deviceStore';

export interface EnrollmentToken {
  id: string;
  token: string;
  createdAt: number;
  expiresAt: number;
  maxUses: number;
  usedCount: number;
  status: 'active' | 'exhausted' | 'revoked' | 'expired';
}

export interface EnrollmentRequest {
  token: string;
  deviceName: string;
  deviceModel?: string;
  androidVersion?: string;
  publicKey?: string;
  // Cross-platform agent fields
  osType?: string;
  hostname?: string;
  arch?: string;
  agentVersion?: string;
}

export interface EnrollmentResult {
  deviceId: string;
  serverUrl: string;
  sessionToken: string;
}

interface TokenRow {
  id: string;
  token: string;
  created_at: number;
  expires_at: number;
  max_uses: number;
  used_count: number;
  status: string;
}

class EnrollmentStore {
  private db: Database.Database | null = null;
  private initialized = false;
  private readonly DEFAULT_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

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

  /**
   * Generate a unique token ID
   */
  private generateTokenId(): string {
    return `token-${crypto.randomBytes(8).toString('hex')}`;
  }

  /**
   * Generate an 8-character alphanumeric enrollment token
   */
  private generateTokenValue(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Omit confusing chars (0,O,1,I)
    let token = '';
    const bytes = crypto.randomBytes(8);
    for (let i = 0; i < 8; i++) {
      token += chars[bytes[i] % chars.length];
    }
    return token;
  }

  /**
   * Create a new enrollment token
   */
  createToken(options?: { maxUses?: number; expiresInMs?: number }): EnrollmentToken {
    this.initialize();
    const db = this.getDb();

    const id = this.generateTokenId();
    const token = this.generateTokenValue();
    const now = Date.now();
    const expiresAt = now + (options?.expiresInMs ?? this.DEFAULT_EXPIRY_MS);
    const maxUses = options?.maxUses ?? 1;

    db.prepare(`
      INSERT INTO enrollment_tokens (id, token, created_at, expires_at, max_uses, used_count, status)
      VALUES (?, ?, ?, ?, ?, 0, 'active')
    `).run(id, token, now, expiresAt, maxUses);

    return {
      id,
      token,
      createdAt: now,
      expiresAt,
      maxUses,
      usedCount: 0,
      status: 'active',
    };
  }

  /**
   * Get a token by its value (the 8-char code)
   */
  getTokenByValue(tokenValue: string): EnrollmentToken | null {
    this.initialize();
    const db = this.getDb();

    // Clean up expired tokens first
    cleanupExpiredTokens(db);

    const row = db.prepare(`
      SELECT * FROM enrollment_tokens WHERE token = ?
    `).get(tokenValue.toUpperCase()) as TokenRow | undefined;

    if (!row) return null;

    return this.rowToToken(row);
  }

  /**
   * Get a token by its ID
   */
  getTokenById(id: string): EnrollmentToken | null {
    this.initialize();
    const db = this.getDb();

    const row = db.prepare(`
      SELECT * FROM enrollment_tokens WHERE id = ?
    `).get(id) as TokenRow | undefined;

    if (!row) return null;

    return this.rowToToken(row);
  }

  /**
   * List all tokens (optionally filter by status)
   */
  listTokens(status?: 'active' | 'exhausted' | 'revoked' | 'expired'): EnrollmentToken[] {
    this.initialize();
    const db = this.getDb();

    // Clean up expired tokens first
    cleanupExpiredTokens(db);

    let query = 'SELECT * FROM enrollment_tokens';
    const params: string[] = [];

    if (status) {
      query += ' WHERE status = ?';
      params.push(status);
    }

    query += ' ORDER BY created_at DESC';

    const rows = db.prepare(query).all(...params) as TokenRow[];

    return rows.map(row => this.rowToToken(row));
  }

  /**
   * Revoke a token by ID
   */
  revokeToken(id: string): boolean {
    this.initialize();
    const db = this.getDb();

    const result = db.prepare(`
      UPDATE enrollment_tokens
      SET status = 'revoked'
      WHERE id = ? AND status = 'active'
    `).run(id);

    return result.changes > 0;
  }

  /**
   * Use a token to enroll a device
   * Returns enrollment result or null if token is invalid/expired/exhausted
   */
  enrollDevice(request: EnrollmentRequest): EnrollmentResult | null {
    this.initialize();
    const db = this.getDb();

    // Get and validate token
    const token = this.getTokenByValue(request.token);

    if (!token) {
      return null;
    }

    if (token.status !== 'active') {
      return null;
    }

    if (Date.now() > token.expiresAt) {
      // Mark as expired
      db.prepare(`
        UPDATE enrollment_tokens SET status = 'expired' WHERE id = ?
      `).run(token.id);
      return null;
    }

    if (token.usedCount >= token.maxUses) {
      // Mark as exhausted
      db.prepare(`
        UPDATE enrollment_tokens SET status = 'exhausted' WHERE id = ?
      `).run(token.id);
      return null;
    }

    // Increment usage count
    const newUsedCount = token.usedCount + 1;
    const newStatus = newUsedCount >= token.maxUses ? 'exhausted' : 'active';

    db.prepare(`
      UPDATE enrollment_tokens
      SET used_count = ?, status = ?
      WHERE id = ?
    `).run(newUsedCount, newStatus, token.id);

    // Enroll the device
    const deviceId = `device-${crypto.randomBytes(8).toString('hex')}`;

    deviceStore.enrollDevice({
      id: deviceId,
      name: request.deviceName,
      model: request.deviceModel,
      androidVersion: request.androidVersion,
      publicKey: request.publicKey,
      osType: request.osType,
      hostname: request.hostname,
      arch: request.arch,
      agentVersion: request.agentVersion,
    });

    // Generate session token
    const sessionToken = crypto.randomBytes(32).toString('base64url');

    // Store session
    db.prepare(`
      INSERT INTO sessions (token, device_id, created_at, last_activity)
      VALUES (?, ?, ?, ?)
    `).run(sessionToken, deviceId, Date.now(), Date.now());

    return {
      deviceId,
      serverUrl: '', // Will be set by the API endpoint based on request
      sessionToken,
    };
  }

  /**
   * Clear all tokens (for testing)
   */
  clear(): void {
    this.initialize();
    const db = this.getDb();
    db.prepare('DELETE FROM enrollment_tokens').run();
  }

  /**
   * Convert database row to EnrollmentToken object
   */
  private rowToToken(row: TokenRow): EnrollmentToken {
    return {
      id: row.id,
      token: row.token,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      maxUses: row.max_uses,
      usedCount: row.used_count,
      status: row.status as EnrollmentToken['status'],
    };
  }
}

export const enrollmentStore = new EnrollmentStore();
