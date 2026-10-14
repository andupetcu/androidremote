import request from 'supertest';
import Database from 'better-sqlite3';
import { app, resetRateLimiters } from '../src/app';
import { deviceStore } from '../src/services/deviceStore';
import { commandStore } from '../src/services/commandStore';
import { eventStore } from '../src/services/eventStore';
import { auditStore } from '../src/services/auditStore';
import { policyStore } from '../src/services/policyStore';
import { settingsStore } from '../src/services/settingsStore';
import { queueSyncPolicy } from '../src/services/appSyncService';
import { COMMAND_TYPES, initializeSchema } from '../src/db/schema';
import { setupTestDatabase, cleanupTestDatabase, closeTestDatabase, adminAuthHeader, deviceTokenFor } from './setup';

let db: Database.Database;
const admin = () => adminAuthHeader();

beforeAll(() => { db = setupTestDatabase(); });
afterAll(() => closeTestDatabase());
beforeEach(() => {
  cleanupTestDatabase();
  resetRateLimiters();
  db.prepare("DELETE FROM settings WHERE key LIKE 'update%'").run();
  deviceStore.enrollDevice({ id: 'dev-1', name: 'Dev', model: 'm' });
});

const send = (type: string, payload?: object, id = 'dev-1') =>
  request(app).post(`/api/devices/${id}/commands`).set('Authorization', admin()).send({ type, payload });

describe('C10: new command types are in the enum and in the DB CHECK', () => {
  it.each(['SET_KIOSK', 'DISABLE_APP', 'ENABLE_APP', 'LAUNCH_APP', 'GRANT_PERMISSION', 'SET_PROTECTED_PACKAGES'])(
    '%s is a command type and a row can be stored', type => {
      expect(COMMAND_TYPES).toContain(type);
      // Straight into the table: proves the CHECK constraint accepts it (no validation in between).
      expect(() => db.prepare(
        "INSERT INTO device_commands (id, device_id, type, payload, status, created_at) VALUES (?, 'dev-1', ?, '{}', 'pending', ?)"
      ).run(`c-${type}`, type, Date.now())).not.toThrow();
    });

  it('upgrades an existing table whose CHECK lacks the new types, keeping rows', () => {
    const old = new Database(':memory:');
    old.pragma('foreign_keys = ON');
    initializeSchema(old);
    old.exec('DROP TABLE device_commands');
    old.exec(`CREATE TABLE device_commands (
      id TEXT PRIMARY KEY, device_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('LOCK','REBOOT','WIPE')),
      payload TEXT NOT NULL,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','delivered','executing','completed','failed','expired')),
      created_at INTEGER NOT NULL, delivered_at INTEGER, completed_at INTEGER, error TEXT,
      lease_expires_at INTEGER, expires_at INTEGER,
      FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE)`);
    old.prepare("INSERT INTO devices (id, name) VALUES ('x','x')").run();
    old.prepare("INSERT INTO device_commands (id, device_id, type, payload, created_at, expires_at) VALUES ('keep','x','LOCK','{}',?,?)")
      .run(Date.now(), Date.now() + 1000);
    initializeSchema(old);
    initializeSchema(old); // idempotent
    expect(old.prepare("SELECT id FROM device_commands").all()).toEqual([{ id: 'keep' }]);
    expect(() => old.prepare(
      "INSERT INTO device_commands (id, device_id, type, payload, status, created_at) VALUES ('n','x','SET_KIOSK','{}','pending',?)"
    ).run(Date.now())).not.toThrow();
    old.close();
  });
});

