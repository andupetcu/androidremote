import request from 'supertest';
import http from 'http';
import { EventEmitter } from 'events';
import Database from 'better-sqlite3';
import { app, resetRateLimiters } from '../src/app';
import { deviceStore } from '../src/services/deviceStore';
import { commandStore } from '../src/services/commandStore';
import { eventStore } from '../src/services/eventStore';
import { auditStore } from '../src/services/auditStore';
import { initializeSchema } from '../src/db/schema';
import {
  runRetention, retentionConfig, sweepOfflineDevices, startMaintenance,
} from '../src/services/maintenance';
import { createShutdown, installProcessHandlers } from '../src/shutdown';
import { setupTestDatabase, cleanupTestDatabase, closeTestDatabase, adminAuthHeader, deviceTokenFor } from './setup';

let db: Database.Database;
const DAY = 86_400_000;

beforeAll(() => { db = setupTestDatabase(); });
afterAll(() => closeTestDatabase());
beforeEach(() => {
  cleanupTestDatabase();
  resetRateLimiters();
  for (const k of ['RETENTION_TELEMETRY_DAYS', 'RETENTION_EVENTS_DAYS', 'RETENTION_AUDIT_DAYS', 'RETENTION_COMMANDS_DAYS']) delete process.env[k];
});

function plan(sql: string, ...args: unknown[]): string {
  return (db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...args) as Array<{ detail: string }>).map(r => r.detail).join(' | ');
}

describe('SR-10: indexes for the hot queries', () => {
  it('creates the indexes', () => {
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>).map(r => r.name);
    expect(names).toEqual(expect.arrayContaining([
      'idx_device_events_created', 'idx_device_commands_dev_created', 'idx_device_commands_created',
      'idx_telemetry_history_device', 'idx_device_events_device',
    ]));
  });

  it('is idempotent and survives re-running the schema on a populated database', () => {
    deviceStore.enrollDevice({ id: 'd1', name: 'd1', model: 'm' });
    commandStore.queueCommand('d1', 'LOCK', {});
    expect(() => { initializeSchema(db); initializeSchema(db); }).not.toThrow();
    expect(commandStore.getCommandHistory('d1')).toHaveLength(1);
  });

  it('the dashboard events query reads the created_at index instead of sorting a scan', () => {
    const p = plan('SELECT * FROM device_events ORDER BY created_at DESC LIMIT 100');
    expect(p).toContain('idx_device_events_created');
    expect(p).not.toMatch(/TEMP B-TREE/);
  });

  it('command history per device reads (device_id, created_at) without a sort', () => {
    const p = plan("SELECT * FROM device_commands WHERE device_id = ? ORDER BY created_at DESC LIMIT 50", 'd1');
    expect(p).toContain('idx_device_commands_dev_created');
    expect(p).not.toMatch(/TEMP B-TREE/);
  });

  it('the global command list reads the created_at index', () => {
    expect(plan('SELECT * FROM device_commands ORDER BY created_at DESC LIMIT 100')).toContain('idx_device_commands_created');
  });

  it('telemetry history range reads the (device_id, recorded_at) index', () => {
    expect(plan('SELECT * FROM telemetry_history WHERE device_id = ? AND recorded_at BETWEEN ? AND ?', 'd', 0, 1))
      .toMatch(/idx_telemetry_history_(device|dedupe)/); // both lead with (device_id, recorded_at)
  });

  it('pending commands are returned in creation order even within one millisecond', () => {
    deviceStore.enrollDevice({ id: 'd1', name: 'd1', model: 'm' });
    const spy = jest.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const ids = ['LOCK', 'REBOOT', 'SYNC_APPS', 'SCREEN_ON'].map(t => commandStore.queueCommand('d1', t as any, {}).id);
    spy.mockRestore();
    expect(commandStore.getPendingCommands('d1').map(c => c.id)).toEqual(ids);
  });
});

