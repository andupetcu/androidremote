import * as fs from 'fs';

/** Android package name: dot-separated identifiers, at least two segments (C6). */
export const PACKAGE_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;

export function isValidPackageName(name: unknown): name is string {
  return typeof name === 'string' && name.length <= 255 && PACKAGE_NAME_RE.test(name);
}

export type ApkCheck = { ok: true } | { ok: false; reason: string };

/**
 * Cheap structural check of an uploaded APK without unpacking it: it must start with the zip local-header magic,
 * have a readable central directory, and contain AndroidManifest.xml. Reads only the head and the directory.
 * This is a sanity check, not a signature check; the device verifies the SHA-256 and Android verifies the signature.
 */
export async function inspectApk(file: string): Promise<ApkCheck> {
  let fh: fs.promises.FileHandle | undefined;
  try {
    fh = await fs.promises.open(file, 'r');
    const { size } = await fh.stat();
    if (size < 22) return { ok: false, reason: 'File is too small to be an APK (zip)' };

    const head = Buffer.alloc(4);
    await fh.read(head, 0, 4, 0);
    if (head.readUInt32LE(0) !== 0x04034b50) {
      return { ok: false, reason: 'File is not an APK (zip signature missing)' };
    }

    // End of central directory record: last 22 bytes, or up to 64 KiB back when there is a comment.
    const tailLen = Math.min(size, 22 + 65535);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return { ok: false, reason: 'File is not a valid APK (zip directory not found)' };

    const entries = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (cdOffset + cdSize > size || cdSize > 64 * 1024 * 1024) {
      return { ok: false, reason: 'File is not a valid APK (corrupt zip directory)' };
    }

    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOffset);
    let pos = 0;
    for (let n = 0; n < entries && pos + 46 <= cdSize; n++) {
      if (cd.readUInt32LE(pos) !== 0x02014b50) break;
      const nameLen = cd.readUInt16LE(pos + 28);
      const extraLen = cd.readUInt16LE(pos + 30);
      const commentLen = cd.readUInt16LE(pos + 32);
      const name = cd.toString('utf8', pos + 46, pos + 46 + nameLen);
      if (name === 'AndroidManifest.xml') return { ok: true };
      pos += 46 + nameLen + extraLen + commentLen;
    }
    return { ok: false, reason: 'File is not an APK (AndroidManifest.xml missing)' };
  } catch (err) {
    return { ok: false, reason: `Could not read the uploaded file: ${(err as Error).message}` };
  } finally {
    await fh?.close();
  }
}

/** SHA-256 (hex) of a file on disk, streamed in 1 MiB blocks. Used to fill in hashes of legacy uploads. */
export function sha256FileSync(file: string): string {
  const crypto = require('crypto') as typeof import('crypto');
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(1024 * 1024);
    let n: number;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}
