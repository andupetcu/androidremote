import { useState, useEffect, useCallback, useRef } from 'react';
import type { DeviceCommand, CommandType, CommandStatus } from '../types/api';
import { API_BASE, apiFetch } from '../utils/api';
import { acquireAdminSocket, addAdminHandler, onAdminStatus, isAdminConnected } from '../lib/adminSocket';
import { debounce } from '../lib/polling';
import { usePolling } from './usePolling';

/** Pull the server's error text out of a failed response. */
export async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const data = await res.json();
    if (data && typeof data.error === 'string') return data.error;
  } catch {
    // not JSON
  }
  return `${fallback} (${res.status})`;
}

interface CommandPayload {
  [key: string]: unknown;
}

interface UseCommandsResult {
  commands: DeviceCommand[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  sendCommand: (deviceId: string, type: CommandType, payload?: CommandPayload) => Promise<DeviceCommand>;
  cancelCommand: (commandId: string) => Promise<void>;
}

export function useCommands(deviceId?: string, status?: CommandStatus): UseCommandsResult {
  const [commands, setCommands] = useState<DeviceCommand[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const params = new URLSearchParams();
      if (deviceId) params.set('deviceId', deviceId);
      if (status) params.set('status', status);

      const url = `${API_BASE}/api/commands?${params}`;
      const res = await apiFetch(url);
      if (!res.ok) throw new Error('Failed to fetch commands');
      const data = await res.json();
      setCommands(data.commands);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [deviceId, status]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const sendCommand = async (
    targetDeviceId: string,
    type: CommandType,
    payload: CommandPayload = {}
  ): Promise<DeviceCommand> => {
    const res = await apiFetch(`${API_BASE}/api/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: targetDeviceId, type, payload }),
    });
    if (!res.ok) throw new Error(await errorMessage(res, 'Failed to send command'));
    const data = await res.json();
    await refresh();
    return data.command;
  };

  const cancelCommand = async (commandId: string): Promise<void> => {
    const res = await apiFetch(`${API_BASE}/api/commands/${commandId}/cancel`, {
      method: 'POST',
    });
    if (!res.ok) throw new Error('Failed to cancel command');
    await refresh();
  };

  return { commands, loading, error, refresh, sendCommand, cancelCommand };
}

interface UseDeviceCommandsResult {
  commands: DeviceCommand[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  sendCommand: (type: CommandType, payload?: CommandPayload) => Promise<DeviceCommand>;
}

export function useDeviceCommands(deviceId: string): UseDeviceCommandsResult {
  const [commands, setCommands] = useState<DeviceCommand[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchOnce = useCallback(async (): Promise<boolean> => {
    try {
      setError(null);
      const res = await apiFetch(`${API_BASE}/api/devices/${deviceId}/commands`);
      if (!res.ok) throw new Error('Failed to fetch device commands');
      const data = await res.json();
      setCommands(data.commands);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      return false;
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  const refresh = useCallback(async () => {
    await fetchOnce();
  }, [fetchOnce]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Command state arrives over the shared admin socket (WU-16). The slow poll below is only
  // a safety net: it runs while a command is in flight, every 30 s when the socket is
  // connected (10 s when it is not), pauses while the tab is hidden and backs off on failure.
  const [socketUp, setSocketUp] = useState(isAdminConnected());
  const hasInFlight = commands.some((cmd) => ['pending', 'delivered', 'executing'].includes(cmd.status));

  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    const release = acquireAdminSocket();
    const offStatus = onAdminStatus(setSocketUp);
    const debounced = debounce(() => void refreshRef.current(), 500);
    const offCommand = addAdminHandler('command-update', (msg) => {
      const cmd = msg.command;
      if (!cmd || cmd.deviceId !== deviceId) return;
      setCommands((prev) =>
        prev.some((c) => c.id === cmd.id) ? prev.map((c) => (c.id === cmd.id ? { ...c, ...cmd } : c)) : [cmd, ...prev]
      );
    });
    const offEvent = addAdminHandler('device-event', (msg) => {
      const ev = msg.event;
      if (!ev || ev.deviceId !== deviceId) return;
      if (ev.eventType === 'command-completed' || ev.eventType === 'command-failed') debounced();
    });
    return () => {
      debounced.cancel();
      offCommand();
      offEvent();
      offStatus();
      release();
    };
  }, [deviceId]);

  usePolling(fetchOnce, socketUp ? 30000 : 10000, hasInFlight);

  const sendCommand = async (
    type: CommandType,
    payload: CommandPayload = {}
  ): Promise<DeviceCommand> => {
    const res = await apiFetch(`${API_BASE}/api/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId, type, payload }),
    });
    if (!res.ok) throw new Error(await errorMessage(res, 'Failed to send command'));
    const data = await res.json();
    await refresh();
    return data.command;
  };

  return { commands, loading, error, refresh, sendCommand };
}

