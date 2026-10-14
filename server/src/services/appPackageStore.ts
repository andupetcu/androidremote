import type Database from 'better-sqlite3';
import { getDatabase } from '../db/connection';

let injectedDb: Database.Database | null = null;

/** Point the package store at another database (tests). */
export function setDatabase(database: Database.Database | null): void {
  injectedDb = database;
}

function getDb(): Database.Database {
  return injectedDb ?? getDatabase();
}
import { getStorageProvider } from './storageProvider';
import { randomUUID } from 'crypto';
import { sha256FileSync } from './apkValidator';

export interface AppPackage {
  id: string;
  packageName: string;
  appName: string | null;
  versionName: string | null;
  versionCode: number | null;
  fileSize: number | null;
  filePath: string;
  sha256: string | null;
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
  sha256?: string;
  uploadedBy?: string;
}

export interface AppVersion {
  id: string;
  packageId: string;
  versionName: string | null;
  versionCode: number | null;
  filePath: string;
  fileSize: number | null;
  sha256: string | null;
  uploadedAt: number;
  downloadUrl?: string;
}

/** Run `fn` in one transaction on the package store's database. */
export function runInTransaction<T>(fn: () => T): T {
  return getDb().transaction(fn)();
}

/**
 * Create a new app package entry
 */
export function createAppPackage(input: AppPackageInput): AppPackage {
  const db = getDb();
  const id = randomUUID();
  const now = Date.now();

  db.prepare(`
    INSERT INTO app_packages (id, package_name, app_name, version_name, version_code, file_size, file_path, sha256, uploaded_at, uploaded_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.packageName,
    input.appName || null,
    input.versionName || null,
    input.versionCode || null,
    input.fileSize || null,
    input.filePath,
    input.sha256 || null,
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
    SELECT id, package_name, app_name, version_name, version_code, file_size, file_path, sha256, uploaded_at, uploaded_by
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
    SELECT id, package_name, app_name, version_name, version_code, file_size, file_path, sha256, uploaded_at, uploaded_by
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
    SELECT id, package_name, app_name, version_name, version_code, file_size, file_path, sha256, uploaded_at, uploaded_by
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

  if (input.sha256 !== undefined) {
    updates.push('sha256 = ?');
    values.push(input.sha256);
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
    sha256: (row.sha256 as string | null) ?? null,
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
  sha256?: string | null;
}): AppVersion {
  const db = getDb();
  const id = randomUUID();
  const now = Date.now();

  db.prepare(`
    INSERT INTO app_versions (id, package_id, version_name, version_code, file_path, file_size, sha256, uploaded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    packageId,
    input.versionName || null,
    input.versionCode || null,
    input.filePath,
    input.fileSize || null,
    input.sha256 || null,
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
    SELECT id, package_id, version_name, version_code, file_path, file_size, sha256, uploaded_at
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
    SELECT id, package_id, version_name, version_code, file_path, file_size, sha256, uploaded_at
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
    sha256: (row.sha256 as string | null) ?? null,
    uploadedAt: row.uploaded_at as number,
    downloadUrl: storage.getUrl(filePath),
  };
}

/**
 * SHA-256 of a package's APK (C6). Packages uploaded before hashing existed have none stored: hash the file
 * once from disk and persist it. Returns null if the file is missing.
 */
export function ensurePackageSha256(pkg: AppPackage): string | null {
  if (pkg.sha256) return pkg.sha256;
  try {
    const storage = getStorageProvider() as { getFullPath?: (p: string) => string };
    if (!storage.getFullPath) return null;
    const sha = sha256FileSync(storage.getFullPath(pkg.filePath));
    getDb().prepare('UPDATE app_packages SET sha256 = ? WHERE id = ?').run(sha, pkg.id);
    pkg.sha256 = sha;
    return sha;
  } catch {
    return null;
  }
}

const UPLOADS_URL_PREFIX = '/api/uploads/';

/**
 * SHA-256 of the stored APK that `url` points at, or null when it is not one of our uploads.
 * Accepts the relative form we hand out (`/api/uploads/apks/...`) or the same path on `baseUrl`.
 * Both current packages and old versions are looked up. Legacy rows are hashed from disk on first use.
 */
export function getSha256ForDownloadUrl(url: string, baseUrl?: string): string | null {
  let pathname: string;
  try {
    if (/^https?:\/\//i.test(url)) {
      if (!baseUrl || !url.startsWith(baseUrl.replace(/\/+$/, '') + '/')) return null;
    }
    pathname = decodeURIComponent(new URL(url, 'http://placeholder').pathname);
  } catch {
    return null;
  }
  if (!pathname.startsWith(UPLOADS_URL_PREFIX)) return null;
  const filePath = pathname.slice(UPLOADS_URL_PREFIX.length);

  const db = getDb();
  const pkgRow = db.prepare('SELECT id FROM app_packages WHERE file_path = ?').get(filePath) as { id: string } | undefined;
  if (pkgRow) {
    const pkg = getAppPackageById(pkgRow.id);
    return pkg ? ensurePackageSha256(pkg) : null;
  }

  const verRow = db.prepare('SELECT id, sha256 FROM app_versions WHERE file_path = ?').get(filePath) as
    { id: string; sha256: string | null } | undefined;
  if (!verRow) return null;
  if (verRow.sha256) return verRow.sha256;
  try {
    const storage = getStorageProvider() as { getFullPath?: (p: string) => string };
    if (!storage.getFullPath) return null;
    const sha = sha256FileSync(storage.getFullPath(filePath));
    db.prepare('UPDATE app_versions SET sha256 = ? WHERE id = ?').run(sha, verRow.id);
    return sha;
  } catch {
    return null;
  }
}
