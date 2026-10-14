import { useState, useEffect, useCallback } from 'react';
import { API_BASE, apiFetch } from '../utils/api';
import { fetchJsonShared } from '../lib/polling';
import { usePolling } from './usePolling';
import type { Device } from '../types/api';

export type { Device };

interface UseDevicesResult {
  devices: Device[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  unenrollDevice: (id: string) => Promise<boolean>;
}

/**
 * Hook for fetching and managing the device list
 */
export function useDevices(): UseDevicesResult {
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchDevices = useCallback(async (isInitial = false): Promise<boolean> => {
    try {
      // Only show loading spinner on initial fetch, not on polls
      if (isInitial) {
        setLoading(true);
      }
      setError(null);

      const response = await fetchJsonShared<{ devices: Device[] }>(`${API_BASE}/api/devices`);
      if (!response.ok || !response.data) {
        throw new Error('Failed to fetch devices');
      }

      setDevices(response.data.devices);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  const unenrollDevice = useCallback(async (id: string): Promise<boolean> => {
    try {
      const response = await apiFetch(`${API_BASE}/api/devices/${id}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        throw new Error('Failed to unenroll device');
      }

      // Refresh the device list
      await fetchDevices();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      return false;
    }
  }, [fetchDevices]);

  useEffect(() => {
    void fetchDevices(true); // Initial fetch shows loading
  }, [fetchDevices]);

  // Shared scheduler: pauses while hidden, backs off on failure (WU-16)
  usePolling(() => fetchDevices(false), 10000);

  const refresh = useCallback(async () => {
    await fetchDevices(false);
  }, [fetchDevices]);

  return {
    devices,
    loading,
    error,
    refresh,
    unenrollDevice,
  };
}

interface UseDeviceResult {
  device: Device | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

/**
 * Hook for fetching a single device by ID
 */
export function useDevice(deviceId: string | undefined): UseDeviceResult {
  const [device, setDevice] = useState<Device | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchDevice = useCallback(async (isInitial = false): Promise<boolean> => {
    if (!deviceId) {
      setDevice(null);
      setLoading(false);
      return true;
    }

    try {
      // Only show loading spinner on initial fetch, not on polls
      if (isInitial) {
        setLoading(true);
      }
      setError(null);

      const response = await fetchJsonShared<Device>(`${API_BASE}/api/devices/${deviceId}`);
      if (!response.ok || !response.data) {
        if (response.status === 404) {
          throw new Error('Device not found');
        }
        throw new Error('Failed to fetch device');
      }

      setDevice(response.data);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      setDevice(null);
      return false;
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    void fetchDevice(true); // Initial fetch shows loading
  }, [fetchDevice]);

  usePolling(() => fetchDevice(false), 5000, Boolean(deviceId));

  const refresh = useCallback(async () => {
    await fetchDevice(false);
  }, [fetchDevice]);

  return {
    device,
    loading,
    error,
    refresh,
  };
}