describe('SR-10: server-side page size cap', () => {
  beforeEach(() => deviceStore.enrollDevice({ id: 'd1', name: 'd1', model: 'm' }));
  const get = (url: string) => request(app).get(url).set('Authorization', adminAuthHeader());

  it('events: NaN falls back to the default, huge values are capped at 500', async () => {
    const ins = db.prepare("INSERT INTO device_events (device_id, event_type, severity, created_at) VALUES ('d1','battery-low','warning',?)");
    for (let i = 0; i < 520; i++) ins.run(Date.now() + i);
    expect((await get('/api/events?limit=abc')).body.events).toHaveLength(100);
    expect((await get('/api/events?limit=100000')).body.events).toHaveLength(500);
    expect((await get('/api/events?limit=-5')).body.events).toHaveLength(100);
    expect((await get('/api/devices/d1/events?limit=99999')).body.events).toHaveLength(500);
  });

  it('audit: capped the same way', async () => {
    const ins = db.prepare("INSERT INTO audit_logs (id, timestamp, actor_type, action, resource_type) VALUES (?, ?, 'admin', 'command.queued', 'command')");
    for (let i = 0; i < 520; i++) ins.run(`a${i}`, Date.now() + i);
    expect((await get('/api/audit?limit=nope')).body.logs).toHaveLength(100);
    expect((await get('/api/audit?limit=1e9')).body.logs.length).toBeLessThanOrEqual(500);
    expect((await get('/api/audit?limit=100000')).body.logs).toHaveLength(500);
    expect((await get('/api/devices/d1/audit?limit=abc')).status).toBe(200);
  });

  it('command history: capped and NaN-safe', async () => {
    const ins = db.prepare("INSERT INTO device_commands (id, device_id, type, payload, status, created_at) VALUES (?, 'd1', 'LOCK', '{}', 'completed', ?)");
    for (let i = 0; i < 520; i++) ins.run(`c${i}`, Date.now() + i);
    expect((await get('/api/devices/d1/commands?limit=100000')).body.commands).toHaveLength(500);
    expect((await get('/api/devices/d1/commands?limit=abc&offset=zzz')).status).toBe(200);
  });
});

