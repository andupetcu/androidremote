import crypto from 'crypto';
import type Database from 'better-sqlite3';
import { getDatabase } from '../db/connection';
import { initializeSchema, COMMAND_TYPES } from '../db/schema';

export type CommandType = typeof COMMAND_TYPES[number];

export type CommandStatus =
  | 'pending'
  | 'delivered'
  | 'executing'
  | 'completed'
  | 'failed';

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
}

export interface InstallApkPayload {
  url: string;
  packageName: string;
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
}

class CommandStore {
  private db: Database.Database | null = null;
  private initialized = false;

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
   * Queue a command for a device
   */
  queueCommand(
    deviceId: string,
    type: CommandType,
    payload: Record<string, unknown> = {}
  ): DeviceCommand {
    this.initialize();
    const db = this.getDb();

    const id = this.generateCommandId();
    const now = Date.now();
    const payloadJson = JSON.stringify(payload);

    db.prepare(`
      INSERT INTO device_commands (id, device_id, type, payload, status, created_at)
      VALUES (?, ?, ?, ?, 'pending', ?)
    `).run(id, deviceId, type, payloadJson, now);

    return {
      id,
      deviceId,
      type,
      payload,
      status: 'pending',
      createdAt: now,
    };
  }

  /**
   * Get pending commands for a device
   * Also marks them as 'delivered'
   */
  getPendingCommands(deviceId: string): DeviceCommand[] {
    this.initialize();
    const db = this.getDb();

    const rows = db.prepare(`
      SELECT * FROM device_commands
      WHERE device_id = ? AND status = 'pending'
      ORDER BY created_at ASC
    `).all(deviceId) as CommandRow[];

    if (rows.length === 0) {
      return [];
    }

    // Mark as delivered
    const now = Date.now();
    const ids = rows.map(r => r.id);
    const placeholders = ids.map(() => '?').join(',');

    db.prepare(`
      UPDATE device_commands
      SET status = 'delivered', delivered_at = ?
      WHERE id IN (${placeholders})
    `).run(now, ...ids);

    return rows.map(row => ({
      ...this.rowToCommand(row),
      status: 'delivered' as CommandStatus,
      deliveredAt: now,
    }));
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
    error?: string
  ): boolean {
    this.initialize();
    const db = this.getDb();

    const now = Date.now();

    if (status === 'executing') {
      const result = db.prepare(`
        UPDATE device_commands
        SET status = 'executing'
        WHERE id = ? AND status IN ('pending', 'delivered')
      `).run(commandId);
      return result.changes > 0;
    }

    const result = db.prepare(`
      UPDATE device_commands
      SET status = ?, completed_at = ?, error = ?
      WHERE id = ? AND status IN ('pending', 'delivered', 'executing')
    `).run(status, now, error || null, commandId);

    return result.changes > 0;
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
  cancelCommand(commandId: string): boolean {
    this.initialize();
    const db = this.getDb();

    const result = db.prepare(`
      DELETE FROM device_commands
      WHERE id = ? AND status = 'pending'
    `).run(commandId);

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

    return command;
  }
}

export const commandStore = new CommandStore();
