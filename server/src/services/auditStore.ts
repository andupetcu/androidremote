import crypto from 'crypto';
import type Database from 'better-sqlite3';
import { getDatabase } from '../db/connection';
import { initializeSchema } from '../db/schema';

export type ActorType = 'admin' | 'device' | 'system';

export type AuditAction =
  // Device management
  | 'device.enrolled'
  | 'device.unenrolled'
  | 'device.renamed'
  | 'device.group_changed'
  | 'device.policy_changed'
  // Commands
  | 'command.queued'
  | 'command.completed'
  | 'command.failed'
  | 'command.cancelled'
  | 'command.batch_queued'
  // Policies
  | 'policy.created'
  | 'policy.updated'
  | 'policy.deleted'
  | 'policy.assigned'
  // Groups
  | 'group.created'
  | 'group.updated'
  | 'group.deleted'
  | 'group.device_added'
  | 'group.device_removed'
  // Apps
  | 'app.approved'
  | 'app.blocked'
  | 'app.installed'
  | 'app.uninstalled'
  | 'app.uploaded'
  | 'app.updated'
  | 'app.deleted'
  | 'app.deployed'
  // Files
  | 'file.upload_requested'
  | 'file.download_requested'
  | 'file.transfer_completed'
  | 'file.transfer_failed'
  // Admin
  | 'admin.login'
  | 'admin.logout'
  | 'token.created'
  | 'token.revoked'
  // Events
  | 'event.acknowledged';

export type ResourceType =
  | 'device'
  | 'policy'
  | 'group'
  | 'command'
  | 'app'
  | 'token'
  | 'file'
  | 'event';

export interface AuditLog {
  id: string;
  timestamp: number;
  actorType: ActorType;
  actorId: string | null;
  action: AuditAction;
  resourceType: ResourceType;
  resourceId: string | null;
  details: Record<string, unknown> | null;
  ipAddress: string | null;
}

export interface AuditInput {
  actorType: ActorType;
  actorId?: string;
  action: AuditAction;
  resourceType: ResourceType;
  resourceId?: string;
  details?: Record<string, unknown>;
  ipAddress?: string;
}

interface AuditRow {
  id: string;
  timestamp: number;
  actor_type: string;
  actor_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  details: string | null;
  ip_address: string | null;
}

