import crypto from 'crypto';
import type Database from 'better-sqlite3';
import { getDatabase } from '../db/connection';
import { initializeSchema, COMMAND_TYPES, commandTtlMs, executingTimeoutMs } from '../db/schema';

export type CommandType = typeof COMMAND_TYPES[number];

export type CommandStatus =
  | 'pending'
  | 'delivered'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'expired';

export interface DeviceCommand {
  id: string;
  deviceId: string;
  type: CommandType;
  payload: Record<string, unknown>;
  status: CommandStatus;
  createdAt: number;
  deliveredAt?: number;
  completedAt?: number;
  error?: string;
  leaseExpiresAt?: number;
  expiresAt?: number;
}

/** Called after every command state change (queued, delivered, executing, completed, failed, expired, cancelled). */
export type CommandListener = (command: DeviceCommand) => void;

/** How a newly queued command replaces older pending ones of the same device (SR-18). */
export interface QueueOptions {
  /** 'type': one pending command per device and type. 'packageName': one per device, type and payload.packageName. */
  supersede?: 'type' | 'packageName';
}

export interface InstallApkPayload {
  url: string;
  packageName: string;
  /** Lower-case hex SHA-256 of the APK (C6). The device refuses to install without it. */
  sha256: string;
}

export interface UninstallAppPayload {
  packageName: string;
}

export interface WipePayload {
  keepData?: boolean;
}

export interface StartRemotePayload {
  signalingUrl: string;
}

interface CommandRow {
  id: string;
  device_id: string;
  type: string;
  payload: string;
  status: string;
  created_at: number;
  delivered_at: number | null;
  completed_at: number | null;
  error: string | null;
  lease_expires_at: number | null;
  expires_at: number | null;
  executing_at: number | null;
}

/** Redelivery lease (C5). */
function leaseMs(): number {
  const v = Number(process.env.COMMAND_LEASE_MS);
  return v > 0 ? v : 5 * 60 * 1000;
}

class CommandStore {
  private db: Database.Database | null = null;
  private initialized = false;
  private listeners: CommandListener[] = [];

  /** Subscribe to command state changes (the admin socket forwards them as `command-update`). */
  subscribe(listener: CommandListener): () => void {
    this.listeners.push(listener);
    return () => { this.listeners = this.listeners.filter(l => l !== listener); };
  }

  private notify(command: DeviceCommand | null): void {
    if (!command) return;
    for (const l of this.listeners) {
      try { l(command); } catch (err) { console.error('[commandStore] listener failed:', err); }
    }
  }

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
   * Generate a unique command ID
   */
  private generateCommandId(): string {
    return `cmd-${crypto.randomBytes(8).toString('hex')}`;
  }

  /**
   * Queue a command for a device. It expires after a type-dependent TTL (C5).
   */
  queueCommand(
    deviceId: string,
    type: CommandType,
    payload: Record<string, unknown> = {},
    options: QueueOptions = {}
  ): DeviceCommand {
    this.initialize();
    const db = this.getDb();

    const id = this.generateCommandId();
    const now = Date.now();
    const expiresAt = now + commandTtlMs(type);
    const payloadJson = JSON.stringify(payload);

    db.transaction(() => {
      if (options.supersede === 'type') {
        db.prepare(`
          UPDATE device_commands SET status = 'expired', completed_at = ?, error = 'superseded'
          WHERE device_id = ? AND type = ? AND status = 'pending'
        `).run(now, deviceId, type);
      } else if (options.supersede === 'packageName') {
        db.prepare(`
          UPDATE device_commands SET status = 'expired', completed_at = ?, error = 'superseded'
          WHERE device_id = ? AND type = ? AND status = 'pending'
            AND json_extract(payload, '$.packageName') IS ?
        `).run(now, deviceId, type, typeof payload.packageName === 'string' ? payload.packageName : null);
      }

      db.prepare(`
        INSERT INTO device_commands (id, device_id, type, payload, status, created_at, expires_at)
        VALUES (?, ?, ?, ?, 'pending', ?, ?)
      `).run(id, deviceId, type, payloadJson, now, expiresAt);
    })();

    const queued: DeviceCommand = {
      id,
      deviceId,
      type,
      payload,
      status: 'pending',
      createdAt: now,
      expiresAt,
    };
    this.notify(queued);
    return queued;
  }