describe('C10: payload validation', () => {
  it('SET_KIOSK needs packageName, enabled and lockTask', async () => {
    expect((await send('SET_KIOSK', { packageName: 'com.x.app', enabled: true, lockTask: true })).status).toBe(201);
    expect((await send('SET_KIOSK', { packageName: 'com.x.app', enabled: true })).status).toBe(400);
    expect((await send('SET_KIOSK', { enabled: true, lockTask: false })).status).toBe(400);
    expect((await send('SET_KIOSK', { packageName: 'not a package', enabled: true, lockTask: false })).status).toBe(400);
    expect((await send('SET_KIOSK', { packageName: 'com.x.app', enabled: 'yes', lockTask: false })).status).toBe(400);
  });

  it.each(['DISABLE_APP', 'ENABLE_APP', 'LAUNCH_APP'])('%s needs a valid packageName', async type => {
    expect((await send(type, { packageName: 'com.x.app' })).status).toBe(201);
    expect((await send(type, {})).status).toBe(400);
    expect((await send(type, { packageName: '../etc' })).status).toBe(400);
    expect((await send(type, { packageName: 42 })).status).toBe(400);
  });

  it('GRANT_PERMISSION needs packageName, permission and a known state', async () => {
    const ok = { packageName: 'com.x.app', permission: 'android.permission.CAMERA', state: 'granted' };
    expect((await send('GRANT_PERMISSION', ok)).status).toBe(201);
    for (const state of ['denied', 'default']) expect((await send('GRANT_PERMISSION', { ...ok, state })).status).toBe(201);
    expect((await send('GRANT_PERMISSION', { ...ok, state: 'maybe' })).status).toBe(400);
    expect((await send('GRANT_PERMISSION', { ...ok, permission: '' })).status).toBe(400);
    expect((await send('GRANT_PERMISSION', { packageName: 'com.x.app', state: 'granted' })).status).toBe(400);
  });

  it('SET_PROTECTED_PACKAGES needs an array of package names (may be empty, bounded)', async () => {
    expect((await send('SET_PROTECTED_PACKAGES', { packages: ['com.a.b', 'com.c.d'] })).status).toBe(201);
    expect((await send('SET_PROTECTED_PACKAGES', { packages: [] })).status).toBe(201);
    expect((await send('SET_PROTECTED_PACKAGES', {})).status).toBe(400);
    expect((await send('SET_PROTECTED_PACKAGES', { packages: 'com.a.b' })).status).toBe(400);
    expect((await send('SET_PROTECTED_PACKAGES', { packages: ['ok.pkg', 'bad pkg'] })).status).toBe(400);
    expect((await send('SET_PROTECTED_PACKAGES', { packages: Array.from({ length: 501 }, (_, i) => `com.p${i}.x`) })).status).toBe(400);
  });

  it('the same validation runs on POST /api/commands and the batch route', async () => {
    const bad = await request(app).post('/api/commands').set('Authorization', admin())
      .send({ deviceId: 'dev-1', type: 'LAUNCH_APP', payload: {} });
    expect(bad.status).toBe(400);
    const batch = await request(app).post('/api/commands/batch').set('Authorization', admin())
      .send({ deviceIds: ['dev-1'], type: 'LAUNCH_APP', payload: {} });
    expect(batch.body.queued).toBe(0);
    expect(batch.body.errors).toHaveLength(1);
  });

  it('every new command is audited with its type and package', async () => {
    await send('DISABLE_APP', { packageName: 'com.x.app' });
    const entry = auditStore.getRecentLogs(10).find(l => l.action === 'command.queued')!;
    expect(entry.details).toMatchObject({ type: 'DISABLE_APP', packageName: 'com.x.app' });
  });
});

describe('C10 / AM-16: WIPE confirmation and audit reason', () => {
  it('is refused without confirm, or with another device id', async () => {
    expect((await send('WIPE', {})).status).toBe(400);
    expect((await send('WIPE')).status).toBe(400);
    expect((await send('WIPE', { confirm: 'other-device' })).status).toBe(400);
    expect((await send('WIPE', { confirm: 'dev-1' })).status).toBe(201);
    expect(commandStore.getCommandHistory('dev-1')).toHaveLength(1);
  });

  it('the batch route cannot wipe with a confirm that names a different device', async () => {
    deviceStore.enrollDevice({ id: 'dev-2', name: 'Two', model: 'm' });
    const r = await request(app).post('/api/commands/batch').set('Authorization', admin())
      .send({ deviceIds: ['dev-1', 'dev-2'], type: 'WIPE', payload: { confirm: 'dev-1' } });
    expect(r.body.queued).toBe(1);
    expect(r.body.errors).toHaveLength(1);
    expect(commandStore.getCommandHistory('dev-2')).toHaveLength(0);
  });

  it('accepts wipeExternalStorage as a boolean only, and passes it to the device', async () => {
    expect((await send('WIPE', { confirm: 'dev-1', wipeExternalStorage: 'yes' })).status).toBe(400);
    const r = await send('WIPE', { confirm: 'dev-1', wipeExternalStorage: true, reason: 'device lost' });
    expect(r.status).toBe(201);
    expect(r.body.payload).toMatchObject({ confirm: 'dev-1', wipeExternalStorage: true });
  });

  it('audits the wipe with the reason and the external storage flag', async () => {
    await send('WIPE', { confirm: 'dev-1', wipeExternalStorage: true, reason: 'device lost' });
    const entry = auditStore.getRecentLogs(10).find(l => l.action === 'command.queued')!;
    expect(entry.details).toMatchObject({ type: 'WIPE', reason: 'device lost', wipeExternalStorage: true });
  });

  it('a long reason is truncated in the audit log', async () => {
    await send('WIPE', { confirm: 'dev-1', reason: 'r'.repeat(5000) });
    const entry = auditStore.getRecentLogs(10).find(l => l.action === 'command.queued')!;
    expect(String((entry.details as any).reason).length).toBeLessThanOrEqual(500);
  });
});

