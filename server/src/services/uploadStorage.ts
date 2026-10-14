import * as fs from 'fs';
import * as path from 'path';
import crypto from 'crypto';
import type { Request } from 'express';
import type { StorageEngine } from 'multer';

/** Extra fields this engine adds to multer's file object. */
export interface HashedUpload {
  /** Temporary file inside `<root>/.incoming`. The caller moves it into place or deletes it. */
  path: string;
  size: number;
  /** Lower-case hex SHA-256 of the uploaded bytes. */
  sha256: string;
}

export const INCOMING_DIR_NAME = '.incoming';

/**
 * Multer storage engine that streams the upload to a temp file on disk while computing its SHA-256 (C6, SR-11).
 * Nothing is buffered in memory: memory use is bounded by the stream's highWaterMark, not the file size.
 * It does what multer.diskStorage does (temp file, `path` and `size` on the file object) and adds `sha256`.
 */
export class HashingDiskStorage implements StorageEngine {
  private readonly incomingDir: string;

  constructor(rootDir: string) {
    this.incomingDir = path.join(rootDir, INCOMING_DIR_NAME);
    fs.mkdirSync(this.incomingDir, { recursive: true });
  }

  _handleFile(
    _req: Request,
    file: Express.Multer.File,
    cb: (error?: unknown, info?: Partial<Express.Multer.File> & Partial<HashedUpload>) => void
  ): void {
    fs.mkdirSync(this.incomingDir, { recursive: true });
    const tmpPath = path.join(this.incomingDir, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.part`);
    const out = fs.createWriteStream(tmpPath, { mode: 0o640 });
    const hash = crypto.createHash('sha256');
    let size = 0;
    let finished = false;

    const fail = (err: unknown) => {
      if (finished) return;
      finished = true;
      file.stream.unpipe(out);
      out.destroy();
      fs.unlink(tmpPath, () => cb(err));
    };

    file.stream.on('data', (chunk: Buffer) => {
      size += chunk.length;
      hash.update(chunk);
    });
    file.stream.on('error', fail);
    out.on('error', fail);
    out.on('finish', () => {
      if (finished) return;
      finished = true;
      cb(null, {
        destination: this.incomingDir,
        filename: path.basename(tmpPath),
        path: tmpPath,
        size,
        sha256: hash.digest('hex'),
      });
    });
    file.stream.pipe(out);
  }

  _removeFile(
    _req: Request,
    file: Express.Multer.File,
    cb: (error: Error | null) => void
  ): void {
    const p = file.path;
    if (!p) return cb(null);
    fs.unlink(p, err => cb(err && (err as NodeJS.ErrnoException).code !== 'ENOENT' ? err : null));
  }
}
