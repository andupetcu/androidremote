import type Database from 'better-sqlite3';
import { getDatabase } from '../db/connection';
import { initializeSchema } from '../db/schema';

export interface InstalledApp {
  deviceId: string;
  packageName: string;
  appName: string | null;
  versionName: string | null;
  versionCode: number | null;
  installedAt: number | null;
  updatedAt: number | null;
  isSystemApp: boolean;
  enabled: boolean;
  sizeBytes: number | null;
  dataSizeBytes: number | null;
  permissions: string[] | null;
}

export interface AppInput {
  packageName: string;
  appName?: string;
  versionName?: string;
  versionCode?: number;
  installedAt?: number;
  isSystemApp?: boolean;
  enabled?: boolean;
  sizeBytes?: number;
  dataSizeBytes?: number;
  permissions?: string[];
}

export interface AppCatalogEntry {
  packageName: string;
  appName: string | null;
  latestVersionName: string | null;
  latestVersionCode: number | null;
  category: string | null;
  isApproved: boolean;
  isBlocked: boolean;
  notes: string | null;
  updatedAt: number | null;
}

interface AppRow {
  device_id: string;
  package_name: string;
  app_name: string | null;
  version_name: string | null;
  version_code: number | null;
  installed_at: number | null;
  updated_at: number | null;
  is_system_app: number;
  enabled: number;
  size_bytes: number | null;
  data_size_bytes: number | null;
  permissions: string | null;
}

interface CatalogRow {
  package_name: string;
  app_name: string | null;
  latest_version_name: string | null;
  latest_version_code: number | null;
  category: string | null;
  is_approved: number;
  is_blocked: number;
  notes: string | null;
  updated_at: number | null;
}

class AppInventoryStore {
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

  // =============================================
  // Device Apps
  // =============================================