// Helper functions for common commands
export const CommandHelpers = {
  lock: (sendCommand: UseDeviceCommandsResult['sendCommand']) =>
    sendCommand('LOCK'),

  unlock: (sendCommand: UseDeviceCommandsResult['sendCommand']) =>
    sendCommand('UNLOCK'),

  reboot: (sendCommand: UseDeviceCommandsResult['sendCommand']) =>
    sendCommand('REBOOT'),

  // The device refuses WIPE unless confirm equals its own id (contract C10).
  wipe: (sendCommand: UseDeviceCommandsResult['sendCommand'], deviceId: string, preserveFactoryReset = false) =>
    sendCommand('WIPE', { confirm: deviceId, preserveFactoryReset }),

  installApk: (sendCommand: UseDeviceCommandsResult['sendCommand'], url: string) =>
    sendCommand('INSTALL_APK', { url }),

  uninstallApp: (sendCommand: UseDeviceCommandsResult['sendCommand'], packageName: string) =>
    sendCommand('UNINSTALL_APP', { packageName }),

  setKiosk: (sendCommand: UseDeviceCommandsResult['sendCommand'], packageName: string, enabled: boolean, lockTask: boolean) =>
    sendCommand('SET_KIOSK', { packageName, enabled, lockTask }),

  disableApp: (sendCommand: UseDeviceCommandsResult['sendCommand'], packageName: string) =>
    sendCommand('DISABLE_APP', { packageName }),

  enableApp: (sendCommand: UseDeviceCommandsResult['sendCommand'], packageName: string) =>
    sendCommand('ENABLE_APP', { packageName }),

  grantPermission: (
    sendCommand: UseDeviceCommandsResult['sendCommand'],
    packageName: string,
    permission: string,
    state: 'granted' | 'denied' | 'default'
  ) => sendCommand('GRANT_PERMISSION', { packageName, permission, state }),

  // The device refuses UNINSTALL/DISABLE for these packages and for itself (C10).
  setProtectedPackages: (sendCommand: UseDeviceCommandsResult['sendCommand'], packages: string[]) =>
    sendCommand('SET_PROTECTED_PACKAGES', { packages }),

  launchApp: (sendCommand: UseDeviceCommandsResult['sendCommand'], packageName: string) =>
    sendCommand('LAUNCH_APP', { packageName }),

  setVolume: (sendCommand: UseDeviceCommandsResult['sendCommand'], level: number, stream: string = 'music') =>
    sendCommand('SET_VOLUME', { level, stream }),

  setBrightness: (sendCommand: UseDeviceCommandsResult['sendCommand'], level: number) =>
    sendCommand('SET_BRIGHTNESS', { level }),

  takeScreenshot: (sendCommand: UseDeviceCommandsResult['sendCommand']) =>
    sendCommand('TAKE_SCREENSHOT'),

  sendMessage: (sendCommand: UseDeviceCommandsResult['sendCommand'], title: string, message: string) =>
    sendCommand('SEND_MESSAGE', { title, message }),

  playSound: (sendCommand: UseDeviceCommandsResult['sendCommand']) =>
    sendCommand('PLAY_SOUND'),

  syncPolicy: (sendCommand: UseDeviceCommandsResult['sendCommand']) =>
    sendCommand('SYNC_POLICY'),

  refreshTelemetry: (sendCommand: UseDeviceCommandsResult['sendCommand']) =>
    sendCommand('REFRESH_TELEMETRY'),

  getLocation: (sendCommand: UseDeviceCommandsResult['sendCommand']) =>
    sendCommand('GET_LOCATION'),
};
