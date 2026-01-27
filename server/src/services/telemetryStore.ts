import crypto from 'crypto';
import type Database from 'better-sqlite3';
import { getDatabase } from '../db/connection';
import { initializeSchema } from '../db/schema';

export interface DeviceTelemetry {
  deviceId: string;

  // Battery
  batteryLevel: number | null;
  batteryCharging: boolean | null;
  batteryHealth: string | null;

  // Network
  networkType: string | null;
  networkSsid: string | null;
  ipAddress: string | null;
  signalStrength: number | null;

  // Storage
  storageUsedBytes: number | null;
  storageTotalBytes: number | null;

  // Memory
  memoryUsedBytes: number | null;
  memoryTotalBytes: number | null;

  // Display
  screenOn: boolean | null;
  brightness: number | null;

  // Location
  latitude: number | null;
  longitude: number | null;
  locationAccuracy: number | null;

  // System
  uptimeMs: number | null;
  androidSecurityPatch: string | null;

  updatedAt: number;
}

export interface TelemetryInput {
  deviceId: string;
  batteryLevel?: number;
  batteryCharging?: boolean;
  batteryHealth?: string;
  networkType?: string;
  networkSsid?: string;
  ipAddress?: string;
  signalStrength?: number;
  storageUsedBytes?: number;
  storageTotalBytes?: number;
  memoryUsedBytes?: number;
  memoryTotalBytes?: number;
  screenOn?: boolean;
  brightness?: number;
  latitude?: number;
  longitude?: number;
  locationAccuracy?: number;
  uptimeMs?: number;
  androidSecurityPatch?: string;
}

export interface TelemetryDataPoint {
  timestamp: number;
  batteryLevel: number | null;
  networkType: string | null;
  storageUsedBytes: number | null;
  memoryUsedBytes: number | null;
}

interface TelemetryRow {
  device_id: string;
  battery_level: number | null;
  battery_charging: number | null;
  battery_health: string | null;
  network_type: string | null;
  network_ssid: string | null;
  ip_address: string | null;
  signal_strength: number | null;
  storage_used_bytes: number | null;
  storage_total_bytes: number | null;
  memory_used_bytes: number | null;
  memory_total_bytes: number | null;
  screen_on: number | null;
  brightness: number | null;
  latitude: number | null;
  longitude: number | null;
  location_accuracy: number | null;
  uptime_ms: number | null;
  android_security_patch: string | null;
  updated_at: number;
}

interface HistoryRow {
  id: number;
  device_id: string;
  battery_level: number | null;
  network_type: string | null;
  storage_used_bytes: number | null;
  memory_used_bytes: number | null;
  recorded_at: number;
}

class TelemetryStore {
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
   * Reset to default database
   */
  resetDatabase(): void {
    this.db = null;
    this.initialized = false;
  }

  /**
   * Update device telemetry (upsert)
   */
  updateTelemetry(input: TelemetryInput): DeviceTelemetry {
    this.initialize();
    const db = this.getDb();
    const now = Date.now();

    db.prepare(`
      INSERT INTO device_telemetry (
        device_id, battery_level, battery_charging, battery_health,
        network_type, network_ssid, ip_address, signal_strength,
        storage_used_bytes, storage_total_bytes,
        memory_used_bytes, memory_total_bytes,
        screen_on, brightness,
        latitude, longitude, location_accuracy,
        uptime_ms, android_security_patch,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET
        battery_level = COALESCE(excluded.battery_level, battery_level),
        battery_charging = COALESCE(excluded.battery_charging, battery_charging),
        battery_health = COALESCE(excluded.battery_health, battery_health),
        network_type = COALESCE(excluded.network_type, network_type),
        network_ssid = COALESCE(excluded.network_ssid, network_ssid),
        ip_address = COALESCE(excluded.ip_address, ip_address),
        signal_strength = COALESCE(excluded.signal_strength, signal_strength),
        storage_used_bytes = COALESCE(excluded.storage_used_bytes, storage_used_bytes),
        storage_total_bytes = COALESCE(excluded.storage_total_bytes, storage_total_bytes),
        memory_used_bytes = COALESCE(excluded.memory_used_bytes, memory_used_bytes),
        memory_total_bytes = COALESCE(excluded.memory_total_bytes, memory_total_bytes),
        screen_on = COALESCE(excluded.screen_on, screen_on),
        brightness = COALESCE(excluded.brightness, brightness),
        latitude = COALESCE(excluded.latitude, latitude),
        longitude = COALESCE(excluded.longitude, longitude),
        location_accuracy = COALESCE(excluded.location_accuracy, location_accuracy),
        uptime_ms = COALESCE(excluded.uptime_ms, uptime_ms),
        android_security_patch = COALESCE(excluded.android_security_patch, android_security_patch),
        updated_at = excluded.updated_at
    `).run(
      input.deviceId,
      input.batteryLevel ?? null,
      input.batteryCharging !== undefined ? (input.batteryCharging ? 1 : 0) : null,
      input.batteryHealth ?? null,
      input.networkType ?? null,
      input.networkSsid ?? null,
      input.ipAddress ?? null,
      input.signalStrength ?? null,
      input.storageUsedBytes ?? null,
      input.storageTotalBytes ?? null,
      input.memoryUsedBytes ?? null,
      input.memoryTotalBytes ?? null,
      input.screenOn !== undefined ? (input.screenOn ? 1 : 0) : null,
      input.brightness ?? null,
      input.latitude ?? null,
      input.longitude ?? null,
      input.locationAccuracy ?? null,
      input.uptimeMs ?? null,
      input.androidSecurityPatch ?? null,
      now
    );

    return this.getTelemetry(input.deviceId)!;
  }