class AuditStore {
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
    return `aud-${crypto.randomBytes(8).toString('hex')}`;
  }

  /**
   * Record an audit log entry
   */
  log(input: AuditInput): AuditLog {
    this.initialize();
    const db = this.getDb();
    const id = this.generateId();
    const now = Date.now();

    db.prepare(`
      INSERT INTO audit_logs (id, timestamp, actor_type, actor_id, action, resource_type, resource_id, details, ip_address)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      now,
      input.actorType,
      input.actorId ?? null,
      input.action,
      input.resourceType,
      input.resourceId ?? null,
      input.details ? JSON.stringify(input.details) : null,
      input.ipAddress ?? null
    );

    return this.getLog(id)!;
  }

  /**
   * Get an audit log by ID
   */
  getLog(id: string): AuditLog | null {
    this.initialize();
    const db = this.getDb();

    const row = db.prepare('SELECT * FROM audit_logs WHERE id = ?').get(id) as AuditRow | undefined;
    if (!row) return null;
    return this.rowToLog(row);
  }

  /**
   * Get audit logs with filters
   */
  getLogs(options?: {
    actorType?: ActorType;
    actorId?: string;
    action?: AuditAction;
    resourceType?: ResourceType;
    resourceId?: string;
    from?: number;
    to?: number;
    limit?: number;
    offset?: number;
  }): AuditLog[] {
    this.initialize();
    const db = this.getDb();

    let query = 'SELECT * FROM audit_logs WHERE 1=1';
    const params: (string | number)[] = [];

    if (options?.actorType) {
      query += ' AND actor_type = ?';
      params.push(options.actorType);
    }

    if (options?.actorId) {
      query += ' AND actor_id = ?';
      params.push(options.actorId);
    }

    if (options?.action) {
      query += ' AND action = ?';
      params.push(options.action);
    }

    if (options?.resourceType) {
      query += ' AND resource_type = ?';
      params.push(options.resourceType);
    }

    if (options?.resourceId) {
      query += ' AND resource_id = ?';
      params.push(options.resourceId);
    }

    if (options?.from) {
      query += ' AND timestamp >= ?';
      params.push(options.from);
    }

    if (options?.to) {
      query += ' AND timestamp <= ?';
      params.push(options.to);
    }

    query += ' ORDER BY timestamp DESC';

    if (options?.limit) {
      query += ' LIMIT ?';
      params.push(options.limit);
    }

    if (options?.offset) {
      query += ' OFFSET ?';
      params.push(options.offset);
    }

    const rows = db.prepare(query).all(...params) as AuditRow[];
    return rows.map(row => this.rowToLog(row));
  }

  /**
   * Get logs for a specific resource
   */
  getResourceLogs(resourceType: ResourceType, resourceId: string, limit: number = 100): AuditLog[] {
    return this.getLogs({ resourceType, resourceId, limit });
  }

  /**
   * Get logs for a specific actor
   */
  getActorLogs(actorType: ActorType, actorId: string, limit: number = 100): AuditLog[] {
    return this.getLogs({ actorType, actorId, limit });
  }

  /**
   * Get recent logs
   */
  getRecentLogs(limit: number = 100): AuditLog[] {
    return this.getLogs({ limit });
  }

  /**
   * Get log count
   */
  getLogCount(options?: {
    actorType?: ActorType;
    resourceType?: ResourceType;
    from?: number;
    to?: number;
  }): number {
    this.initialize();
    const db = this.getDb();

    let query = 'SELECT COUNT(*) as count FROM audit_logs WHERE 1=1';
    const params: (string | number)[] = [];

    if (options?.actorType) {
      query += ' AND actor_type = ?';
      params.push(options.actorType);
    }

    if (options?.resourceType) {
      query += ' AND resource_type = ?';
      params.push(options.resourceType);
    }

    if (options?.from) {
      query += ' AND timestamp >= ?';
      params.push(options.from);
    }

    if (options?.to) {
      query += ' AND timestamp <= ?';
      params.push(options.to);
    }

    const row = db.prepare(query).get(...params) as { count: number };
    return row.count;
  }

  /**
   * Export logs as CSV
   */
  exportLogs(options?: {
    from?: number;
    to?: number;
  }): string {
    const logs = this.getLogs({
      from: options?.from,
      to: options?.to,
      limit: 100000, // Max export size
    });

    const headers = ['id', 'timestamp', 'actor_type', 'actor_id', 'action', 'resource_type', 'resource_id', 'details', 'ip_address'];
    const rows = logs.map(log => [
      log.id,
      new Date(log.timestamp).toISOString(),
      log.actorType,
      log.actorId ?? '',
      log.action,
      log.resourceType,
      log.resourceId ?? '',
      log.details ? JSON.stringify(log.details) : '',
      log.ipAddress ?? '',
    ]);

    return [headers.join(','), ...rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))].join('\n');
  }

  /**
   * Clear all logs (for testing)
   */
  clear(): void {
    this.initialize();
    const db = this.getDb();
    db.prepare('DELETE FROM audit_logs').run();
  }

  private rowToLog(row: AuditRow): AuditLog {
    return {
      id: row.id,
      timestamp: row.timestamp,
      actorType: row.actor_type as ActorType,
      actorId: row.actor_id,
      action: row.action as AuditAction,
      resourceType: row.resource_type as ResourceType,
      resourceId: row.resource_id,
      details: row.details ? JSON.parse(row.details) : null,
      ipAddress: row.ip_address,
    };
  }
}

export const auditStore = new AuditStore();
