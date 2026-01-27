import crypto from 'crypto';
import type Database from 'better-sqlite3';
import { getDatabase } from '../db/connection';
import { initializeSchema } from '../db/schema';

export type DeviceEventType =
  // Connection
  | 'device-online'
  | 'device-offline'
  // Telemetry
  | 'battery-low'
  | 'battery-critical'
  | 'storage-low'
  | 'connectivity-changed'
  // Apps
  | 'app-installed'
  | 'app-uninstalled'
  | 'app-updated'
  // Commands
  | 'command-completed'
  | 'command-failed'
  // Security
  | 'policy-violation'
  | 'tampering-detected'
  | 'unauthorized-factory-reset'
  // System
  | 'boot-completed'
  | 'shutdown-initiated';

export type EventSeverity = 'info' | 'warning' | 'critical';

export interface DeviceEvent {
  id: number;
  deviceId: string;
  eventType: DeviceEventType;
  severity: EventSeverity;
  data: Record<string, unknown> | null;
  acknowledged: boolean;
  acknowledgedAt: number | null;
  acknowledgedBy: string | null;
  createdAt: number;
}

export interface EventInput {
  deviceId: string;
  eventType: DeviceEventType;
  severity: EventSeverity;
  data?: Record<string, unknown>;
}

interface EventRow {
  id: number;
  device_id: string;
  event_type: string;
  severity: string;
  data: string | null;
  acknowledged: number;
  acknowledged_at: number | null;
  acknowledged_by: string | null;
  created_at: number;
}

class EventStore {
  private db: Database.Database | null = null;
  private initialized = false;
  private listeners: ((event: DeviceEvent) => void)[] = [];

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

  /**
   * Subscribe to new events
   */
  subscribe(callback: (event: DeviceEvent) => void): () => void {
    this.listeners.push(callback);
    return () => {
      this.listeners = this.listeners.filter(l => l !== callback);
    };
  }