  /**
   * Mark commands that were never executed and are past their expiry as 'expired'.
   * Executing commands are left alone: the device is already running them.
   */
  expireStale(deviceId?: string): number {
    this.initialize();
    const db = this.getDb();
    const now = Date.now();
    const where = `status IN ('pending', 'delivered') AND expires_at IS NOT NULL AND expires_at <= ?`;
    const scope = deviceId ? ' AND device_id = ?' : '';
    const args = deviceId ? [now, deviceId] : [now];
    const ids = (db.prepare(`SELECT id FROM device_commands WHERE ${where}${scope}`).all(...args) as Array<{ id: string }>)
      .map(r => r.id);
    if (ids.length === 0) return 0;
    const changes = db.prepare(`
      UPDATE device_commands SET status = 'expired', completed_at = ? WHERE ${where}${scope}
    `).run(now, ...args).changes;
    for (const id of ids) this.notify(this.getCommand(id));
    return changes;
  }

  /**
   * Fail commands that have been `executing` for longer than twice their per-type timeout: the device
   * most likely died or lost the command mid-run. The start time is `executing_at`, falling back to
   * `delivered_at` and `created_at` for rows from before that column existed. Returns the failed commands.
   */
  expireStuckExecuting(): DeviceCommand[] {
    this.initialize();
    const db = this.getDb();
    const now = Date.now();
    const rows = db.prepare(`SELECT * FROM device_commands WHERE status = 'executing'`).all() as CommandRow[];
    const failed: DeviceCommand[] = [];
    const mark = db.prepare(`
      UPDATE device_commands SET status = 'failed', completed_at = ?, error = ?
      WHERE id = ? AND status = 'executing'
    `);
    for (const row of rows) {
      const since = row.executing_at ?? row.delivered_at ?? row.created_at;
      if (now - since <= executingTimeoutMs(row.type)) continue;
      const minutes = Math.round((now - since) / 60_000);
      if (mark.run(now, `timed out while executing (no result after ${minutes} min)`, row.id).changes > 0) {
        const cmd = this.getCommand(row.id);
        if (cmd) { failed.push(cmd); this.notify(cmd); }
      }
    }
    return failed;
  }

  /**
   * Poll for a device (C5): pending commands plus delivered commands whose lease ran out (redelivery).
   * Expired commands are never returned. Each returned command gets a fresh lease.
   */
  getPendingCommands(deviceId: string): DeviceCommand[] {
    this.initialize();
    const db = this.getDb();

    const delivered = db.transaction(() => {
      this.expireStale(deviceId);

      const now = Date.now();
      const rows = db.prepare(`
        SELECT * FROM device_commands
        WHERE device_id = ?
          AND (status = 'pending'
               OR (status = 'delivered' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)))
        ORDER BY created_at ASC, rowid ASC
      `).all(deviceId, now) as CommandRow[];

      if (rows.length === 0) {
        return [];
      }

      const lease = now + leaseMs();
      const mark = db.prepare(`
        UPDATE device_commands
        SET status = 'delivered', delivered_at = ?, lease_expires_at = ?
        WHERE id = ?
      `);
      for (const row of rows) mark.run(now, lease, row.id);

      return rows.map(row => ({
        ...this.rowToCommand(row),
        status: 'delivered' as CommandStatus,
        deliveredAt: now,
        leaseExpiresAt: lease,
      }));
    })();
    for (const cmd of delivered) this.notify(cmd);
    return delivered;
  }

  /**
   * Non-consuming check: does the device have a live command of this type waiting or out for delivery?
   * (The heartbeat uses this instead of reading the queue, SR-02.)
   */
  hasPendingOfType(deviceId: string, type: CommandType): boolean {
    this.initialize();
    const row = this.getDb().prepare(`
      SELECT 1 AS found FROM device_commands
      WHERE device_id = ? AND type = ? AND status IN ('pending', 'delivered')
        AND (expires_at IS NULL OR expires_at > ?)
      LIMIT 1
    `).get(deviceId, type, Date.now());
    return row !== undefined;
  }

  /**
   * Get a command by ID
   */
  getCommand(id: string): DeviceCommand | null {
    this.initialize();
    const db = this.getDb();

    const row = db.prepare(`
      SELECT * FROM device_commands WHERE id = ?
    `).get(id) as CommandRow | undefined;

    if (!row) return null;

    return this.rowToCommand(row);
  }

