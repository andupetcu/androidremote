import * as fs from 'fs';
import * as path from 'path';

/**
 * Abstract storage provider interface for file storage
 * Allows swapping between local filesystem, S3, etc.
 */
export interface StorageProvider {
  /**
   * Save a file to storage
   * @param filename - The filename to save as
   * @param data - The file data
   * @returns The relative path where the file was saved
   */
  save(filename: string, data: Buffer): Promise<string>;

  /**
   * Move an already written file (for example an upload temp file) into storage without reading it into memory
   * @param sourcePath - Absolute path of the file to move
   * @param filename - The filename to store it as
   * @returns The relative path where the file was stored
   */
  adopt(sourcePath: string, filename: string): Promise<string>;

  /**
   * Get a downloadable URL for a file
   * @param filePath - The relative path from save()
   * @returns Full URL to download the file
   */
  getUrl(filePath: string): string;

  /**
   * Delete a file from storage
   * @param filePath - The relative path from save()
   */
  delete(filePath: string): Promise<void>;

  /**
   * Check if a file exists
   * @param filePath - The relative path from save()
   */
  exists(filePath: string): Promise<boolean>;
}

/**
 * Local filesystem storage provider
 * Stores files in server/uploads/ directory
 */
export class LocalStorageProvider implements StorageProvider {
  private readonly baseDir: string;
  private readonly baseUrl: string;

  constructor(baseDir: string, baseUrl: string) {
    this.baseDir = baseDir;
    this.baseUrl = baseUrl;

    // Ensure base directory exists
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  /**
   * Resolve a storage-relative path to an absolute one and prove it is inside the base directory.
   * Throws on traversal (`..`, absolute paths, NUL bytes), including after symlink-free normalisation (SS-10).
   */
  resolveSafe(filename: string): string {
    if (typeof filename !== 'string' || filename.length === 0 || filename.includes('\0')) {
      throw new Error('Invalid storage path');
    }
    const root = path.resolve(this.baseDir);
    const full = path.resolve(root, filename);
    if (full !== root && !full.startsWith(root + path.sep)) {
      throw new Error('Invalid storage path');
    }
    if (full === root) throw new Error('Invalid storage path');
    return full;
  }

  async save(filename: string, data: Buffer): Promise<string> {
    const filePath = this.resolveSafe(filename);
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, data);
    return filename;
  }

  async adopt(sourcePath: string, filename: string): Promise<string> {
    const filePath = this.resolveSafe(filename);
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    try {
      await fs.promises.rename(sourcePath, filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
      await fs.promises.copyFile(sourcePath, filePath);
      await fs.promises.unlink(sourcePath);
    }
    return filename;
  }

  getUrl(filePath: string): string {
    return `${this.baseUrl}/${filePath}`;
  }

  async delete(filePath: string): Promise<void> {
    const fullPath = this.resolveSafe(filePath);
    if (fs.existsSync(fullPath)) {
      await fs.promises.unlink(fullPath);
    }
  }

  async exists(filePath: string): Promise<boolean> {
    return fs.existsSync(this.resolveSafe(filePath));
  }

  /**
   * Get the full filesystem path for a file
   */
  getFullPath(filePath: string): string {
    return this.resolveSafe(filePath);
  }
}

// Default storage provider instance (configured in app.ts)
let storageProvider: StorageProvider | null = null;

export function setStorageProvider(provider: StorageProvider): void {
  storageProvider = provider;
}

export function getStorageProvider(): StorageProvider {
  if (!storageProvider) {
    throw new Error('Storage provider not initialized');
  }
  return storageProvider;
}
