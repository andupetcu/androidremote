import { useState, useEffect, useCallback } from 'react';
import type { DeviceCommand, CommandType, CommandStatus } from '../types/api';
import { API_BASE, apiFetch } from '../utils/api';

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
    if (!res.ok) throw new Error('Failed to send command');
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

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const res = await apiFetch(`${API_BASE}/api/devices/${deviceId}/commands`);
      if (!res.ok) throw new Error('Failed to fetch device commands');
      const data = await res.json();
      setCommands(data.commands);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Auto-poll every 5s while any command is in a non-terminal state
  useEffect(() => {
    const NON_TERMINAL: Set<string> = new Set(['pending', 'delivered', 'executing']);
    const hasInFlight = commands.some((cmd) => NON_TERMINAL.has(cmd.status));
    if (!hasInFlight) return;

    const interval = setInterval(() => {
      refresh();
    }, 5000);
    return () => clearInterval(interval);
  }, [commands, refresh]);

  const sendCommand = async (
    type: CommandType,
    payload: CommandPayload = {}
  ): Promise<DeviceCommand> => {
    const res = await apiFetch(`${API_BASE}/api/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId, type, payload }),
    });
    if (!res.ok) throw new Error('Failed to send command');
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

  wipe: (sendCommand: UseDeviceCommandsResult['sendCommand'], preserveFactoryReset = false) =>
    sendCommand('WIPE', { preserveFactoryReset }),

  installApk: (sendCommand: UseDeviceCommandsResult['sendCommand'], url: string) =>
    sendCommand('INSTALL_APK', { url }),

  uninstallApp: (sendCommand: UseDeviceCommandsResult['sendCommand'], packageName: string) =>
    sendCommand('UNINSTALL_APP', { packageName }),

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
