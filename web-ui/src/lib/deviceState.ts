import type { DeviceCommand, CommandType, DeviceTelemetry } from '../types/api';

/** Newest command of a type, optionally ignoring commands that never took effect. */
export function latestCommand(commands: DeviceCommand[], type: CommandType, opts: { skipDead?: boolean } = {}): DeviceCommand | null {
  const list = commands
    .filter((c) => c.type === type && !(opts.skipDead && (c.status === 'failed' || c.status === 'expired')))
    .sort((a, b) => b.createdAt - a.createdAt);
  return list[0] ?? null;
}

export function protectedPackages(commands: DeviceCommand[]): string[] {
  const c = latestCommand(commands, 'SET_PROTECTED_PACKAGES', { skipDead: true });
  const pk = c?.payload?.packages;
  return Array.isArray(pk) ? pk.filter((p): p is string => typeof p === 'string') : [];
}

/**
 * Protected packages as the device itself reports them (telemetry `protectedPackages`).
 * Falls back to the newest live SET_PROTECTED_PACKAGES command when telemetry lacks the field.
 * A live command issued after the last telemetry report is newer than what the device has
 * told us, so it wins until the device reports again (otherwise a fresh Protect click would
 * look ignored).
 */
export function effectiveProtectedPackages(
  telemetry: Pick<DeviceTelemetry, 'protectedPackages' | 'updatedAt'> | null | undefined,
  commands: DeviceCommand[]
): string[] {
  const fromCommand = protectedPackages(commands);
  const reported = telemetry?.protectedPackages;
  if (!Array.isArray(reported)) return fromCommand;
  const latest = latestCommand(commands, 'SET_PROTECTED_PACKAGES', { skipDead: true });
  if (latest && latest.createdAt > (telemetry?.updatedAt ?? 0)) return fromCommand;
  return reported.filter((p): p is string => typeof p === 'string');
}

export type ApplyState = 'none' | 'pending' | 'applied' | 'failed';

export function applyState(c: DeviceCommand | null): ApplyState {
  if (!c) return 'none';
  if (c.status === 'completed') return 'applied';
  if (c.status === 'failed' || c.status === 'expired') return 'failed';
  return 'pending';
}
