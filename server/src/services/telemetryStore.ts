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

  // Kiosk and protected packages, as reported by the device
  kioskActive: boolean | null;
  kioskPackage: string | null;
  lockTask: boolean | null;
  protectedPackages: string[] | null;

  updatedAt: number;
}

/**
 * A telemetry report. A key that is present with `null` clears the stored value; an absent key keeps it.
 */
export interface TelemetryInput {
  deviceId: string;
  batteryLevel?: number | null;
  batteryCharging?: boolean | null;
  batteryHealth?: string | null;
  networkType?: string | null;
  networkSsid?: string | null;
  ipAddress?: string | null;
  signalStrength?: number | null;
  storageUsedBytes?: number | null;
  storageTotalBytes?: number | null;
  memoryUsedBytes?: number | null;
  memoryTotalBytes?: number | null;
  screenOn?: boolean | null;
  brightness?: number | null;
  latitude?: number | null;
  longitude?: number | null;
  locationAccuracy?: number | null;
  uptimeMs?: number | null;
  androidSecurityPatch?: string | null;
  kioskActive?: boolean | null;
  kioskPackage?: string | null;
  lockTask?: boolean | null;
  protectedPackages?: string[] | null;
  /** Epoch ms when the device took the sample (buffered samples). Used when plausible. */
  collectedAt?: number;
}

export type BatteryAlertState = 'ok' | 'low' | 'critical';
export type BatteryAlert = 'battery-low' | 'battery-critical';

/** Thresholds with hysteresis (SR-08): low below 20 until 25 is reached; critical below 5 until 10 is reached. */
export function nextBatteryState(prev: BatteryAlertState, level: number): { state: BatteryAlertState; alert: BatteryAlert | null } {
  let state = prev;
  if (level < 5) {
    state = 'critical';
  } else if (prev === 'critical') {
    if (level >= 10) state = level >= 25 ? 'ok' : 'low';
  } else if (level < 20) {
    state = 'low';
  } else if (prev === 'low' && level >= 25) {
    state = 'ok';
  }
  let alert: BatteryAlert | null = null;
  if (state === 'critical' && prev !== 'critical') alert = 'battery-critical';
  else if (state === 'low' && prev === 'ok') alert = 'battery-low';
  return { state, alert };
}

export const MAX_HISTORY_POINTS = 5000;
const DEFAULT_HISTORY_POINTS = 1000;
const MAX_SAMPLE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 60 * 1000;

/** Bucket width for history downsampling: minute|hour|day or `<n>m|h|d` (1 minute to 7 days). Null if invalid. */
export function parseBucketMs(raw: string): number | null {
  const named: Record<string, number> = { minute: 60_000, hour: 3_600_000, day: 86_400_000 };
  if (raw in named) return named[raw];
  const m = /^(\d{1,4})([mhd])$/.exec(raw);
  if (!m) return null;
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 'm' | 'h' | 'd'];
  const ms = parseInt(m[1], 10) * unit;
  return ms >= 60_000 && ms <= 7 * 86_400_000 ? ms : null;
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
  kiosk_active: number | null;
  kiosk_package: string | null;
  lock_task: number | null;
  protected_packages: string | null;
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

const FIELDS: Array<[keyof TelemetryInput, string, 'num' | 'str' | 'bool' | 'json']> = [
  ['batteryLevel', 'battery_level', 'num'],
  ['batteryCharging', 'battery_charging', 'bool'],
  ['batteryHealth', 'battery_health', 'str'],
  ['networkType', 'network_type', 'str'],
  ['networkSsid', 'network_ssid', 'str'],
  ['ipAddress', 'ip_address', 'str'],
  ['signalStrength', 'signal_strength', 'num'],
  ['storageUsedBytes', 'storage_used_bytes', 'num'],
  ['storageTotalBytes', 'storage_total_bytes', 'num'],
  ['memoryUsedBytes', 'memory_used_bytes', 'num'],
  ['memoryTotalBytes', 'memory_total_bytes', 'num'],
  ['screenOn', 'screen_on', 'bool'],
  ['brightness', 'brightness', 'num'],
  ['latitude', 'latitude', 'num'],
  ['longitude', 'longitude', 'num'],
  ['locationAccuracy', 'location_accuracy', 'num'],
  ['uptimeMs', 'uptime_ms', 'num'],
  ['androidSecurityPatch', 'android_security_patch', 'str'],
  ['kioskActive', 'kiosk_active', 'bool'],
  ['kioskPackage', 'kiosk_package', 'str'],
  ['lockTask', 'lock_task', 'bool'],
  ['protectedPackages', 'protected_packages', 'json'],
];