describe('AM-08: optional updateWindow in SYNC_POLICY', () => {
  function syncPayload(): Record<string, any> {
    const policy = policyStore.createPolicy({ name: 'p', requiredApps: [] } as any);
    const cmd = queueSyncPolicy('dev-1', policy);
    return cmd.payload;
  }

  it('is null by default (an explicit clear)', () => {
    expect(syncPayload().updateWindow).toBeNull();
  });

  it('comes from the settings updateWindowStart / updateWindowEnd', () => {
    settingsStore.setMultiple({ updateWindowStart: '02:00', updateWindowEnd: '05:30' });
    expect(syncPayload().updateWindow).toEqual({ start: '02:00', end: '05:30' });
  });

  it('PUT /api/settings accepts a valid window and rejects a malformed one', async () => {
    const ok = await request(app).put('/api/settings').set('Authorization', admin())
      .send({ updateWindowStart: '22:00', updateWindowEnd: '04:00' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ updateWindowStart: '22:00', updateWindowEnd: '04:00' });
    for (const bad of [{ updateWindowStart: '25:00', updateWindowEnd: '04:00' }, { updateWindowStart: '2am', updateWindowEnd: '04:00' }, { updateWindowStart: '22:00' }]) {
      expect((await request(app).put('/api/settings').set('Authorization', admin()).send(bad)).status).toBe(400);
    }
  });

  it('an empty pair clears the window', async () => {
    settingsStore.setMultiple({ updateWindowStart: '02:00', updateWindowEnd: '05:30' });
    const r = await request(app).put('/api/settings').set('Authorization', admin()).send({ updateWindowStart: '', updateWindowEnd: '' });
    expect(r.status).toBe(200);
    expect(syncPayload().updateWindow).toBeNull();
  });
});

describe('SR-16 follow-up: commands stuck in executing are timed out', () => {
  const MIN = 60_000;
  function executing(type: any, sinceMs: number): string {
    const c = commandStore.queueCommand('dev-1', type, {});
    commandStore.acknowledgeCommand(c.id, 'executing', undefined, 'dev-1');
    db.prepare('UPDATE device_commands SET executing_at = ? WHERE id = ?').run(Date.now() - sinceMs, c.id);
    return c.id;
  }
  const status = (id: string) => commandStore.getCommand(id)!.status;

  it('records when execution started', () => {
    const c = commandStore.queueCommand('dev-1', 'LOCK', {});
    const before = Date.now();
    commandStore.acknowledgeCommand(c.id, 'executing', undefined, 'dev-1');
    const row = db.prepare('SELECT executing_at FROM device_commands WHERE id = ?').get(c.id) as any;
    expect(row.executing_at).toBeGreaterThanOrEqual(before);
  });

  it('fails a command that has been executing for more than twice its type timeout', () => {
    const quick = executing('LOCK', 30 * MIN); // 2 x 5 min timeout = 10 min
    const slow = executing('INSTALL_APK', 20 * MIN); // 2 x 15 min = 30 min, still within it
    const stuckSlow = executing('INSTALL_APK', 45 * MIN);
    const swept = commandStore.expireStuckExecuting();
    expect(swept.map(c => c.id).sort()).toEqual([quick, stuckSlow].sort());
    expect(status(quick)).toBe('failed');
    expect(commandStore.getCommand(quick)!.error).toMatch(/timed out/i);
    expect(status(slow)).toBe('executing');
    expect(status(stuckSlow)).toBe('failed');
  });

  it('leaves pending, delivered and finished commands alone', () => {
    const pending = commandStore.queueCommand('dev-1', 'LOCK', {});
    const done = executing('LOCK', 60 * MIN);
    commandStore.acknowledgeCommand(done, 'completed', undefined, 'dev-1');
    expect(commandStore.expireStuckExecuting()).toEqual([]);
    expect(status(pending.id)).toBe('pending');
    expect(status(done)).toBe('completed');
  });

  it('COMMAND_EXECUTING_TIMEOUT_MS overrides the per-type timeout', () => {
    process.env.COMMAND_EXECUTING_TIMEOUT_MS = String(MIN);
    try {
      const id = executing('INSTALL_APK', 3 * MIN);
      expect(commandStore.expireStuckExecuting().map(c => c.id)).toEqual([id]);
    } finally {
      delete process.env.COMMAND_EXECUTING_TIMEOUT_MS;
    }
  });

  it('a late completed ack for a timed-out command is a 409, not a resurrection', async () => {
    const id = executing('LOCK', 60 * MIN);
    commandStore.expireStuckExecuting();
    const token = deviceTokenFor('dev-1');
    const r = await request(app).patch(`/api/devices/dev-1/commands/${id}`).set('X-Session-Token', token).send({ status: 'completed' });
    expect(r.status).toBe(409);
  });

  it('legacy executing rows without executing_at fall back to delivered_at, then created_at', () => {
    const c = commandStore.queueCommand('dev-1', 'LOCK', {});
    commandStore.acknowledgeCommand(c.id, 'executing', undefined, 'dev-1');
    db.prepare('UPDATE device_commands SET executing_at = NULL, delivered_at = NULL, created_at = ? WHERE id = ?').run(Date.now() - 60 * MIN, c.id);
    expect(commandStore.expireStuckExecuting().map(x => x.id)).toEqual([c.id]);
  });

  it('the timeout raises command-failed events through the maintenance task', () => {
    const { sweepStuckCommands } = require('../src/services/maintenance');
    const id = executing('LOCK', 60 * MIN);
    sweepStuckCommands();
    const ev = eventStore.getDeviceEvents('dev-1').find(e => e.eventType === 'command-failed')!;
    expect(ev.data).toMatchObject({ commandId: id });
    expect(auditStore.getRecentLogs(10).map(l => l.action)).toContain('command.timed_out');
  });
});
