import type Database from 'better-sqlite3';
import { getDatabase } from '../db/connection';
import { initializeSchema } from '../db/schema';

export interface Device {
  id: string;
  name: string;
  model: string | null;
  androidVersion: string | null;
  enrolledAt: number;
  lastSeenAt: number | null;
  status: 'online' | 'offline';
  publicKey: string | null;

  // Extended device info (Phase 1)
  manufacturer: string | null;
  serialNumber: string | null;
  imei: string | null;
  phoneNumber: string | null;
  buildFingerprint: string | null;
  kernelVersion: string | null;
  displayResolution: string | null;
  cpuArchitecture: string | null;
  totalRam: number | null;

  // Group and policy assignment (Phase 3)
  groupId: string | null;
  policyId: string | null;
  complianceStatus: 'compliant' | 'non_compliant' | 'pending';
}

export interface DeviceInput {
  id: string;
  name: string;
  model?: string;
  androidVersion?: string;
  publicKey?: string;

  // Extended fields
  manufacturer?: string;
  serialNumber?: string;
  imei?: string;
  phoneNumber?: string;
  buildFingerprint?: string;
  kernelVersion?: string;
  displayResolution?: string;
  cpuArchitecture?: string;
  totalRam?: number;
}

interface DeviceRow {
  id: string;
  name: string;
  model: string | null;
  android_version: string | null;
  enrolled_at: number;
  last_seen_at: number | null;
  status: string;
  public_key: string | null;

  // Extended fields
  manufacturer: string | null;
  serial_number: string | null;
  imei: string | null;
  phone_number: string | null;
  build_fingerprint: string | null;
  kernel_version: string | null;
  display_resolution: string | null;
  cpu_architecture: string | null;
  total_ram: number | null;
  group_id: string | null;
  policy_id: string | null;
  compliance_status: string | null;
}

/**
 * Device store - manages enrolled devices in the database
 */
class DeviceStore {
  private db: Database.Database | null = null;
  private initialized = false;

  private getDb(): Database.Database {
    if (!this.db) {
      this.db = getDatabase();
    }
    return this.db;
  }

  /**
   * Initialize the store (creates tables if needed)
   */
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
   * Enroll a new device
   */
  enrollDevice(input: DeviceInput): Device {
    this.initialize();

    const stmt = this.getDb().prepare(`
      INSERT INTO devices (
        id, name, model, android_version, public_key, status, enrolled_at,
        manufacturer, serial_number, imei, phone_number, build_fingerprint,
        kernel_version, display_resolution, cpu_architecture, total_ram
      )
      VALUES (?, ?, ?, ?, ?, 'offline', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        model = COALESCE(excluded.model, model),
        android_version = COALESCE(excluded.android_version, android_version),
        public_key = COALESCE(excluded.public_key, public_key),
        manufacturer = COALESCE(excluded.manufacturer, manufacturer),
        serial_number = COALESCE(excluded.serial_number, serial_number),
        imei = COALESCE(excluded.imei, imei),
        phone_number = COALESCE(excluded.phone_number, phone_number),
        build_fingerprint = COALESCE(excluded.build_fingerprint, build_fingerprint),
        kernel_version = COALESCE(excluded.kernel_version, kernel_version),
        display_resolution = COALESCE(excluded.display_resolution, display_resolution),
        cpu_architecture = COALESCE(excluded.cpu_architecture, cpu_architecture),
        total_ram = COALESCE(excluded.total_ram, total_ram)
    `);

    const now = Date.now();
    stmt.run(
      input.id,
      input.name,
      input.model || null,
      input.androidVersion || null,
      input.publicKey || null,
      now,
      input.manufacturer || null,
      input.serialNumber || null,
      input.imei || null,
      input.phoneNumber || null,
      input.buildFingerprint || null,
      input.kernelVersion || null,
      input.displayResolution || null,
      input.cpuArchitecture || null,
      input.totalRam || null
    );

    return this.getDevice(input.id)!;
  }

  /**
   * Get a device by ID
   */
  getDevice(id: string): Device | null {
    this.initialize();

    const row = this.getDb().prepare(`
      SELECT * FROM devices WHERE id = ?
    `).get(id) as DeviceRow | undefined;

    if (!row) return null;

    return this.rowToDevice(row);
  }

  /**
   * Get all enrolled devices
   */
  getAllDevices(): Device[] {
    this.initialize();

    const rows = this.getDb().prepare(`
      SELECT * FROM devices ORDER BY enrolled_at DESC
    `).all() as DeviceRow[];

    return rows.map((row) => this.rowToDevice(row));
  }

  /**
   * Update device status (online/offline)
   */
  updateDeviceStatus(id: string, status: 'online' | 'offline'): boolean {
    this.initialize();

    const updates: Record<string, unknown> = { status };
    if (status === 'online') {
      updates.last_seen_at = Date.now();
    }

    const result = this.getDb().prepare(`
      UPDATE devices SET status = ?, last_seen_at = ? WHERE id = ?
    `).run(status, status === 'online' ? Date.now() : null, id);

    return result.changes > 0;
  }