describe('SR-08: retention', () => {
  function seed(): void {
    deviceStore.enrollDevice({ id: 'd1', name: 'd1', model: 'm' });
    const now = Date.now();
    const th = db.prepare("INSERT INTO telemetry_history (device_id, battery_level, recorded_at) VALUES ('d1', 50, ?)");
    th.run(now - 31 * DAY); th.run(now - 29 * DAY);
    const ev = db.prepare("INSERT INTO device_events (device_id, event_type, severity, created_at) VALUES ('d1','battery-low','warning',?)");
    ev.run(now - 91 * DAY); ev.run(now - 89 * DAY);
    const au = db.prepare("INSERT INTO audit_logs (id, timestamp, actor_type, action, resource_type) VALUES (?, ?, 'admin', 'command.queued', 'command')");
    au.run('old', now - 366 * DAY); au.run('new', now - 364 * DAY);
    const cm = db.prepare("INSERT INTO device_commands (id, device_id, type, payload, status, created_at, expires_at) VALUES (?, 'd1', 'LOCK', '{}', ?, ?, ?)");
    cm.run('c-old-done', 'completed', now - 31 * DAY, now - 31 * DAY + 1000);
    cm.run('c-old-failed', 'failed', now - 40 * DAY, now - 40 * DAY + 1000);
    cm.run('c-old-expired', 'expired', now - 40 * DAY, now - 40 * DAY + 1000);
    cm.run('c-new-done', 'completed', now - 29 * DAY, now - 29 * DAY + 1000);
    cm.run('c-old-pending', 'pending', now - 40 * DAY, now + DAY);
    cm.run('c-old-executing', 'executing', now - 40 * DAY, now + DAY);
  }
  const ids = (sql: string) => (db.prepare(sql).all() as any[]).map(r => r.id ?? r.c);

  it('uses 30 / 90 / 365 / 30 days by default', () => {
    expect(retentionConfig()).toEqual({ telemetryDays: 30, eventsDays: 90, auditDays: 365, commandsDays: 30 });
  });

  it('removes only rows past their window and only finished commands', () => {
    seed();
    const r = runRetention(db);
    expect(r).toMatchObject({ telemetryHistory: 1, events: 1, audit: 1, commands: 3 });
    expect(db.prepare('SELECT COUNT(*) AS c FROM telemetry_history').get()).toEqual({ c: 1 });
    expect(db.prepare('SELECT COUNT(*) AS c FROM device_events').get()).toEqual({ c: 1 });
    expect(ids('SELECT id FROM audit_logs')).toEqual(['new']);
    expect(ids('SELECT id FROM device_commands ORDER BY id')).toEqual(['c-new-done', 'c-old-executing', 'c-old-pending']);
  });

  it('days are configurable through env', () => {
    seed();
    process.env.RETENTION_TELEMETRY_DAYS = '10';
    process.env.RETENTION_EVENTS_DAYS = '10';
    process.env.RETENTION_AUDIT_DAYS = '10';
    process.env.RETENTION_COMMANDS_DAYS = '10';
    expect(retentionConfig()).toEqual({ telemetryDays: 10, eventsDays: 10, auditDays: 10, commandsDays: 10 });
    runRetention(db);
    expect(db.prepare('SELECT COUNT(*) AS c FROM telemetry_history').get()).toEqual({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) AS c FROM device_events').get()).toEqual({ c: 0 });
    expect(ids('SELECT id FROM audit_logs')).toEqual([]);
  });

  it('an invalid value falls back to the default instead of deleting everything', () => {
    seed();
    process.env.RETENTION_EVENTS_DAYS = '0';
    process.env.RETENTION_AUDIT_DAYS = 'abc';
    expect(retentionConfig().eventsDays).toBe(90);
    expect(retentionConfig().auditDays).toBe(365);
  });

  it('also drops expired revoked tokens', () => {
    db.prepare('INSERT INTO revoked_tokens (jti, expires_at) VALUES (?, ?)').run('gone', Date.now() - 1000);
    db.prepare('INSERT INTO revoked_tokens (jti, expires_at) VALUES (?, ?)').run('kept', Date.now() + 60_000);
    runRetention(db);
    expect(ids('SELECT jti AS id FROM revoked_tokens')).toEqual(['kept']);
  });

  describe('scheduling', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('runs retention hourly, sweeps frequently, and stops on request', () => {
      seed();
      const task = startMaintenance({ db });
      expect(db.prepare("SELECT COUNT(*) AS c FROM device_events WHERE event_type = 'battery-low'").get()).toEqual({ c: 2 }); // not at once
      jest.advanceTimersByTime(60 * 60 * 1000 + 1000);
      expect(db.prepare("SELECT COUNT(*) AS c FROM device_events WHERE event_type = 'battery-low'").get()).toEqual({ c: 1 });
      task.stop();
      db.prepare("INSERT INTO device_events (device_id, event_type, severity, created_at) VALUES ('d1','battery-low','warning',?)").run(Date.now() - 100 * DAY);
      jest.advanceTimersByTime(2 * 60 * 60 * 1000);
      expect(db.prepare("SELECT COUNT(*) AS c FROM device_events WHERE event_type = 'battery-low'").get()).toEqual({ c: 2 });
    });

    it('timers do not keep the process alive', () => {
      const task = startMaintenance({ db });
      expect(task.timers.every(t => (t as any).hasRef() === false)).toBe(true);
      task.stop();
    });

    it('a failing job is logged and does not stop the schedule', () => {
      const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const task = startMaintenance({ db: { prepare() { throw new Error('boom'); }, transaction() { throw new Error('boom'); } } as any });
      expect(() => jest.advanceTimersByTime(2 * 60 * 60 * 1000)).not.toThrow();
      expect(err).toHaveBeenCalled();
      task.stop();
      err.mockRestore();
    });
  });
});

