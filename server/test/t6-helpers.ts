import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Fresh uploads directory for a test file. Must be set before ../src/app is loaded. */
export function useTempUploadsDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't6-uploads-'));
  process.env.UPLOADS_DIR = dir;
  return dir;
}

function u16(n: number): Buffer { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; }
function u32(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; }

/**
 * Write a minimal stored (uncompressed) zip. `padBytes` adds a big stored entry so tests can
 * produce large files without holding them in memory. CRCs are zero: the server only reads the directory.
 */
export function writeFakeApk(
  file: string,
  opts: { manifest?: boolean; padBytes?: number } = {}
): void {
  const manifest = opts.manifest !== false;
  const entries: Array<{ name: string; size: number; write: (fd: number) => void }> = [];
  if (manifest) {
    const data = Buffer.from('binary-xml-placeholder');
    entries.push({ name: 'AndroidManifest.xml', size: data.length, write: fd => fs.writeSync(fd, data) });
  }
  entries.push({ name: 'classes.dex', size: 8, write: fd => fs.writeSync(fd, Buffer.from('dex\n035\0')) });
  if (opts.padBytes) {
    const total = opts.padBytes;
    entries.push({
      name: 'assets/pad.bin',
      size: total,
      write: fd => {
        const chunk = Buffer.alloc(1024 * 1024, 7);
        let left = total;
        while (left > 0) {
          const n = Math.min(left, chunk.length);
          fs.writeSync(fd, chunk, 0, n);
          left -= n;
        }
      },
    });
  }

  const fd = fs.openSync(file, 'w');
  const central: Buffer[] = [];
  let offset = 0;
  const writeBuf = (b: Buffer) => { fs.writeSync(fd, b); offset += b.length; };
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const localOffset = offset;
    writeBuf(Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(0), u32(e.size), u32(e.size),
      u16(name.length), u16(0), name,
    ]));
    e.write(fd);
    offset += e.size;
    central.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(0), u32(e.size), u32(e.size),
      u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(localOffset), name,
    ]));
  }
  const cdOffset = offset;
  const cd = Buffer.concat(central);
  writeBuf(cd);
  writeBuf(Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(cd.length), u32(cdOffset), u16(0),
  ]));
  fs.closeSync(fd);
}