  /**
   * Update device last seen timestamp
   */
  updateLastSeen(id: string): boolean {
    this.initialize();

    const result = this.getDb().prepare(`
      UPDATE devices SET last_seen_at = ?, status = 'online' WHERE id = ?
    `).run(Date.now(), id);

    return result.changes > 0;
  }

  /**
   * Unenroll (delete) a device
   */
  unenrollDevice(id: string): boolean {
    this.initialize();

    const result = this.getDb().prepare(`
      DELETE FROM devices WHERE id = ?
    `).run(id);

    return result.changes > 0;
  }

  /**
   * Count enrolled devices
   */
  getDeviceCount(): number {
    this.initialize();

    const row = this.getDb().prepare(`
      SELECT COUNT(*) as count FROM devices
    `).get() as { count: number };

    return row.count;
  }

  /**
   * Check if a device is enrolled
   */
  isDeviceEnrolled(id: string): boolean {
    this.initialize();

    const row = this.getDb().prepare(`
      SELECT 1 FROM devices WHERE id = ? LIMIT 1
    `).get(id);

    return !!row;
  }

  /**
   * Update device group assignment
   */
  updateDeviceGroup(id: string, groupId: string | null): boolean {
    this.initialize();

    const result = this.getDb().prepare(`
      UPDATE devices SET group_id = ? WHERE id = ?
    `).run(groupId, id);

    return result.changes > 0;
  }

  /**
   * Update device policy assignment
   */
  updateDevicePolicy(id: string, policyId: string | null): boolean {
    this.initialize();

    const result = this.getDb().prepare(`
      UPDATE devices SET policy_id = ? WHERE id = ?
    `).run(policyId, id);

    return result.changes > 0;
  }

  /**
   * Update device compliance status
   */
  updateComplianceStatus(id: string, status: 'compliant' | 'non_compliant' | 'pending'): boolean {
    this.initialize();

    const result = this.getDb().prepare(`
      UPDATE devices SET compliance_status = ? WHERE id = ?
    `).run(status, id);

    return result.changes > 0;
  }

  /**
   * Get devices by group
   */
  getDevicesByGroup(groupId: string): Device[] {
    this.initialize();

    const rows = this.getDb().prepare(`
      SELECT * FROM devices WHERE group_id = ? ORDER BY name ASC
    `).all(groupId) as DeviceRow[];

    return rows.map((row) => this.rowToDevice(row));
  }

  /**
   * Update device name
   */
  updateDeviceName(id: string, name: string): boolean {
    this.initialize();

    const result = this.getDb().prepare(`
      UPDATE devices SET name = ? WHERE id = ?
    `).run(name, id);

    return result.changes > 0;
  }

  /**
   * Get latest device location from telemetry
   */
  getDeviceLocation(deviceId: string): { latitude: number; longitude: number; accuracy: number | null } | null {
    this.initialize();

    const row = this.getDb().prepare(`
      SELECT latitude, longitude, location_accuracy
      FROM device_telemetry
      WHERE device_id = ? AND latitude IS NOT NULL
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(deviceId) as { latitude: number; longitude: number; location_accuracy: number | null } | undefined;

    if (!row) return null;

    return {
      latitude: row.latitude,
      longitude: row.longitude,
      accuracy: row.location_accuracy,
    };
  }

  /**
   * Get devices by policy
   */
  getDevicesByPolicy(policyId: string): Device[] {
    this.initialize();

    const rows = this.getDb().prepare(`
      SELECT * FROM devices WHERE policy_id = ? ORDER BY name ASC
    `).all(policyId) as DeviceRow[];

    return rows.map((row) => this.rowToDevice(row));
  }

  /**
   * Convert database row to Device object
   * Status is computed dynamically: online if seen within last 2 minutes
   */
  private rowToDevice(row: DeviceRow): Device {
    // Compute online status based on last seen time
    // Device is online if seen within last 2 minutes (120,000 ms)
    const ONLINE_THRESHOLD_MS = 2 * 60 * 1000;
    const now = Date.now();
    const isOnline = row.last_seen_at !== null &&
      (now - row.last_seen_at) < ONLINE_THRESHOLD_MS;

    return {
      id: row.id,
      name: row.name,
      model: row.model,
      androidVersion: row.android_version,
      enrolledAt: row.enrolled_at,
      lastSeenAt: row.last_seen_at,
      status: isOnline ? 'online' : 'offline',
      publicKey: row.public_key,

      // Extended fields
      manufacturer: row.manufacturer,
      serialNumber: row.serial_number,
      imei: row.imei,
      phoneNumber: row.phone_number,
      buildFingerprint: row.build_fingerprint,
      kernelVersion: row.kernel_version,
      displayResolution: row.display_resolution,
      cpuArchitecture: row.cpu_architecture,
      totalRam: row.total_ram,

      // Group and policy
      groupId: row.group_id,
      policyId: row.policy_id,
      complianceStatus: (row.compliance_status as 'compliant' | 'non_compliant' | 'pending') || 'pending',
    };
  }
}

// Export singleton instance
export const deviceStore = new DeviceStore();
