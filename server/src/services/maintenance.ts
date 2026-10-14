import type Database from 'better-sqlite3';
import {
  purgeTelemetryHistory, purgeOldEvents, purgeOldAuditLogs, purgeFinishedCommands,
  purgeExpiredRevokedTokens, purgeExpiredDeviceSessions, purgeOldFileTransfers,
} from '../db/schema';
import { commandStore } from './commandStore';
import { eventStore } from './eventStore';
import { auditStore } from './auditStore';
import { sweepOfflineDevices } from './devicePresence';

export { sweepOfflineDevices };

export interface RetentionConfig {
  telemetryDays: number;
  eventsDays: number;
  auditDays: number;
  commandsDays: number;
}

function days(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 1 ? v : fallback;
}

/** Retention windows in days, from env: RETENTION_TELEMETRY_DAYS (30), RETENTION_EVENTS_DAYS (90), RETENTION_AUDIT_DAYS (365), RETENTION_COMMANDS_DAYS (30). */
export function retentionConfig(): RetentionConfig {
  return {
    telemetryDays: days('RETENTION_TELEMETRY_DAYS', 30),
    eventsDays: days('RETENTION_EVENTS_DAYS', 90),
    auditDays: days('RETENTION_AUDIT_DAYS', 365),
    commandsDays: days('RETENTION_COMMANDS_DAYS', 30),
  };
}

export interface RetentionResult {
  telemetryHistory: number;
  events: number;
  audit: number;
  commands: number;
  revokedTokens: number;
  deviceSessions: number;
  fileTransfers: number;
}

/** Delete data past its retention window (SR-08). Only finished commands are removed. */
export function runRetention(db: Database.Database): RetentionResult {
  const cfg = retentionConfig();
  return {
    telemetryHistory: purgeTelemetryHistory(db, cfg.telemetryDays),
    events: purgeOldEvents(db, cfg.eventsDays),
    audit: purgeOldAuditLogs(db, cfg.auditDays),
    commands: purgeFinishedCommands(db, cfg.commandsDays),
    revokedTokens: purgeExpiredRevokedTokens(db),
    deviceSessions: purgeExpiredDeviceSessions(db),
    fileTransfers: purgeOldFileTransfers(db),
  };
}

/** Fail commands stuck in `executing`, with a command-failed event and an audit entry each. */
export function sweepStuckCommands(): number {
  const stuck = commandStore.expireStuckExecuting();
  for (const cmd of stuck) {
    try {
      eventStore.recordEvent({
        deviceId: cmd.deviceId,
        eventType: 'command-failed',
        severity: 'warning',
        data: { commandType: cmd.type, commandId: cmd.id, error: cmd.error },
      });
      auditStore.log({
        actorType: 'system',
        action: 'command.timed_out',
        resourceType: 'command',
        resourceId: cmd.id,
        details: { deviceId: cmd.deviceId, type: cmd.type },
      });
    } catch (err) {
      console.error('[maintenance] failed to record command timeout:', err);
    }
  }
  return stuck.length;
}

export interface MaintenanceOptions {
  db: Database.Database;
  retentionIntervalMs?: number;
  sweepIntervalMs?: number;
}

export interface MaintenanceHandle {
  timers: NodeJS.Timeout[];
  stop(): void;
}

function guarded(name: string, fn: () => void): () => void {
  return () => {
    try {
      fn();
    } catch (err) {
      console.error(`[maintenance] ${name} failed:`, err);
    }
  };
}

/**
 * Background jobs: retention purge hourly; offline detection, command expiry and stuck-command timeout
 * every 30 s. The timers are unref'd so they never keep the process alive.
 */
export function startMaintenance(opts: MaintenanceOptions): MaintenanceHandle {
  const retention = setInterval(
    guarded('retention', () => {
      const r = runRetention(opts.db);
      const total = Object.values(r).reduce((a, b) => a + b, 0);
      if (total > 0) console.log('[maintenance] retention removed', JSON.stringify(r));
    }),
    opts.retentionIntervalMs ?? 60 * 60 * 1000
  );
  const sweep = setInterval(
    guarded('sweep', () => {
      commandStore.expireStale();
      sweepStuckCommands();
      sweepOfflineDevices(opts.db);
    }),
    opts.sweepIntervalMs ?? 30 * 1000
  );
  retention.unref();
  sweep.unref();
  const timers = [retention, sweep];
  return { timers, stop: () => timers.forEach(t => clearInterval(t)) };
}
