import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import crypto from 'crypto';
import { Readable } from 'stream';
import request from 'supertest';
import { useTempUploadsDir, writeFakeApk } from './t6-helpers';

const uploadsDir = useTempUploadsDir();
process.env.PUBLIC_BASE_URL = 'https://mdm.example.com';

import { app, resetRateLimiters } from '../src/app';
import { deviceStore } from '../src/services/deviceStore';
import { commandStore } from '../src/services/commandStore';
import { policyStore } from '../src/services/policyStore';
import * as appPackageStore from '../src/services/appPackageStore';
import { appInventoryStore } from '../src/services/appInventoryStore';
import { setStorageProvider, LocalStorageProvider } from '../src/services/storageProvider';
import { HashingDiskStorage } from '../src/services/uploadStorage';
import { setupTestDatabase, cleanupTestDatabase, closeTestDatabase, adminAuthHeader, deviceTokenFor } from './setup';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't6-src-'));
let db: ReturnType<typeof setupTestDatabase>;

function sha256File(file: string): string {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

async function upload(file: string, fields: Record<string, string>) {
  let r = request(app).post('/api/apps/upload').set('Authorization', adminAuthHeader());
  for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
  return r.attach('file', file, { filename: 'app.apk' });
}

describe('T6 APK pipeline (C6, SS-10, SR-11)', () => {
  let goodApk: string;

  beforeAll(() => {
    db = setupTestDatabase();
    appPackageStore.setDatabase(db);
    setStorageProvider(new LocalStorageProvider(uploadsDir, '/api/uploads'));
    goodApk = path.join(tmpDir, 'good.apk');
    writeFakeApk(goodApk);
  });
  afterAll(() => { appPackageStore.setDatabase(null); closeTestDatabase(); });
  beforeEach(() => {
    cleanupTestDatabase();
    resetRateLimiters();
    for (const f of listFiles(uploadsDir)) fs.unlinkSync(f);
  });

  describe('upload validation', () => {
    it('stores a valid APK with its sha256 and a path inside the uploads root', async () => {
      const res = await upload(goodApk, { packageName: 'com.example.app', versionName: '1.0', versionCode: '1' });
      expect(res.status).toBe(201);
      expect(res.body.sha256).toBe(sha256File(goodApk));
      const stored = path.resolve(uploadsDir, res.body.filePath);
      expect(stored.startsWith(path.resolve(uploadsDir) + path.sep)).toBe(true);
      expect(fs.existsSync(stored)).toBe(true);
      expect(sha256File(stored)).toBe(res.body.sha256);
      // no temp leftovers
      expect(listFiles(uploadsDir)).toEqual([stored]);
    });

    it.each([
      ['../../etc/evil'],
      ['com.example/../../x'],
      ['com.example.app/../../x'],
      ['..%2f..%2fx'],
      ['com'],
      ['1com.example'],
      ['com.exam ple'],
      ['com.example.app\u0000.x'],
      [''],
    ])('rejects package name %j and writes nothing', async (name) => {
      const res = await upload(goodApk, { packageName: name });
      expect(res.status).toBe(400);
      expect(listFiles(uploadsDir)).toEqual([]);
      expect(appPackageStore.listAppPackages()).toHaveLength(0);
    });

    it('rejects a file that is not a zip', async () => {
      const bad = path.join(tmpDir, 'bad.apk');
      fs.writeFileSync(bad, 'this is not a zip');
      const res = await upload(bad, { packageName: 'com.example.app' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/apk|zip/i);
      expect(listFiles(uploadsDir)).toEqual([]);
    });

    it('rejects a zip without AndroidManifest.xml', async () => {
      const nomanifest = path.join(tmpDir, 'nomanifest.apk');
      writeFakeApk(nomanifest, { manifest: false });
      const res = await upload(nomanifest, { packageName: 'com.example.app' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/AndroidManifest/);
      expect(listFiles(uploadsDir)).toEqual([]);
    });

    it('rejects non-.apk file names', async () => {
      const res = await request(app).post('/api/apps/upload').set('Authorization', adminAuthHeader())
        .field('packageName', 'com.example.app').attach('file', goodApk, { filename: 'app.exe' });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(listFiles(uploadsDir)).toEqual([]);
    });

    it('deletes the stored file when the database step fails', async () => {
      const spy = jest.spyOn(appPackageStore, 'createAppPackage').mockImplementation(() => { throw new Error('db down'); });
      try {
        const res = await upload(goodApk, { packageName: 'com.example.app' });
        expect(res.status).toBe(500);
        expect(listFiles(uploadsDir)).toEqual([]);
      } finally {
        spy.mockRestore();
      }
    });

    it('keeps sha256 per version when a package is re-uploaded', async () => {
      const second = path.join(tmpDir, 'second.apk');
      writeFakeApk(second, { padBytes: 1234 });
      const a = await upload(goodApk, { packageName: 'com.example.app', versionCode: '1' });
      const b = await upload(second, { packageName: 'com.example.app', versionCode: '2' });
      expect(b.body.sha256).toBe(sha256File(second));
      expect(b.body.sha256).not.toBe(a.body.sha256);
      const versions = appPackageStore.listVersions(b.body.id);
      expect(versions[0].sha256).toBe(a.body.sha256);
    });
  });

  describe('streaming to disk (SR-11)', () => {
    it('the storage engine writes 100 MB to disk and hashes it without buffering', async () => {
      const dest = fs.mkdtempSync(path.join(os.tmpdir(), 't6-engine-'));
      const engine = new HashingDiskStorage(dest);
      const total = 100 * 1024 * 1024;
      const chunk = Buffer.alloc(1024 * 1024, 3);
      let sent = 0;
      const stream = new Readable({
        read() {
          if (sent >= total) { this.push(null); return; }
          sent += chunk.length;
          this.push(Buffer.from(chunk)); // a fresh buffer each time so GC can reclaim it
        },
      });
      if (global.gc) global.gc();
      const before = process.memoryUsage();
      let peak = 0;
      const timer = setInterval(() => {
        const m = process.memoryUsage();
        peak = Math.max(peak, m.heapUsed + m.arrayBuffers - before.heapUsed - before.arrayBuffers);
      }, 5);
      const info: any = await new Promise((resolve, reject) => {
        engine._handleFile({} as any, { stream, originalname: 'big.apk', fieldname: 'file', mimetype: 'x', encoding: '7bit' } as any,
          (err: any, i: any) => (err ? reject(err) : resolve(i)));
      });
      clearInterval(timer);
      expect(info.buffer).toBeUndefined();
      expect(info.size).toBe(total);
      expect(fs.statSync(info.path).size).toBe(total);
      const h = crypto.createHash('sha256');
      for (let i = 0; i < 100; i++) h.update(chunk);
      expect(info.sha256).toBe(h.digest('hex'));
      expect(peak).toBeLessThan(40 * 1024 * 1024);
      fs.rmSync(dest, { recursive: true, force: true });
    });

    it('the upload route hands the handler a file on disk, not a buffer', async () => {
      const big = path.join(tmpDir, 'big.apk');
      writeFakeApk(big, { padBytes: 20 * 1024 * 1024 });
      const spy = jest.spyOn(appPackageStore, 'createAppPackage');
      const res = await upload(big, { packageName: 'com.example.big' });
      expect(res.status).toBe(201);
      expect(res.body.fileSize).toBe(fs.statSync(big).size);
      expect(res.body.sha256).toBe(sha256File(big));
      spy.mockRestore();
      fs.unlinkSync(big);
    });
  });

  describe('sha256 in every INSTALL_APK payload and in app-updates', () => {
    async function seedPackage() {
      deviceStore.enrollDevice({ id: 'd1', name: 'd1' });
      const res = await upload(goodApk, { packageName: 'com.example.app', versionName: '2.0', versionCode: '2' });
      return res.body.sha256 as string;
    }

    const installPayloads = () =>
      (db.prepare("SELECT payload FROM device_commands WHERE type='INSTALL_APK'").all() as any[]).map(r => JSON.parse(r.payload));

    it('packages/:name/install', async () => {
      const sha = await seedPackage();
      await request(app).post('/api/apps/packages/com.example.app/install').set('Authorization', adminAuthHeader())
        .send({ deviceIds: ['d1'] });
      expect(installPayloads()[0].sha256).toBe(sha);
    });

    it('packages/:name/deploy', async () => {
      const sha = await seedPackage();
      await request(app).post('/api/apps/packages/com.example.app/deploy').set('Authorization', adminAuthHeader()).send({});
      expect(installPayloads()[0].sha256).toBe(sha);
    });

    it('direct command with the uploaded package url gets the stored sha256, overriding a client value', async () => {
      const sha = await seedPackage();
      const pkg = appPackageStore.getAppPackageByName('com.example.app')!;
      for (const route of ['/api/commands', '/api/devices/d1/commands']) {
        const body: any = { type: 'INSTALL_APK', payload: { url: pkg.downloadUrl, packageName: 'com.example.app', sha256: 'f'.repeat(64) } };
        if (route === '/api/commands') body.deviceId = 'd1';
        const r = await request(app).post(route).set('Authorization', adminAuthHeader()).send(body);
        expect(r.status).toBe(201);
      }
      expect(installPayloads().map(p => p.sha256)).toEqual([sha, sha]);
    });

    it('batch command with the uploaded package url', async () => {
      const sha = await seedPackage();
      const pkg = appPackageStore.getAppPackageByName('com.example.app')!;
      await request(app).post('/api/commands/batch').set('Authorization', adminAuthHeader())
        .send({ deviceIds: ['d1'], type: 'INSTALL_APK', payload: { url: pkg.downloadUrl, packageName: 'com.example.app' } });
      expect(installPayloads()[0].sha256).toBe(sha);
    });

    it('an external URL without sha256 is refused; with a well-formed sha256 it is accepted as given', async () => {
      deviceStore.enrollDevice({ id: 'd1', name: 'd1' });
      const bad = await request(app).post('/api/devices/d1/commands').set('Authorization', adminAuthHeader())
        .send({ type: 'INSTALL_APK', payload: { url: 'https://cdn.example.com/a.apk', packageName: 'com.x.y' } });
      expect(bad.status).toBe(400);
      expect(bad.body.error).toMatch(/sha256/);
      const good = await request(app).post('/api/devices/d1/commands').set('Authorization', adminAuthHeader())
        .send({ type: 'INSTALL_APK', payload: { url: 'https://cdn.example.com/a.apk', packageName: 'com.x.y', sha256: 'A'.repeat(64) } });
      expect(good.status).toBe(201);
      expect(good.body.payload.sha256).toBe('a'.repeat(64));
    });

    it('policy assignment and policy edits', async () => {
      const sha = await seedPackage();
      const policy = policyStore.createPolicy({ name: 'p', requiredApps: [{ packageName: 'com.example.app' }] } as any);
      await request(app).put('/api/devices/d1/policy').set('Authorization', adminAuthHeader()).send({ policyId: policy.id });
      await request(app).put(`/api/policies/${policy.id}`).set('Authorization', adminAuthHeader())
        .send({ requiredApps: [{ packageName: 'com.example.app', foregroundApp: true }] });
      const payloads = installPayloads();
      expect(payloads.length).toBeGreaterThan(0);
      for (const p of payloads) expect(p.sha256).toBe(sha);
      // SR-18: only one pending INSTALL_APK for the package survives
      const pending = db.prepare("SELECT COUNT(*) c FROM device_commands WHERE type='INSTALL_APK' AND status='pending'").get() as any;
      expect(pending.c).toBe(1);
    });

    it('app-updates entries carry sha256', async () => {
      const sha = await seedPackage();
      appInventoryStore.syncDeviceApps('d1', [
        { packageName: 'com.example.app', appName: 'App', versionName: '1.0', versionCode: 1 } as any,
      ]);
      const res = await request(app).get('/api/devices/d1/app-updates').set('X-Session-Token', deviceTokenFor('d1'));
      expect(res.status).toBe(200);
      expect(res.body.updates).toHaveLength(1);
      expect(res.body.updates[0].sha256).toBe(sha);
    });

    it('a legacy package without stored sha256 is hashed from disk on first use and persisted', async () => {
      const sha = await seedPackage();
      db.prepare('UPDATE app_packages SET sha256 = NULL').run();
      await request(app).post('/api/apps/packages/com.example.app/install').set('Authorization', adminAuthHeader())
        .send({ deviceIds: ['d1'] });
      expect(installPayloads()[0].sha256).toBe(sha);
      expect((db.prepare('SELECT sha256 FROM app_packages').get() as any).sha256).toBe(sha);
    });
  });

  describe('APK downloads need a credential (SS-10)', () => {
    async function seed() {
      deviceStore.enrollDevice({ id: 'd1', name: 'd1' });
      const res = await upload(goodApk, { packageName: 'com.example.app' });
      return res.body.downloadUrl as string;
    }

    it('anonymous is 401, device token and admin JWT are 200 with the exact bytes', async () => {
      const url = await seed();
      expect((await request(app).get(url)).status).toBe(401);
      expect((await request(app).get(url).set('X-Session-Token', 'nope')).status).toBe(401);
      const dev = await request(app).get(url).set('X-Session-Token', deviceTokenFor('d1')).buffer(true).parse((res, cb) => {
        const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
      expect(dev.status).toBe(200);
      expect(Buffer.compare(dev.body, fs.readFileSync(goodApk))).toBe(0);
      expect((await request(app).get(url).set('Authorization', adminAuthHeader())).status).toBe(200);
    });

    it('path traversal never leaves the uploads root', async () => {
      await seed();
      fs.writeFileSync(path.join(path.dirname(uploadsDir), 'secret.txt'), 'secret');
      for (const p of ['/api/uploads/../secret.txt', '/api/uploads/%2e%2e/secret.txt', '/api/uploads/apks/..%2f..%2fsecret.txt']) {
        const r = await request(app).get(p).set('Authorization', adminAuthHeader());
        expect([400, 404]).toContain(r.status);
        expect(r.text || '').not.toContain('secret');
      }
      fs.unlinkSync(path.join(path.dirname(uploadsDir), 'secret.txt'));
    });
  });
});