  /**
   * Record a new event
   */
  recordEvent(input: EventInput): DeviceEvent {
    this.initialize();
    const db = this.getDb();
    const now = Date.now();

    const result = db.prepare(`
      INSERT INTO device_events (device_id, event_type, severity, data, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      input.deviceId,
      input.eventType,
      input.severity,
      input.data ? JSON.stringify(input.data) : null,
      now
    );

    const event = this.getEvent(Number(result.lastInsertRowid))!;

    // Notify listeners
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (e) {
        // Ignore listener errors
      }
    }

    return event;
  }

  /**
   * Get an event by ID
   */
  getEvent(id: number): DeviceEvent | null {
    this.initialize();
    const db = this.getDb();

    const row = db.prepare('SELECT * FROM device_events WHERE id = ?').get(id) as EventRow | undefined;
    if (!row) return null;
    return this.rowToEvent(row);
  }

  /**
   * Get events for a device
   */
  getDeviceEvents(
    deviceId: string,
    options?: {
      eventTypes?: DeviceEventType[];
      severity?: EventSeverity;
      acknowledged?: boolean;
      limit?: number;
      offset?: number;
      from?: number;
      to?: number;
    }
  ): DeviceEvent[] {
    this.initialize();
    const db = this.getDb();

    let query = 'SELECT * FROM device_events WHERE device_id = ?';
    const params: (string | number)[] = [deviceId];

    if (options?.eventTypes && options.eventTypes.length > 0) {
      const placeholders = options.eventTypes.map(() => '?').join(',');
      query += ` AND event_type IN (${placeholders})`;
      params.push(...options.eventTypes);
    }

    if (options?.severity) {
      query += ' AND severity = ?';
      params.push(options.severity);
    }

    if (options?.acknowledged !== undefined) {
      query += ' AND acknowledged = ?';
      params.push(options.acknowledged ? 1 : 0);
    }

    if (options?.from) {
      query += ' AND created_at >= ?';
      params.push(options.from);
    }

    if (options?.to) {
      query += ' AND created_at <= ?';
      params.push(options.to);
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

    const rows = db.prepare(query).all(...params) as EventRow[];
    return rows.map(row => this.rowToEvent(row));
  }

  /**
   * Get all events (for dashboard)
   */
  getAllEvents(options?: {
    eventTypes?: DeviceEventType[];
    severity?: EventSeverity;
    acknowledged?: boolean;
    limit?: number;
    offset?: number;
    from?: number;
    to?: number;
  }): DeviceEvent[] {
    this.initialize();
    const db = this.getDb();

    let query = 'SELECT * FROM device_events WHERE 1=1';
    const params: (string | number)[] = [];

    if (options?.eventTypes && options.eventTypes.length > 0) {
      const placeholders = options.eventTypes.map(() => '?').join(',');
      query += ` AND event_type IN (${placeholders})`;
      params.push(...options.eventTypes);
    }

    if (options?.severity) {
      query += ' AND severity = ?';
      params.push(options.severity);
    }

    if (options?.acknowledged !== undefined) {
      query += ' AND acknowledged = ?';
      params.push(options.acknowledged ? 1 : 0);
    }

    if (options?.from) {
      query += ' AND created_at >= ?';
      params.push(options.from);
    }

    if (options?.to) {
      query += ' AND created_at <= ?';
      params.push(options.to);
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

    const rows = db.prepare(query).all(...params) as EventRow[];
    return rows.map(row => this.rowToEvent(row));
  }

  /**
   * Get unacknowledged critical/warning events
   */
  getUnacknowledgedEvents(minSeverity: EventSeverity = 'warning'): DeviceEvent[] {
    this.initialize();
    const db = this.getDb();

    const severities = minSeverity === 'critical' ? ['critical'] : ['warning', 'critical'];
    const placeholders = severities.map(() => '?').join(',');

    const rows = db.prepare(`
      SELECT * FROM device_events
      WHERE acknowledged = 0 AND severity IN (${placeholders})
      ORDER BY created_at DESC
    `).all(...severities) as EventRow[];

    return rows.map(row => this.rowToEvent(row));
  }

  /**
   * Get unacknowledged event count
   */
  getUnacknowledgedCount(minSeverity: EventSeverity = 'warning'): number {
    this.initialize();
    const db = this.getDb();

    const severities = minSeverity === 'critical' ? ['critical'] : ['warning', 'critical'];
    const placeholders = severities.map(() => '?').join(',');

    const row = db.prepare(`
      SELECT COUNT(*) as count FROM device_events
      WHERE acknowledged = 0 AND severity IN (${placeholders})
    `).get(...severities) as { count: number };

    return row.count;
  }

  /**
   * Acknowledge an event
   */
  acknowledgeEvent(id: number, acknowledgedBy?: string): boolean {
    this.initialize();
    const db = this.getDb();

    const result = db.prepare(`
      UPDATE device_events
      SET acknowledged = 1, acknowledged_at = ?, acknowledged_by = ?
      WHERE id = ? AND acknowledged = 0
    `).run(Date.now(), acknowledgedBy ?? null, id);

    return result.changes > 0;
  }

  /**
   * Acknowledge multiple events
   */
  acknowledgeEvents(ids: number[], acknowledgedBy?: string): number {
    this.initialize();
    const db = this.getDb();

    if (ids.length === 0) return 0;

    const placeholders = ids.map(() => '?').join(',');
    const result = db.prepare(`
      UPDATE device_events
      SET acknowledged = 1, acknowledged_at = ?, acknowledged_by = ?
      WHERE id IN (${placeholders}) AND acknowledged = 0
    `).run(Date.now(), acknowledgedBy ?? null, ...ids);

    return result.changes;
  }

  /**
   * Acknowledge all events for a device
   */
  acknowledgeDeviceEvents(deviceId: string, acknowledgedBy?: string): number {
    this.initialize();
    const db = this.getDb();

    const result = db.prepare(`
      UPDATE device_events
      SET acknowledged = 1, acknowledged_at = ?, acknowledged_by = ?
      WHERE device_id = ? AND acknowledged = 0
    `).run(Date.now(), acknowledgedBy ?? null, deviceId);

    return result.changes;
  }

  /**
   * Get event count for a device
   */
  getEventCount(deviceId: string): number {
    this.initialize();
    const db = this.getDb();

    const row = db.prepare(`
      SELECT COUNT(*) as count FROM device_events WHERE device_id = ?
    `).get(deviceId) as { count: number };

    return row.count;
  }

  /**
   * Delete events for a device
   */
  deleteDeviceEvents(deviceId: string): number {
    this.initialize();
    const db = this.getDb();

    const result = db.prepare('DELETE FROM device_events WHERE device_id = ?').run(deviceId);
    return result.changes;
  }

  /**
   * Clear all events (for testing)
   */
  clear(): void {
    this.initialize();
    const db = this.getDb();
    db.prepare('DELETE FROM device_events').run();
  }

  private rowToEvent(row: EventRow): DeviceEvent {
    return {
      id: row.id,
      deviceId: row.device_id,
      eventType: row.event_type as DeviceEventType,
      severity: row.severity as EventSeverity,
      data: row.data ? JSON.parse(row.data) : null,
      acknowledged: row.acknowledged === 1,
      acknowledgedAt: row.acknowledged_at,
      acknowledgedBy: row.acknowledged_by,
      createdAt: row.created_at,
    };
  }
}

export const eventStore = new EventStore();