  /**
   * Get latest telemetry for a device
   */
  getTelemetry(deviceId: string): DeviceTelemetry | null {
    this.initialize();
    const db = this.getDb();

    const row = db.prepare(`
      SELECT * FROM device_telemetry WHERE device_id = ?
    `).get(deviceId) as TelemetryRow | undefined;

    if (!row) return null;
    return this.rowToTelemetry(row);
  }

  /**
   * Get telemetry for multiple devices
   */
  getBulkTelemetry(deviceIds: string[]): Map<string, DeviceTelemetry> {
    this.initialize();
    const db = this.getDb();

    if (deviceIds.length === 0) {
      return new Map();
    }

    const placeholders = deviceIds.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT * FROM device_telemetry WHERE device_id IN (${placeholders})
    `).all(...deviceIds) as TelemetryRow[];

    const result = new Map<string, DeviceTelemetry>();
    for (const row of rows) {
      result.set(row.device_id, this.rowToTelemetry(row));
    }
    return result;
  }

  /**
   * Get all telemetry (for dashboard)
   */
  getAllTelemetry(): DeviceTelemetry[] {
    this.initialize();
    const db = this.getDb();

    const rows = db.prepare(`
      SELECT * FROM device_telemetry ORDER BY updated_at DESC
    `).all() as TelemetryRow[];

    return rows.map(row => this.rowToTelemetry(row));
  }

  /**
   * Record telemetry snapshot to history (call periodically)
   */
  recordHistory(deviceId: string): void {
    this.initialize();
    const db = this.getDb();

    const telemetry = this.getTelemetry(deviceId);
    if (!telemetry) return;

    db.prepare(`
      INSERT INTO telemetry_history (
        device_id, battery_level, network_type, storage_used_bytes, memory_used_bytes, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      deviceId,
      telemetry.batteryLevel,
      telemetry.networkType,
      telemetry.storageUsedBytes,
      telemetry.memoryUsedBytes,
      Date.now()
    );
  }

  /**
   * Record history for all devices with recent telemetry
   */
  recordAllHistory(maxAgeMs: number = 5 * 60 * 1000): number {
    this.initialize();
    const db = this.getDb();

    const cutoff = Date.now() - maxAgeMs;
    const result = db.prepare(`
      INSERT INTO telemetry_history (device_id, battery_level, network_type, storage_used_bytes, memory_used_bytes, recorded_at)
      SELECT device_id, battery_level, network_type, storage_used_bytes, memory_used_bytes, ?
      FROM device_telemetry
      WHERE updated_at > ?
    `).run(Date.now(), cutoff);

    return result.changes;
  }

  /**
   * Get telemetry history for a device
   */
  getHistory(
    deviceId: string,
    from: number,
    to: number,
    limit: number = 1000
  ): TelemetryDataPoint[] {
    this.initialize();
    const db = this.getDb();

    const rows = db.prepare(`
      SELECT * FROM telemetry_history
      WHERE device_id = ? AND recorded_at >= ? AND recorded_at <= ?
      ORDER BY recorded_at ASC
      LIMIT ?
    `).all(deviceId, from, to, limit) as HistoryRow[];

    return rows.map(row => ({
      timestamp: row.recorded_at,
      batteryLevel: row.battery_level,
      networkType: row.network_type,
      storageUsedBytes: row.storage_used_bytes,
      memoryUsedBytes: row.memory_used_bytes,
    }));
  }

  /**
   * Delete telemetry for a device
   */
  deleteTelemetry(deviceId: string): boolean {
    this.initialize();
    const db = this.getDb();

    const result = db.prepare(`
      DELETE FROM device_telemetry WHERE device_id = ?
    `).run(deviceId);

    // Also delete history
    db.prepare(`
      DELETE FROM telemetry_history WHERE device_id = ?
    `).run(deviceId);

    return result.changes > 0;
  }

  /**
   * Clear all telemetry (for testing)
   */
  clear(): void {
    this.initialize();
    const db = this.getDb();
    db.prepare('DELETE FROM telemetry_history').run();
    db.prepare('DELETE FROM device_telemetry').run();
  }

  private rowToTelemetry(row: TelemetryRow): DeviceTelemetry {
    return {
      deviceId: row.device_id,
      batteryLevel: row.battery_level,
      batteryCharging: row.battery_charging !== null ? row.battery_charging === 1 : null,
      batteryHealth: row.battery_health,
      networkType: row.network_type,
      networkSsid: row.network_ssid,
      ipAddress: row.ip_address,
      signalStrength: row.signal_strength,
      storageUsedBytes: row.storage_used_bytes,
      storageTotalBytes: row.storage_total_bytes,
      memoryUsedBytes: row.memory_used_bytes,
      memoryTotalBytes: row.memory_total_bytes,
      screenOn: row.screen_on !== null ? row.screen_on === 1 : null,
      brightness: row.brightness,
      latitude: row.latitude,
      longitude: row.longitude,
      locationAccuracy: row.location_accuracy,
      uptimeMs: row.uptime_ms,
      androidSecurityPatch: row.android_security_patch,
      updatedAt: row.updated_at,
    };
  }
}

export const telemetryStore = new TelemetryStore();