describe('SR-15 follow-up: device-offline events', () => {
  const SEEN_OLD = () => Date.now() - 10 * 60_000;
  const offlineEvents = (id: string) => eventStore.getDeviceEvents(id).filter(e => e.eventType === 'device-offline');
  const onlineEvents = (id: string) => eventStore.getDeviceEvents(id).filter(e => e.eventType === 'device-online');
  function online(id: string, lastSeen: number): void {
    deviceStore.enrollDevice({ id, name: id, model: 'm' });
    db.prepare("UPDATE devices SET status = 'online', last_seen_at = ? WHERE id = ?").run(lastSeen, id);
  }

  it('emits one warning event when a device stops reporting, and marks it offline', () => {
    online('d1', SEEN_OLD());
    expect(sweepOfflineDevices(db)).toBe(1);
    const ev = offlineEvents('d1');
    expect(ev).toHaveLength(1);
    expect(ev[0].severity).toBe('warning');
    expect(ev[0].data).toMatchObject({ deviceName: 'd1' });
    expect((db.prepare('SELECT status FROM devices WHERE id = ?').get('d1') as any).status).toBe('offline');
    expect(sweepOfflineDevices(db)).toBe(0);
    expect(offlineEvents('d1')).toHaveLength(1);
  });

  it('keeps last_seen_at and ignores devices seen recently or never seen', () => {
    online('fresh', Date.now() - 10_000);
    deviceStore.enrollDevice({ id: 'never', name: 'never', model: 'm' });
    online('old', SEEN_OLD());
    const before = (db.prepare('SELECT last_seen_at FROM devices WHERE id = ?').get('old') as any).last_seen_at;
    sweepOfflineDevices(db);
    expect(offlineEvents('fresh')).toHaveLength(0);
    expect(offlineEvents('never')).toHaveLength(0);
    expect((db.prepare('SELECT last_seen_at FROM devices WHERE id = ?').get('old') as any).last_seen_at).toBe(before);
  });

  it('the offline threshold follows DEVICE_OFFLINE_AFTER_MS', () => {
    online('d1', Date.now() - 60_000);
    expect(sweepOfflineDevices(db)).toBe(0);
    process.env.DEVICE_OFFLINE_AFTER_MS = '30000';
    try {
      expect(sweepOfflineDevices(db)).toBe(1);
    } finally {
      delete process.env.DEVICE_OFFLINE_AFTER_MS;
    }
  });

  it('a heartbeat after the sweep emits device-online exactly once', async () => {
    online('d1', SEEN_OLD());
    sweepOfflineDevices(db);
    const token = deviceTokenFor('d1');
    await request(app).post('/api/devices/d1/heartbeat').set('X-Session-Token', token).send({});
    await request(app).post('/api/devices/d1/heartbeat').set('X-Session-Token', token).send({});
    expect(onlineEvents('d1')).toHaveLength(1);
  });

  it('a command poll or a telemetry report also brings the device back online with one event', async () => {
    online('p1', SEEN_OLD());
    online('t1', SEEN_OLD());
    sweepOfflineDevices(db);
    await request(app).get('/api/devices/p1/commands/pending').set('X-Session-Token', deviceTokenFor('p1'));
    await request(app).post('/api/devices/t1/telemetry').set('X-Session-Token', deviceTokenFor('t1')).send({ batteryLevel: 50 });
    expect(onlineEvents('p1')).toHaveLength(1);
    expect(onlineEvents('t1')).toHaveLength(1);
  });
});

