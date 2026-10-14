import request from 'supertest';
import Database from 'better-sqlite3';
import { app, resetRateLimiters } from '../src/app';
import { deviceStore } from '../src/services/deviceStore';
import { commandStore } from '../src/services/commandStore';
import { policyStore } from '../src/services/policyStore';
import { pairingStore } from '../src/services/pairingStore';
import { initializeSchema } from '../src/db/schema';
import {
  setupTestDatabase, cleanupTestDatabase, closeTestDatabase, adminAuthHeader, deviceTokenFor,
} from './setup';

let db: Database.Database;

function enroll(id: string): string {
  deviceStore.enrollDevice({ id, name: id, model: 'm' });
  return deviceTokenFor(id);
}

const poll = (id: string, token: string) =>
  request(app).get(`/api/devices/${id}/commands/pending`).set('X-Session-Token', token);

const ack = (id: string, token: string, cmdId: string, status: string, error?: string) =>
  request(app).patch(`/api/devices/${id}/commands/${cmdId}`).set('X-Session-Token', token).send({ status, error });

const rowOf = (id: string) =>
  db.prepare('SELECT * FROM device_commands WHERE id = ?').get(id) as Record<string, any>;

describe('T6 command lifecycle (C5)', () => {
  beforeAll(() => { db = setupTestDatabase(); });
  afterAll(() => closeTestDatabase());
  beforeEach(() => { cleanupTestDatabase(); resetRateLimiters(); });

  describe('lease and redelivery (SR-03)', () => {
    it('delivers once, sets a lease, and does not redeliver inside the lease', async () => {
      const token = enroll('d1');
      const cmd = commandStore.queueCommand('d1', 'LOCK', {});
      const first = await poll('d1', token);
      expect(first.body.commands.map((c: any) => c.id)).toEqual([cmd.id]);
      const row = rowOf(cmd.id);
      expect(row.status).toBe('delivered');
      expect(row.lease_expires_at).toBeGreaterThan(Date.now() + 4 * 60 * 1000);
      expect(row.lease_expires_at).toBeLessThanOrEqual(Date.now() + 5 * 60 * 1000 + 1000);

      const second = await poll('d1', token);
      expect(second.body.commands).toEqual([]);
    });

    it('redelivers a delivered command whose lease expired, with a new lease', async () => {
      const token = enroll('d1');
      const cmd = commandStore.queueCommand('d1', 'SCREEN_ON', {});
      await poll('d1', token);
      db.prepare('UPDATE device_commands SET lease_expires_at = ? WHERE id = ?').run(Date.now() - 1000, cmd.id);

      const again = await poll('d1', token);
      expect(again.body.commands.map((c: any) => c.id)).toEqual([cmd.id]);
      expect(rowOf(cmd.id).lease_expires_at).toBeGreaterThan(Date.now() + 4 * 60 * 1000);
    });

    it('does not redeliver an executing command', async () => {
      const token = enroll('d1');
      const cmd = commandStore.queueCommand('d1', 'SCREEN_ON', {});
      await poll('d1', token);
      await ack('d1', token, cmd.id, 'executing');
      db.prepare('UPDATE device_commands SET lease_expires_at = ? WHERE id = ?').run(Date.now() - 1000, cmd.id);
      expect((await poll('d1', token)).body.commands).toEqual([]);
    });

    it('honours COMMAND_LEASE_MS', async () => {
      process.env.COMMAND_LEASE_MS = '1000';
      try {
        const token = enroll('d1');
        const cmd = commandStore.queueCommand('d1', 'SCREEN_ON', {});
        await poll('d1', token);
        const lease = rowOf(cmd.id).lease_expires_at;
        expect(lease).toBeLessThanOrEqual(Date.now() + 1500);
      } finally {
        delete process.env.COMMAND_LEASE_MS;
      }
    });
  });

  describe('expiry (SR-04)', () => {
    it.each([['REBOOT'], ['LOCK'], ['WIPE'], ['START_REMOTE']])('%s expires after 15 minutes by default', (type) => {
      enroll('d1');
      const cmd = commandStore.queueCommand('d1', type as any, {});
      const exp = rowOf(cmd.id).expires_at;
      expect(exp).toBeGreaterThan(Date.now() + 14 * 60 * 1000);
      expect(exp).toBeLessThanOrEqual(Date.now() + 15 * 60 * 1000 + 1000);
    });

    it.each([['INSTALL_APK'], ['SYNC_POLICY'], ['SCREEN_ON']])('%s expires after 7 days', (type) => {
      enroll('d1');
      const cmd = commandStore.queueCommand('d1', type as any, {});
      const exp = rowOf(cmd.id).expires_at;
      const week = 7 * 24 * 60 * 60 * 1000;
      expect(exp).toBeGreaterThan(Date.now() + week - 60 * 1000);
      expect(exp).toBeLessThanOrEqual(Date.now() + week + 1000);
    });

    it('never delivers an expired command and marks it expired', async () => {
      const token = enroll('d1');
      const stale = commandStore.queueCommand('d1', 'REBOOT', {});
      const fresh = commandStore.queueCommand('d1', 'LOCK', {});
      db.prepare('UPDATE device_commands SET expires_at = ? WHERE id = ?').run(Date.now() - 1, stale.id);

      const res = await poll('d1', token);
      expect(res.body.commands.map((c: any) => c.id)).toEqual([fresh.id]);
      expect(rowOf(stale.id).status).toBe('expired');
    });

    it('does not redeliver a lease-expired command that has also expired', async () => {
      const token = enroll('d1');
      const cmd = commandStore.queueCommand('d1', 'REBOOT', {});
      await poll('d1', token);
      db.prepare('UPDATE device_commands SET lease_expires_at = ?, expires_at = ? WHERE id = ?')
        .run(Date.now() - 2000, Date.now() - 1000, cmd.id);
      expect((await poll('d1', token)).body.commands).toEqual([]);
      expect(rowOf(cmd.id).status).toBe('expired');
    });

    it('acking an expired command is 410 even before a poll swept it', async () => {
      const token = enroll('d1');
      const cmd = commandStore.queueCommand('d1', 'REBOOT', {});
      await poll('d1', token);
      db.prepare('UPDATE device_commands SET expires_at = ? WHERE id = ?').run(Date.now() - 1, cmd.id);
      const res = await ack('d1', token, cmd.id, 'executing');
      expect(res.status).toBe(410);
    });

    it('honours COMMAND_TTL_SHORT_MS and COMMAND_TTL_DEFAULT_MS', () => {
      process.env.COMMAND_TTL_SHORT_MS = '1000';
      process.env.COMMAND_TTL_DEFAULT_MS = '2000';
      try {
        enroll('d1');
        const a = commandStore.queueCommand('d1', 'REBOOT', {});
        const b = commandStore.queueCommand('d1', 'SCREEN_ON', {});
        expect(rowOf(a.id).expires_at).toBeLessThanOrEqual(Date.now() + 1500);
        expect(rowOf(b.id).expires_at).toBeLessThanOrEqual(Date.now() + 2500);
      } finally {
        delete process.env.COMMAND_TTL_SHORT_MS;
        delete process.env.COMMAND_TTL_DEFAULT_MS;
      }
    });
  });

  describe('acks are scoped and idempotent (SR-12)', () => {
    it("another device's command looks unknown and is not changed", async () => {
      const t1 = enroll('d1');
      enroll('d2');
      const cmd = commandStore.queueCommand('d2', 'LOCK', {});
      const res = await ack('d1', t1, cmd.id, 'completed');
      expect(res.status).toBe(404);
      expect(rowOf(cmd.id).status).toBe('pending');
    });

    it('store-level ack and cancel are scoped to the device', () => {
      enroll('d1');
      enroll('d2');
      const cmd = commandStore.queueCommand('d2', 'LOCK', {});
      expect(commandStore.acknowledgeCommand(cmd.id, 'completed', undefined, 'd1')).toBe(false);
      expect(commandStore.cancelCommand(cmd.id, 'd1')).toBe(false);
      expect(commandStore.cancelCommand(cmd.id, 'd2')).toBe(true);
    });

    it('a duplicate completed ack changes nothing and records one event', async () => {
      const token = enroll('d1');
      const cmd = commandStore.queueCommand('d1', 'LOCK', {});
      await poll('d1', token);
      expect((await ack('d1', token, cmd.id, 'completed')).status).toBe(200);
      const completedAt = rowOf(cmd.id).completed_at;
      expect((await ack('d1', token, cmd.id, 'completed')).status).toBe(409);
      expect((await ack('d1', token, cmd.id, 'failed', 'late')).status).toBe(409);
      expect(rowOf(cmd.id).completed_at).toBe(completedAt);
      expect(rowOf(cmd.id).status).toBe('completed');
      const events = db.prepare("SELECT COUNT(*) c FROM device_events WHERE event_type='command-completed'").get() as any;
      expect(events.c).toBe(1);
    });

    it('a repeated executing ack is 200', async () => {
      const token = enroll('d1');
      const cmd = commandStore.queueCommand('d1', 'LOCK', {});
      await poll('d1', token);
      expect((await ack('d1', token, cmd.id, 'executing')).status).toBe(200);
      expect((await ack('d1', token, cmd.id, 'executing')).status).toBe(200);
    });

    it('DELETE cancel is scoped to the device in the URL', async () => {
      enroll('d1');
      enroll('d2');
      const cmd = commandStore.queueCommand('d2', 'LOCK', {});
      const res = await request(app).delete(`/api/devices/d1/commands/${cmd.id}`).set('Authorization', adminAuthHeader());
      expect(res.status).toBe(404);
      expect(rowOf(cmd.id)).toBeTruthy();
    });
  });

  describe('heartbeat does not consume commands (SR-02)', () => {
    it('leaves a pending command pending and queues SYNC_APPS once', async () => {
      const token = enroll('d1');
      const cmd = commandStore.queueCommand('d1', 'REBOOT', {});

      const hb = await request(app).post('/api/devices/d1/heartbeat').set('X-Session-Token', token).send({});
      expect(hb.status).toBe(200);
      expect(rowOf(cmd.id).status).toBe('pending');
      expect(rowOf(cmd.id).delivered_at).toBeNull();

      await request(app).post('/api/devices/d1/heartbeat').set('X-Session-Token', token).send({});
      const syncs = db.prepare("SELECT COUNT(*) c FROM device_commands WHERE device_id='d1' AND type='SYNC_APPS'").get() as any;
      expect(syncs.c).toBe(1);

      const res = await poll('d1', token);
      expect(res.body.commands.map((c: any) => c.id)).toContain(cmd.id);
    });

    it('does not call getPendingCommands', async () => {
      const token = enroll('d1');
      const spy = jest.spyOn(commandStore, 'getPendingCommands');
      try {
        await request(app).post('/api/devices/d1/heartbeat').set('X-Session-Token', token).send({});
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });

    it('hasPendingOfType is a non-consuming query', () => {
      enroll('d1');
      commandStore.queueCommand('d1', 'SYNC_APPS', {});
      expect(commandStore.hasPendingOfType('d1', 'SYNC_APPS')).toBe(true);
      expect(commandStore.hasPendingOfType('d1', 'LOCK')).toBe(false);
      const row = db.prepare("SELECT status FROM device_commands WHERE device_id='d1'").get() as any;
      expect(row.status).toBe('pending');
    });
  });

  describe('policy sync collapses duplicates (SR-18)', () => {
    it('keeps one pending SYNC_POLICY per device across repeated assignments and edits', async () => {
      enroll('d1');
      const policy = policyStore.createPolicy({ name: 'p', requiredApps: [] } as any);
      for (let i = 0; i < 3; i++) {
        await request(app).put('/api/devices/d1/policy').set('Authorization', adminAuthHeader()).send({ policyId: policy.id });
      }
      for (let i = 0; i < 3; i++) {
        await request(app).put(`/api/policies/${policy.id}`).set('Authorization', adminAuthHeader())
          .send({ silentMode: i % 2 === 0 });
      }
      const pending = db.prepare("SELECT payload FROM device_commands WHERE device_id='d1' AND type='SYNC_POLICY' AND status='pending'").all() as any[];
      expect(pending).toHaveLength(1);
      expect(JSON.parse(pending[0].payload).silentMode).toBe(true); // the newest edit (i = 2)
      const superseded = db.prepare("SELECT COUNT(*) c FROM device_commands WHERE type='SYNC_POLICY' AND status='expired'").get() as any;
      expect(superseded.c).toBe(5);
    });

    it('supersedes by type and package for policy INSTALL_APK, keeping other packages', () => {
      enroll('d1');
      const a1 = commandStore.queueCommand('d1', 'INSTALL_APK', { packageName: 'com.a', url: 'u' }, { supersede: 'packageName' });
      const b1 = commandStore.queueCommand('d1', 'INSTALL_APK', { packageName: 'com.b', url: 'u' }, { supersede: 'packageName' });
      const a2 = commandStore.queueCommand('d1', 'INSTALL_APK', { packageName: 'com.a', url: 'u2' }, { supersede: 'packageName' });
      expect(rowOf(a1.id).status).toBe('expired');
      expect(rowOf(b1.id).status).toBe('pending');
      expect(rowOf(a2.id).status).toBe('pending');
    });

    it('does not supersede a command that is already delivered', async () => {
      const token = enroll('d1');
      const first = commandStore.queueCommand('d1', 'SYNC_POLICY', { v: 1 }, { supersede: 'type' });
      await poll('d1', token);
      commandStore.queueCommand('d1', 'SYNC_POLICY', { v: 2 }, { supersede: 'type' });
      expect(rowOf(first.id).status).toBe('delivered');
    });
  });

  describe('migration (SR-16)', () => {
    function legacyDb(): Database.Database {
      const old = new Database(':memory:');
      old.pragma('foreign_keys = ON');
      initializeSchema(old);
      // Recreate the pre-T6 table (no lease/expires columns, no 'expired' status).
      old.pragma('foreign_keys = OFF');
      old.exec('DROP TABLE device_commands');
      old.exec(`CREATE TABLE device_commands (
        id TEXT PRIMARY KEY, device_id TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('INSTALL_APK','REBOOT','LOCK','SYNC_APPS','START_REMOTE','WIPE','UNINSTALL_APP')),
        payload TEXT NOT NULL,
        status TEXT DEFAULT 'pending' CHECK(status IN ('pending','delivered','executing','completed','failed')),
        created_at INTEGER NOT NULL, delivered_at INTEGER, completed_at INTEGER, error TEXT,
        FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE)`);
      old.pragma('foreign_keys = ON');
      return old;
    }

    it('adds columns and the expired status, keeps rows, backfills expiry, and is idempotent', () => {
      const old = legacyDb();
      old.prepare("INSERT INTO devices (id, name, enrolled_at, status) VALUES ('d1','d1',1,'online')").run();
      const ins = old.prepare("INSERT INTO device_commands (id, device_id, type, payload, status, created_at) VALUES (?,?,?,?,?,?)");
      ins.run('c-old-reboot', 'd1', 'REBOOT', '{}', 'pending', Date.now() - 3 * 24 * 3600 * 1000);
      ins.run('c-fresh', 'd1', 'LOCK', '{}', 'pending', Date.now());
      ins.run('c-done', 'd1', 'LOCK', '{}', 'completed', Date.now() - 1000);

      initializeSchema(old);
      initializeSchema(old); // idempotent

      const cols = (old.prepare('PRAGMA table_info(device_commands)').all() as any[]).map(c => c.name);
      expect(cols).toEqual(expect.arrayContaining(['lease_expires_at', 'expires_at']));
      const rows = old.prepare('SELECT id, status, expires_at FROM device_commands ORDER BY id').all() as any[];
      expect(rows.map(r => r.id)).toEqual(['c-done', 'c-fresh', 'c-old-reboot']);
      expect(rows.find(r => r.id === 'c-fresh').expires_at).toBeGreaterThan(Date.now());
      expect(rows.find(r => r.id === 'c-old-reboot').expires_at).toBeLessThan(Date.now());
      old.prepare("UPDATE device_commands SET status = 'expired' WHERE id = 'c-fresh'").run(); // CHECK accepts it
      expect(old.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'device_commands%'").all().map((r: any) => r.name))
        .not.toContain('device_commands_old');
      old.close();
    });

    it('rolls back completely when the copy fails, leaving the old table intact', () => {
      const old = legacyDb();
      old.prepare("INSERT INTO devices (id, name, enrolled_at, status) VALUES ('d1','d1',1,'online')").run();
      old.prepare("INSERT INTO device_commands (id, device_id, type, payload, status, created_at) VALUES ('c1','d1','LOCK','{}','pending',1)").run();
      // Make the copy step fail, as a crash mid-migration would.
      const realExec = old.exec.bind(old);
      let failed = false;
      (old as any).exec = (sql: string) => {
        if (!failed && /INSERT INTO device_commands_new/.test(sql)) { failed = true; throw new Error('disk full'); }
        return realExec(sql);
      };
      expect(() => initializeSchema(old)).toThrow();
      (old as any).exec = realExec;
      const count = old.prepare('SELECT COUNT(*) c FROM device_commands').get() as any;
      expect(count.c).toBe(1);
      old.close();
    });
  });

  describe('SR-15 offline keeps last_seen_at', () => {
    it('does not null last_seen_at', () => {
      enroll('d1');
      deviceStore.updateDeviceStatus('d1', 'online');
      const seen = (db.prepare('SELECT last_seen_at FROM devices WHERE id = ?').get('d1') as any).last_seen_at;
      expect(seen).toBeGreaterThan(0);
      deviceStore.updateDeviceStatus('d1', 'offline');
      const row = db.prepare('SELECT last_seen_at, status FROM devices WHERE id = ?').get('d1') as any;
      expect(row.status).toBe('offline');
      expect(row.last_seen_at).toBe(seen);
    });
  });

  describe('/pair/status session token is one-time', () => {
    const initiate = async () => {
      const init = await request(app).post('/api/pair/initiate').send({ devicePublicKey: 'a'.repeat(64) });
      await request(app).post('/api/pair/complete').set('Authorization', adminAuthHeader())
        .send({ pairingCode: init.body.pairingCode, controllerPublicKey: 'b'.repeat(64) });
      return init.body.deviceId as string;
    };

    it('returns the token on the first poll only', async () => {
      const deviceId = await initiate();
      const first = await request(app).get(`/api/pair/status/${deviceId}`);
      expect(first.body.status).toBe('completed');
      expect(typeof first.body.sessionToken).toBe('string');
      const second = await request(app).get(`/api/pair/status/${deviceId}`);
      expect(second.status).toBe(200);
      expect(second.body.sessionToken).toBeUndefined();
      expect(second.body.status).toBe('completed');
      const stored = db.prepare('SELECT session_token FROM pairing_sessions WHERE device_id = ?').get(deviceId) as any;
      expect(stored.session_token).toBeNull();
      // the token itself still works for the device
      expect(deviceStore.validateDeviceSession(first.body.sessionToken, deviceId)).toBe(true);
    });

    it('no longer returns the token once the pairing window has passed', async () => {
      const deviceId = await initiate();
      db.prepare('UPDATE pairing_sessions SET expires_at = ? WHERE device_id = ?').run(Date.now() - 1000, deviceId);
      const res = await request(app).get(`/api/pair/status/${deviceId}`);
      expect(res.body.sessionToken).toBeUndefined();
    });
  });
});
