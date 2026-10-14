import type { DeviceCommand, CommandType } from '../types/api';

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

export type ApplyState = 'none' | 'pending' | 'applied' | 'failed';

export function applyState(c: DeviceCommand | null): ApplyState {
  if (!c) return 'none';
  if (c.status === 'completed') return 'applied';
  if (c.status === 'failed' || c.status === 'expired') return 'failed';
  return 'pending';
}
