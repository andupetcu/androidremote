import type Database from 'better-sqlite3';
import { deviceStore } from './deviceStore';
import { eventStore } from './eventStore';

/**
 * A device talked to the server (heartbeat, poll, telemetry). Raises one device-online event when it
 * had counted as offline. Returns false for an unknown device.
 */
export function noteDeviceSeen(deviceId: string): boolean {
  const seen = deviceStore.markSeen(deviceId);
  if (!seen.found) return false;
  if (seen.wasOffline) {
    const device = deviceStore.getDevice(deviceId);
    eventStore.recordEvent({
      deviceId,
      eventType: 'device-online',
      severity: 'info',
      data: { deviceName: device?.name, model: device?.model },
    });
  }
  return true;
}

/**
 * Raise a device-offline event once for every device that stopped reporting (SR-15). Returns how many.
 * `db` is only used to scope the stores in tests; production passes nothing.
 */
export function sweepOfflineDevices(_db?: Database.Database): number {
  let count = 0;
  for (const d of deviceStore.findNewlyOffline()) {
    eventStore.recordEvent({
      deviceId: d.id,
      eventType: 'device-offline',
      severity: 'warning',
      data: { deviceName: d.name, model: d.model, lastSeenAt: d.lastSeenAt },
    });
    deviceStore.markOfflineNotified(d.id);
    count++;
  }
  return count;
}
