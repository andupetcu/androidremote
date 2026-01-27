import crypto from 'crypto';
import type Database from 'better-sqlite3';
import { getDatabase } from '../db/connection';
import { initializeSchema } from '../db/schema';

export type TransferDirection = 'upload' | 'download';
export type TransferStatus = 'pending' | 'transferring' | 'completed' | 'failed' | 'cancelled';

export interface FileTransfer {
  id: string;
  deviceId: string;
  direction: TransferDirection;
  devicePath: string;
  serverPath: string | null;
  fileName: string | null;
  fileSize: number | null;
  mimeType: string | null;
  status: TransferStatus;
  progress: number;
  error: string | null;
  createdAt: number;
  completedAt: number | null;
}

export interface TransferInput {
  deviceId: string;
  direction: TransferDirection;
  devicePath: string;
  serverPath?: string;
  fileName?: string;
  fileSize?: number;
  mimeType?: string;
}

interface TransferRow {
  id: string;
  device_id: string;
  direction: string;
  device_path: string;
  server_path: string | null;
  file_name: string | null;
  file_size: number | null;
  mime_type: string | null;
  status: string;
  progress: number;
  error: string | null;
  created_at: number;
  completed_at: number | null;
}

class FileTransferStore {
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

  setDatabase(database: Database.Database): void {
    this.db = database;
    this.initialized = false;
    initializeSchema(database);
    this.initialized = true;
  }

  resetDatabase(): void {
    this.db = null;
    this.initialized = false;
  }

  private generateId(): string {
    return `ft-${crypto.randomBytes(8).toString('hex')}`;
  }

  /**
   * Create a new file transfer
   */
  createTransfer(input: TransferInput): FileTransfer {
    this.initialize();
    const db = this.getDb();
    const id = this.generateId();
    const now = Date.now();

    db.prepare(`
      INSERT INTO file_transfers (
        id, device_id, direction, device_path, server_path,
        file_name, file_size, mime_type, status, progress, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)
    `).run(
      id,
      input.deviceId,
      input.direction,
      input.devicePath,
      input.serverPath ?? null,
      input.fileName ?? null,
      input.fileSize ?? null,
      input.mimeType ?? null,
      now
    );

    return this.getTransfer(id)!;
  }

  /**
   * Get a transfer by ID
   */
  getTransfer(id: string): FileTransfer | null {
    this.initialize();
    const db = this.getDb();

    const row = db.prepare('SELECT * FROM file_transfers WHERE id = ?').get(id) as TransferRow | undefined;
    if (!row) return null;
    return this.rowToTransfer(row);
  }

  /**
   * Get transfers for a device
   */
  getDeviceTransfers(
    deviceId: string,
    options?: {
      direction?: TransferDirection;
      status?: TransferStatus;
      limit?: number;
      offset?: number;
    }
  ): FileTransfer[] {
    this.initialize();
    const db = this.getDb();

    let query = 'SELECT * FROM file_transfers WHERE device_id = ?';
    const params: (string | number)[] = [deviceId];

    if (options?.direction) {
      query += ' AND direction = ?';
      params.push(options.direction);
    }

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

    const rows = db.prepare(query).all(...params) as TransferRow[];
    return rows.map(row => this.rowToTransfer(row));
  }

  /**
   * Get all active transfers
   */
  getActiveTransfers(): FileTransfer[] {
    this.initialize();
    const db = this.getDb();

    const rows = db.prepare(`
      SELECT * FROM file_transfers
      WHERE status IN ('pending', 'transferring')
      ORDER BY created_at ASC
    `).all() as TransferRow[];

    return rows.map(row => this.rowToTransfer(row));
  }