  /**
   * Sync apps for a device (full replacement)
   */
  syncDeviceApps(deviceId: string, apps: AppInput[]): void {
    this.initialize();
    const db = this.getDb();
    const now = Date.now();

    const transaction = db.transaction(() => {
      // Delete existing apps
      db.prepare('DELETE FROM device_apps WHERE device_id = ?').run(deviceId);

      // Insert new apps
      const stmt = db.prepare(`
        INSERT INTO device_apps (
          device_id, package_name, app_name, version_name, version_code,
          installed_at, updated_at, is_system_app, enabled,
          size_bytes, data_size_bytes, permissions
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const app of apps) {
        stmt.run(
          deviceId,
          app.packageName,
          app.appName ?? null,
          app.versionName ?? null,
          app.versionCode ?? null,
          app.installedAt ?? now,
          now,
          app.isSystemApp ? 1 : 0,
          app.enabled !== false ? 1 : 0,
          app.sizeBytes ?? null,
          app.dataSizeBytes ?? null,
          app.permissions ? JSON.stringify(app.permissions) : null
        );

        // Update app catalog with latest version info
        this.updateCatalogFromApp(app);
      }
    });

    transaction();
  }

  /**
   * Update or add a single app for a device
   */
  upsertDeviceApp(deviceId: string, app: AppInput): InstalledApp {
    this.initialize();
    const db = this.getDb();
    const now = Date.now();

    db.prepare(`
      INSERT INTO device_apps (
        device_id, package_name, app_name, version_name, version_code,
        installed_at, updated_at, is_system_app, enabled,
        size_bytes, data_size_bytes, permissions
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(device_id, package_name) DO UPDATE SET
        app_name = COALESCE(excluded.app_name, app_name),
        version_name = COALESCE(excluded.version_name, version_name),
        version_code = COALESCE(excluded.version_code, version_code),
        updated_at = excluded.updated_at,
        is_system_app = excluded.is_system_app,
        enabled = excluded.enabled,
        size_bytes = COALESCE(excluded.size_bytes, size_bytes),
        data_size_bytes = COALESCE(excluded.data_size_bytes, data_size_bytes),
        permissions = COALESCE(excluded.permissions, permissions)
    `).run(
      deviceId,
      app.packageName,
      app.appName ?? null,
      app.versionName ?? null,
      app.versionCode ?? null,
      app.installedAt ?? now,
      now,
      app.isSystemApp ? 1 : 0,
      app.enabled !== false ? 1 : 0,
      app.sizeBytes ?? null,
      app.dataSizeBytes ?? null,
      app.permissions ? JSON.stringify(app.permissions) : null
    );

    this.updateCatalogFromApp(app);
    return this.getDeviceApp(deviceId, app.packageName)!;
  }

  /**
   * Remove an app from a device
   */
  removeDeviceApp(deviceId: string, packageName: string): boolean {
    this.initialize();
    const db = this.getDb();

    const result = db.prepare(`
      DELETE FROM device_apps WHERE device_id = ? AND package_name = ?
    `).run(deviceId, packageName);

    return result.changes > 0;
  }

  /**
   * Get apps for a device
   */
  getDeviceApps(
    deviceId: string,
    options?: { includeSystemApps?: boolean; search?: string }
  ): InstalledApp[] {
    this.initialize();
    const db = this.getDb();

    let query = 'SELECT * FROM device_apps WHERE device_id = ?';
    const params: (string | number)[] = [deviceId];

    if (!options?.includeSystemApps) {
      query += ' AND is_system_app = 0';
    }

    if (options?.search) {
      query += ' AND (app_name LIKE ? OR package_name LIKE ?)';
      const searchPattern = `%${options.search}%`;
      params.push(searchPattern, searchPattern);
    }

    query += ' ORDER BY app_name ASC';

    const rows = db.prepare(query).all(...params) as AppRow[];
    return rows.map(row => this.rowToApp(row));
  }

  /**
   * Get a single app for a device
   */
  getDeviceApp(deviceId: string, packageName: string): InstalledApp | null {
    this.initialize();
    const db = this.getDb();

    const row = db.prepare(`
      SELECT * FROM device_apps WHERE device_id = ? AND package_name = ?
    `).get(deviceId, packageName) as AppRow | undefined;

    if (!row) return null;
    return this.rowToApp(row);
  }

  /**
   * Get app count for a device
   */
  getDeviceAppCount(deviceId: string, includeSystemApps: boolean = false): number {
    this.initialize();
    const db = this.getDb();

    let query = 'SELECT COUNT(*) as count FROM device_apps WHERE device_id = ?';
    if (!includeSystemApps) {
      query += ' AND is_system_app = 0';
    }

    const row = db.prepare(query).get(deviceId) as { count: number };
    return row.count;
  }

  /**
   * Get devices that have a specific app installed
   */
  getDevicesWithApp(packageName: string): string[] {
    this.initialize();
    const db = this.getDb();

    const rows = db.prepare(`
      SELECT device_id FROM device_apps WHERE package_name = ?
    `).all(packageName) as { device_id: string }[];

    return rows.map(r => r.device_id);
  }

  // =============================================
  // App Catalog
  // =============================================

  /**
   * Get all catalog entries
   */
  getCatalog(options?: {
    approved?: boolean;
    blocked?: boolean;
    search?: string;
    limit?: number;
    offset?: number;
  }): AppCatalogEntry[] {
    this.initialize();
    const db = this.getDb();

    let query = 'SELECT * FROM app_catalog WHERE 1=1';
    const params: (string | number)[] = [];

    if (options?.approved !== undefined) {
      query += ' AND is_approved = ?';
      params.push(options.approved ? 1 : 0);
    }

    if (options?.blocked !== undefined) {
      query += ' AND is_blocked = ?';
      params.push(options.blocked ? 1 : 0);
    }

    if (options?.search) {
      query += ' AND (app_name LIKE ? OR package_name LIKE ?)';
      const searchPattern = `%${options.search}%`;
      params.push(searchPattern, searchPattern);
    }

    query += ' ORDER BY app_name ASC';

    if (options?.limit) {
      query += ' LIMIT ?';
      params.push(options.limit);
    }

    if (options?.offset) {
      query += ' OFFSET ?';
      params.push(options.offset);
    }

    const rows = db.prepare(query).all(...params) as CatalogRow[];
    return rows.map(row => this.rowToCatalogEntry(row));
  }

  /**
   * Get a catalog entry
   */
  getCatalogEntry(packageName: string): AppCatalogEntry | null {
    this.initialize();
    const db = this.getDb();

    const row = db.prepare(`
      SELECT * FROM app_catalog WHERE package_name = ?
    `).get(packageName) as CatalogRow | undefined;

    if (!row) return null;
    return this.rowToCatalogEntry(row);
  }

  /**
   * Update catalog entry (approve/block/notes)
   */
  updateCatalogEntry(
    packageName: string,
    updates: { isApproved?: boolean; isBlocked?: boolean; notes?: string; category?: string }
  ): AppCatalogEntry | null {
    this.initialize();
    const db = this.getDb();

    const existing = this.getCatalogEntry(packageName);
    if (!existing) return null;

    db.prepare(`
      UPDATE app_catalog SET
        is_approved = ?,
        is_blocked = ?,
        notes = ?,
        category = ?,
        updated_at = ?
      WHERE package_name = ?
    `).run(
      updates.isApproved !== undefined ? (updates.isApproved ? 1 : 0) : (existing.isApproved ? 1 : 0),
      updates.isBlocked !== undefined ? (updates.isBlocked ? 1 : 0) : (existing.isBlocked ? 1 : 0),
      updates.notes !== undefined ? updates.notes : existing.notes,
      updates.category !== undefined ? updates.category : existing.category,
      Date.now(),
      packageName
    );

    return this.getCatalogEntry(packageName);
  }

  /**
   * Update catalog with app info (called internally when syncing)
   */
  private updateCatalogFromApp(app: AppInput): void {
    const db = this.getDb();

    db.prepare(`
      INSERT INTO app_catalog (package_name, app_name, latest_version_name, latest_version_code, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(package_name) DO UPDATE SET
        app_name = COALESCE(excluded.app_name, app_name),
        latest_version_name = CASE
          WHEN excluded.latest_version_code > COALESCE(latest_version_code, 0)
          THEN excluded.latest_version_name
          ELSE latest_version_name
        END,
        latest_version_code = CASE
          WHEN excluded.latest_version_code > COALESCE(latest_version_code, 0)
          THEN excluded.latest_version_code
          ELSE latest_version_code
        END,
        updated_at = excluded.updated_at
    `).run(
      app.packageName,
      app.appName ?? null,
      app.versionName ?? null,
      app.versionCode ?? null,
      Date.now()
    );
  }

  /**
   * Clear all data (for testing)
   */
  clear(): void {
    this.initialize();
    const db = this.getDb();
    db.prepare('DELETE FROM device_apps').run();
    db.prepare('DELETE FROM app_catalog').run();
  }

  private rowToApp(row: AppRow): InstalledApp {
    return {
      deviceId: row.device_id,
      packageName: row.package_name,
      appName: row.app_name,
      versionName: row.version_name,
      versionCode: row.version_code,
      installedAt: row.installed_at,
      updatedAt: row.updated_at,
      isSystemApp: row.is_system_app === 1,
      enabled: row.enabled === 1,
      sizeBytes: row.size_bytes,
      dataSizeBytes: row.data_size_bytes,
      permissions: row.permissions ? JSON.parse(row.permissions) : null,
    };
  }

  private rowToCatalogEntry(row: CatalogRow): AppCatalogEntry {
    return {
      packageName: row.package_name,
      appName: row.app_name,
      latestVersionName: row.latest_version_name,
      latestVersionCode: row.latest_version_code,
      category: row.category,
      isApproved: row.is_approved === 1,
      isBlocked: row.is_blocked === 1,
      notes: row.notes,
      updatedAt: row.updated_at,
    };
  }
}

export const appInventoryStore = new AppInventoryStore();
