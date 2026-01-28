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

  async save(filename: string, data: Buffer): Promise<string> {
    const filePath = path.join(this.baseDir, filename);
    const dir = path.dirname(filePath);

    // Ensure subdirectory exists
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    await fs.promises.writeFile(filePath, data);
    return filename;
  }

  getUrl(filePath: string): string {
    return `${this.baseUrl}/${filePath}`;
  }

  async delete(filePath: string): Promise<void> {
    const fullPath = path.join(this.baseDir, filePath);
    if (fs.existsSync(fullPath)) {
      await fs.promises.unlink(fullPath);
    }
  }

  async exists(filePath: string): Promise<boolean> {
    const fullPath = path.join(this.baseDir, filePath);
    return fs.existsSync(fullPath);
  }

  /**
   * Get the full filesystem path for a file
   */
  getFullPath(filePath: string): string {
    return path.join(this.baseDir, filePath);
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