  /**
   * Update transfer status
   */
  updateStatus(id: string, status: TransferStatus, error?: string): boolean {
    this.initialize();
    const db = this.getDb();

    const completedAt = ['completed', 'failed', 'cancelled'].includes(status) ? Date.now() : null;

    const result = db.prepare(`
      UPDATE file_transfers
      SET status = ?, error = ?, completed_at = ?
      WHERE id = ?
    `).run(status, error ?? null, completedAt, id);

    return result.changes > 0;
  }

  /**
   * Update transfer progress
   */
  updateProgress(id: string, progress: number): boolean {
    this.initialize();
    const db = this.getDb();

    const result = db.prepare(`
      UPDATE file_transfers
      SET progress = ?, status = CASE WHEN status = 'pending' THEN 'transferring' ELSE status END
      WHERE id = ?
    `).run(Math.min(100, Math.max(0, progress)), id);

    return result.changes > 0;
  }

  /**
   * Update server path (after file is saved)
   */
  updateServerPath(id: string, serverPath: string, fileSize?: number): boolean {
    this.initialize();
    const db = this.getDb();

    let query = 'UPDATE file_transfers SET server_path = ?';
    const params: (string | number)[] = [serverPath];

    if (fileSize !== undefined) {
      query += ', file_size = ?';
      params.push(fileSize);
    }

    query += ' WHERE id = ?';
    params.push(id);

    const result = db.prepare(query).run(...params);
    return result.changes > 0;
  }

  /**
   * Mark transfer as completed
   */
  completeTransfer(id: string, serverPath?: string, fileSize?: number): boolean {
    this.initialize();
    const db = this.getDb();

    const result = db.prepare(`
      UPDATE file_transfers
      SET status = 'completed', progress = 100, completed_at = ?,
          server_path = COALESCE(?, server_path),
          file_size = COALESCE(?, file_size)
      WHERE id = ?
    `).run(Date.now(), serverPath ?? null, fileSize ?? null, id);

    return result.changes > 0;
  }

  /**
   * Mark transfer as failed
   */
  failTransfer(id: string, error: string): boolean {
    this.initialize();
    const db = this.getDb();

    const result = db.prepare(`
      UPDATE file_transfers
      SET status = 'failed', error = ?, completed_at = ?
      WHERE id = ?
    `).run(error, Date.now(), id);

    return result.changes > 0;
  }

  /**
   * Cancel a transfer
   */
  cancelTransfer(id: string): boolean {
    this.initialize();
    const db = this.getDb();

    const result = db.prepare(`
      UPDATE file_transfers
      SET status = 'cancelled', completed_at = ?
      WHERE id = ? AND status IN ('pending', 'transferring')
    `).run(Date.now(), id);

    return result.changes > 0;
  }

  /**
   * Delete a transfer record
   */
  deleteTransfer(id: string): boolean {
    this.initialize();
    const db = this.getDb();

    const result = db.prepare('DELETE FROM file_transfers WHERE id = ?').run(id);
    return result.changes > 0;
  }

  /**
   * Get pending transfer count for a device
   */
  getPendingCount(deviceId: string): number {
    this.initialize();
    const db = this.getDb();

    const row = db.prepare(`
      SELECT COUNT(*) as count FROM file_transfers
      WHERE device_id = ? AND status IN ('pending', 'transferring')
    `).get(deviceId) as { count: number };

    return row.count;
  }

  /**
   * Clear all transfers (for testing)
   */
  clear(): void {
    this.initialize();
    const db = this.getDb();
    db.prepare('DELETE FROM file_transfers').run();
  }

  private rowToTransfer(row: TransferRow): FileTransfer {
    return {
      id: row.id,
      deviceId: row.device_id,
      direction: row.direction as TransferDirection,
      devicePath: row.device_path,
      serverPath: row.server_path,
      fileName: row.file_name,
      fileSize: row.file_size,
      mimeType: row.mime_type,
      status: row.status as TransferStatus,
      progress: row.progress,
      error: row.error,
      createdAt: row.created_at,
      completedAt: row.completed_at,
    };
  }
}

export const fileTransferStore = new FileTransferStore();