describe('SR-13: graceful shutdown and process error handlers', () => {
  function fakeServer(order: string[]) {
    return {
      close: jest.fn((cb?: (e?: Error) => void) => { order.push('server.close'); cb?.(); }),
      closeIdleConnections: jest.fn(() => order.push('closeIdle')),
      closeAllConnections: jest.fn(() => order.push('closeAll')),
    };
  }

  it('stops accepting, closes WebSockets and background jobs, then the database, then exits 0', async () => {
    const order: string[] = [];
    const exit = jest.fn((c: number) => order.push(`exit:${c}`));
    const shutdown = createShutdown({
      server: fakeServer(order) as any,
      stopJobs: () => order.push('stopJobs'),
      closeWebSockets: () => order.push('closeWs'),
      closeDatabase: () => order.push('closeDb'),
      exit,
      log: () => undefined,
    });
    await shutdown('SIGTERM', 0);
    expect(order[0]).toBe('stopJobs');
    expect(order.indexOf('server.close')).toBeLessThan(order.indexOf('closeDb'));
    expect(order.indexOf('closeWs')).toBeLessThan(order.indexOf('closeDb'));
    expect(order.slice(-2)).toEqual(['closeDb', 'exit:0']);
  });

  it('runs once even when several signals arrive', async () => {
    const order: string[] = [];
    const exit = jest.fn();
    const shutdown = createShutdown({
      server: fakeServer(order) as any, stopJobs: () => order.push('stopJobs'), closeWebSockets: () => undefined,
      closeDatabase: () => order.push('closeDb'), exit, log: () => undefined,
    });
    await Promise.all([shutdown('SIGTERM', 0), shutdown('SIGINT', 0)]);
    expect(order.filter(o => o === 'closeDb')).toHaveLength(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('a step that throws does not prevent closing the database or exiting', async () => {
    const exit = jest.fn();
    const closeDatabase = jest.fn();
    const shutdown = createShutdown({
      server: { close: (cb: any) => cb(), closeIdleConnections() {}, closeAllConnections() {} } as any,
      stopJobs: () => { throw new Error('x'); }, closeWebSockets: () => { throw new Error('y'); },
      closeDatabase, exit, log: () => undefined,
    });
    await shutdown('SIGTERM', 0);
    expect(closeDatabase).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('force-exits non-zero when the server never finishes closing', async () => {
    jest.useFakeTimers();
    try {
      const exit = jest.fn();
      const shutdown = createShutdown({
        server: { close: () => undefined, closeIdleConnections() {}, closeAllConnections() {} } as any,
        stopJobs() {}, closeWebSockets() {}, closeDatabase() {}, exit, log: () => undefined, timeoutMs: 10_000,
      });
      void shutdown('SIGTERM', 0);
      await jest.advanceTimersByTimeAsync(10_500);
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('really closes a listening server with an open keep-alive connection', async () => {
    const server = http.createServer((_q, r) => r.end('ok'));
    await new Promise<void>(res => server.listen(0, res));
    const port = (server.address() as any).port;
    const agent = new http.Agent({ keepAlive: true });
    await new Promise<void>(res => http.get({ port, agent }, r => { r.resume(); r.on('end', res); }));
    const exit = jest.fn();
    const shutdown = createShutdown({
      server, stopJobs() {}, closeWebSockets() {}, closeDatabase() {}, exit, log: () => undefined, timeoutMs: 5000,
    });
    await shutdown('SIGTERM', 0);
    expect(exit).toHaveBeenCalledWith(0);
    expect(server.listening).toBe(false);
    agent.destroy();
  });

  it('SIGTERM and SIGINT shut down with 0; unhandledRejection and uncaughtException log and exit non-zero', async () => {
    const proc = new EventEmitter() as any;
    const shutdown = jest.fn(async () => undefined);
    const log = jest.fn();
    installProcessHandlers(proc, shutdown, log);
    proc.emit('SIGTERM');
    proc.emit('SIGINT');
    expect(shutdown).toHaveBeenNthCalledWith(1, 'SIGTERM', 0);
    expect(shutdown).toHaveBeenNthCalledWith(2, 'SIGINT', 0);
    proc.emit('unhandledRejection', new Error('rejected'));
    proc.emit('uncaughtException', new Error('thrown'));
    expect(shutdown).toHaveBeenNthCalledWith(3, 'unhandledRejection', 1);
    expect(shutdown).toHaveBeenNthCalledWith(4, 'uncaughtException', 1);
    expect(log.mock.calls.map(c => String(c[0]) + String(c[1] ?? '')).join('\n')).toMatch(/rejected[\s\S]*thrown/);
  });

  it('a non-Error rejection reason is logged without throwing', () => {
    const proc = new EventEmitter() as any;
    installProcessHandlers(proc, jest.fn(async () => undefined), jest.fn());
    expect(() => proc.emit('unhandledRejection', 'just a string')).not.toThrow();
  });
});