function parseJsonList(raw: string | null): string[] | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null;
  } catch {
    return null;
  }
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
   * Update device telemetry (upsert). Keys present in the input are written, `null` clears a value,
   * absent keys keep what is stored (SR-09).
   */
  updateTelemetry(input: TelemetryInput, updatedAt: number = Date.now()): DeviceTelemetry {
    this.initialize();
    this.writeLatest(input, updatedAt);
    return this.getTelemetry(input.deviceId)!;
  }

  private writeLatest(input: TelemetryInput, updatedAt: number): void {
    const db = this.getDb();
    const cols: string[] = [];
    const vals: Array<string | number | null> = [];
    for (const [key, col, kind] of FIELDS) {
      const v = (input as unknown as Record<string, unknown>)[key];
      if (v === undefined) continue;
      cols.push(col);
      vals.push(v === null ? null : kind === 'bool' ? (v ? 1 : 0) : kind === 'json' ? JSON.stringify(v) : (v as string | number));
    }
    const names = ['device_id', ...cols, 'updated_at'];
    const update = [...cols.map(c => `${c} = excluded.${c}`), 'updated_at = excluded.updated_at'].join(', ');
    db.prepare(`
      INSERT INTO device_telemetry (${names.join(', ')})
      VALUES (${names.map(() => '?').join(', ')})
      ON CONFLICT(device_id) DO UPDATE SET ${update}
    `).run(input.deviceId, ...vals, updatedAt);
  }

  /**
   * Apply one telemetry sample (live report or buffered batch sample): write the history row, update the
   * latest state unless a newer one is already stored, and work out the battery alert transition (SR-08, SR-09).
   * Samples must be applied oldest first.
   */
  recordSample(input: TelemetryInput): { telemetry: DeviceTelemetry; alert: BatteryAlert | null; batteryLevel: number | null } {
    this.initialize();
    const db = this.getDb();
    const now = Date.now();
    const claimed = input.collectedAt;
    const at = typeof claimed === 'number' && Number.isFinite(claimed) && claimed >= now - MAX_SAMPLE_AGE_MS && claimed <= now + MAX_CLOCK_SKEW_MS
      ? Math.floor(claimed) : now;

    return db.transaction(() => {
      const existing = db.prepare('SELECT updated_at, battery_alert_state FROM device_telemetry WHERE device_id = ?')
        .get(input.deviceId) as { updated_at: number; battery_alert_state: string | null } | undefined;
      const newest = !existing || at >= existing.updated_at;
      let alert: BatteryAlert | null = null;

      if (newest) {
        this.writeLatest(input, at);
        if (typeof input.batteryLevel === 'number') {
          const prev = (existing?.battery_alert_state as BatteryAlertState | null) ?? 'ok';
          const next = nextBatteryState(prev, input.batteryLevel);
          alert = next.alert;
          db.prepare('UPDATE device_telemetry SET battery_alert_state = ? WHERE device_id = ?').run(next.state, input.deviceId);
        }
      }

      const merged = newest ? this.getTelemetry(input.deviceId) : null;
      const pick = <T>(own: T | null | undefined, fallback: T | null | undefined): T | null => own ?? fallback ?? null;
      db.prepare(`
        INSERT OR IGNORE INTO telemetry_history (
          device_id, battery_level, network_type, storage_used_bytes, memory_used_bytes, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        input.deviceId,
        pick(input.batteryLevel, merged?.batteryLevel),
        pick(input.networkType, merged?.networkType),
        pick(input.storageUsedBytes, merged?.storageUsedBytes),
        pick(input.memoryUsedBytes, merged?.memoryUsedBytes),
        at
      );

      return {
        telemetry: this.getTelemetry(input.deviceId)!,
        alert,
        batteryLevel: typeof input.batteryLevel === 'number' ? input.batteryLevel : null,
      };
    })();
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
   * Get telemetry history for a device, oldest first. With `bucketMs` the rows are averaged per bucket in SQL
   * (battery), network type, storage and memory take the last value of the bucket. When more points match
   * than `limit`, the newest `limit` are returned.
   */
  getHistory(
    deviceId: string,
    from: number,
    to: number,
    options: number | { limit?: number; bucketMs?: number | null } = {}
  ): TelemetryDataPoint[] {
    this.initialize();
    const db = this.getDb();
    const opts = typeof options === 'number' ? { limit: options } : options;
    const limit = Number.isFinite(opts.limit) && (opts.limit as number) > 0
      ? Math.min(Math.floor(opts.limit as number), MAX_HISTORY_POINTS) : DEFAULT_HISTORY_POINTS;

    if (opts.bucketMs) {
      const rows = db.prepare(`
        SELECT (recorded_at / CAST(@b AS INTEGER)) * CAST(@b AS INTEGER) AS bucket_start,
               ROUND(AVG(battery_level)) AS battery_level,
               network_type, storage_used_bytes, memory_used_bytes, MAX(recorded_at) AS last_at
        FROM telemetry_history
        WHERE device_id = @d AND recorded_at >= @from AND recorded_at <= @to
        GROUP BY bucket_start
        ORDER BY bucket_start DESC
        LIMIT @limit
      `).all({ b: opts.bucketMs, d: deviceId, from, to, limit }) as Array<{
        bucket_start: number; battery_level: number | null; network_type: string | null;
        storage_used_bytes: number | null; memory_used_bytes: number | null;
      }>;
      return rows.reverse().map(r => ({
        timestamp: r.bucket_start,
        batteryLevel: r.battery_level,
        networkType: r.network_type,
        storageUsedBytes: r.storage_used_bytes,
        memoryUsedBytes: r.memory_used_bytes,
      }));
    }

    const rows = db.prepare(`
      SELECT * FROM telemetry_history
      WHERE device_id = ? AND recorded_at >= ? AND recorded_at <= ?
      ORDER BY recorded_at DESC
      LIMIT ?
    `).all(deviceId, from, to, limit) as HistoryRow[];

    return rows.reverse().map(row => ({
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
      kioskActive: row.kiosk_active !== null ? row.kiosk_active === 1 : null,
      kioskPackage: row.kiosk_package,
      lockTask: row.lock_task !== null ? row.lock_task === 1 : null,
      protectedPackages: parseJsonList(row.protected_packages),
      updatedAt: row.updated_at,
    };
  }
}

export const telemetryStore = new TelemetryStore();
