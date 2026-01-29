import { getDatabase } from '../db/connection';

function getDb() {
  return getDatabase();
}
import { getStorageProvider } from './storageProvider';
import { v4 as uuidv4 } from 'uuid';

export interface AppPackage {
  id: string;
  packageName: string;
  appName: string | null;
  versionName: string | null;
  versionCode: number | null;
  fileSize: number | null;
  filePath: string;
  uploadedAt: number;
  uploadedBy: string | null;
  downloadUrl?: string;
}

export interface AppPackageInput {
  packageName: string;
  appName?: string;
  versionName?: string;
  versionCode?: number;
  fileSize?: number;
  filePath: string;
  uploadedBy?: string;
}

export interface AppVersion {
  id: string;
  packageId: string;
  versionName: string | null;
  versionCode: number | null;
  filePath: string;
  fileSize: number | null;
  uploadedAt: number;
  downloadUrl?: string;
}

/**
 * Create a new app package entry
 */
export function createAppPackage(input: AppPackageInput): AppPackage {
  const db = getDb();
  const id = uuidv4();
  const now = Date.now();

  db.prepare(`
    INSERT INTO app_packages (id, package_name, app_name, version_name, version_code, file_size, file_path, uploaded_at, uploaded_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.packageName,
    input.appName || null,
    input.versionName || null,
    input.versionCode || null,
    input.fileSize || null,
    input.filePath,
    now,
    input.uploadedBy || null
  );

  return getAppPackageById(id)!;
}

/**
 * Get an app package by ID
 */
export function getAppPackageById(id: string): AppPackage | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT id, package_name, app_name, version_name, version_code, file_size, file_path, uploaded_at, uploaded_by
    FROM app_packages WHERE id = ?
  `).get(id) as Record<string, unknown> | undefined;

  if (!row) return null;
  return mapRowToPackage(row);
}

/**
 * Get an app package by package name
 */
export function getAppPackageByName(packageName: string): AppPackage | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT id, package_name, app_name, version_name, version_code, file_size, file_path, uploaded_at, uploaded_by
    FROM app_packages WHERE package_name = ?
  `).get(packageName) as Record<string, unknown> | undefined;

  if (!row) return null;
  return mapRowToPackage(row);
}

/**
 * List all uploaded app packages
 */
export function listAppPackages(): AppPackage[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, package_name, app_name, version_name, version_code, file_size, file_path, uploaded_at, uploaded_by
    FROM app_packages ORDER BY uploaded_at DESC
  `).all() as Record<string, unknown>[];

  return rows.map(mapRowToPackage);
}

/**
 * Update an app package (e.g., when uploading a new version)
 */
export function updateAppPackage(
  packageName: string,
  input: Partial<Omit<AppPackageInput, 'packageName'>>
): AppPackage | null {
  const db = getDb();
  const existing = getAppPackageByName(packageName);
  if (!existing) return null;

  const updates: string[] = [];
  const values: unknown[] = [];

  if (input.appName !== undefined) {
    updates.push('app_name = ?');
    values.push(input.appName);
  }
  if (input.versionName !== undefined) {
    updates.push('version_name = ?');
    values.push(input.versionName);
  }
  if (input.versionCode !== undefined) {
    updates.push('version_code = ?');
    values.push(input.versionCode);
  }
  if (input.fileSize !== undefined) {
    updates.push('file_size = ?');
    values.push(input.fileSize);
  }
  if (input.filePath !== undefined) {
    updates.push('file_path = ?');
    values.push(input.filePath);
  }

  if (updates.length > 0) {
    updates.push('uploaded_at = ?');
    values.push(Date.now());
    values.push(packageName);

    db.prepare(`
      UPDATE app_packages SET ${updates.join(', ')} WHERE package_name = ?
    `).run(...values);
  }

  return getAppPackageByName(packageName);
}

/**
 * Delete an app package and its file
 */
export async function deleteAppPackage(packageName: string): Promise<boolean> {
  const db = getDb();
  const pkg = getAppPackageByName(packageName);
  if (!pkg) return false;

  // Delete the file from storage
  const storage = getStorageProvider();
  await storage.delete(pkg.filePath);

  // Delete from database
  db.prepare('DELETE FROM app_packages WHERE package_name = ?').run(packageName);
  return true;
}

/**
 * Map database row to AppPackage object
 */
function mapRowToPackage(row: Record<string, unknown>): AppPackage {
  const storage = getStorageProvider();
  const filePath = row.file_path as string;

  return {
    id: row.id as string,
    packageName: row.package_name as string,
    appName: row.app_name as string | null,
    versionName: row.version_name as string | null,
    versionCode: row.version_code as number | null,
    fileSize: row.file_size as number | null,
    filePath,
    uploadedAt: row.uploaded_at as number,
    uploadedBy: row.uploaded_by as string | null,
    downloadUrl: storage.getUrl(filePath),
  };
}

// ============================================
// Version Management
// ============================================

/**
 * Create a version record for an app package
 */
export function createVersion(packageId: string, input: {
  versionName?: string;
  versionCode?: number;
  filePath: string;
  fileSize?: number;
}): AppVersion {
  const db = getDb();
  const id = uuidv4();
  const now = Date.now();

  db.prepare(`
    INSERT INTO app_versions (id, package_id, version_name, version_code, file_path, file_size, uploaded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    packageId,
    input.versionName || null,
    input.versionCode || null,
    input.filePath,
    input.fileSize || null,
    now
  );

  return getVersionById(id)!;
}

/**
 * Get a version by ID
 */
export function getVersionById(id: string): AppVersion | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT id, package_id, version_name, version_code, file_path, file_size, uploaded_at
    FROM app_versions WHERE id = ?
  `).get(id) as Record<string, unknown> | undefined;

  if (!row) return null;
  return mapRowToVersion(row);
}

/**
 * List all versions for a package, newest first
 */
export function listVersions(packageId: string): AppVersion[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, package_id, version_name, version_code, file_path, file_size, uploaded_at
    FROM app_versions WHERE package_id = ? ORDER BY uploaded_at DESC
  `).all(packageId) as Record<string, unknown>[];

  return rows.map(mapRowToVersion);
}

/**
 * Delete a specific version and its file
 */
export async function deleteVersion(versionId: string): Promise<boolean> {
  const db = getDb();
  const version = getVersionById(versionId);
  if (!version) return false;

  const storage = getStorageProvider();
  await storage.delete(version.filePath);

  db.prepare('DELETE FROM app_versions WHERE id = ?').run(versionId);
  return true;
}

/**
 * Map database row to AppVersion object
 */
function mapRowToVersion(row: Record<string, unknown>): AppVersion {
  const storage = getStorageProvider();
  const filePath = row.file_path as string;

  return {
    id: row.id as string,
    packageId: row.package_id as string,
    versionName: row.version_name as string | null,
    versionCode: row.version_code as number | null,
    filePath,
    fileSize: row.file_size as number | null,
    uploadedAt: row.uploaded_at as number,
    downloadUrl: storage.getUrl(filePath),
  };
}