  /**
   * Acknowledge command completion or failure
   */
  acknowledgeCommand(
    commandId: string,
    status: 'executing' | 'completed' | 'failed',
    error?: string,
    deviceId?: string
  ): boolean {
    this.initialize();
    const db = this.getDb();

    const now = Date.now();
    const scope = deviceId !== undefined ? ' AND device_id = ?' : '';
    const scopeArgs = deviceId !== undefined ? [deviceId] : [];

    let changed: boolean;
    if (status === 'executing') {
      changed = db.prepare(`
        UPDATE device_commands
        SET status = 'executing', executing_at = ?
        WHERE id = ? AND status IN ('pending', 'delivered')${scope}
      `).run(now, commandId, ...scopeArgs).changes > 0;
    } else {
      changed = db.prepare(`
        UPDATE device_commands
        SET status = ?, completed_at = ?, error = ?
        WHERE id = ? AND status IN ('pending', 'delivered', 'executing')${scope}
      `).run(status, now, error || null, commandId, ...scopeArgs).changes > 0;
    }
    if (changed) this.notify(this.getCommand(commandId));
    return changed;
  }

  /**
   * Get command history for a device
   */
  getCommandHistory(
    deviceId: string,
    options?: { limit?: number; offset?: number; status?: CommandStatus }
  ): DeviceCommand[] {
    this.initialize();
    const db = this.getDb();

    let query = 'SELECT * FROM device_commands WHERE device_id = ?';
    const params: (string | number)[] = [deviceId];

    if (options?.status) {
      query += ' AND status = ?';
      params.push(options.status);
    }

    query += ' ORDER BY created_at DESC';

    if (options?.limit) {
      query += ' LIMIT ?';
      params.push(options.limit);
    }

    if (options?.offset) {
      query += ' OFFSET ?';
      params.push(options.offset);
    }

    const rows = db.prepare(query).all(...params) as CommandRow[];

    return rows.map(row => this.rowToCommand(row));
  }

  /**
   * Get all commands (limited for performance)
   */
  getAllCommands(limit: number = 100): DeviceCommand[] {
    this.initialize();
    const db = this.getDb();

    const rows = db.prepare(`
      SELECT * FROM device_commands
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit) as CommandRow[];

    return rows.map(row => this.rowToCommand(row));
  }

  /**
   * Get count of pending commands for a device
   */
  getPendingCount(deviceId: string): number {
    this.initialize();
    const db = this.getDb();

    const row = db.prepare(`
      SELECT COUNT(*) as count FROM device_commands
      WHERE device_id = ? AND status = 'pending'
    `).get(deviceId) as { count: number };

    return row.count;
  }

  /**
   * Cancel a pending command
   */
  cancelCommand(commandId: string, deviceId?: string): boolean {
    this.initialize();
    const db = this.getDb();

    const before = this.getCommand(commandId);
    const result = db.prepare(`
      DELETE FROM device_commands
      WHERE id = ? AND status = 'pending'${deviceId !== undefined ? ' AND device_id = ?' : ''}
    `).run(commandId, ...(deviceId !== undefined ? [deviceId] : []));

    if (result.changes > 0 && before) this.notify({ ...before, status: 'expired', error: 'cancelled' });
    return result.changes > 0;
  }

  /**
   * Clear all commands (for testing)
   */
  clear(): void {
    this.initialize();
    const db = this.getDb();
    db.prepare('DELETE FROM device_commands').run();
  }

  /**
   * Convert database row to DeviceCommand object
   */
  private rowToCommand(row: CommandRow): DeviceCommand {
    const command: DeviceCommand = {
      id: row.id,
      deviceId: row.device_id,
      type: row.type as CommandType,
      payload: JSON.parse(row.payload),
      status: row.status as CommandStatus,
      createdAt: row.created_at,
    };

    if (row.delivered_at) {
      command.deliveredAt = row.delivered_at;
    }

    if (row.completed_at) {
      command.completedAt = row.completed_at;
    }

    if (row.error) {
      command.error = row.error;
    }

    if (row.lease_expires_at) {
      command.leaseExpiresAt = row.lease_expires_at;
    }

    if (row.expires_at) {
      command.expiresAt = row.expires_at;
    }

    return command;
  }
}

export const commandStore = new CommandStore();
