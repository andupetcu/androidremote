import { useState, useEffect, useCallback } from 'react';
import { API_BASE, apiFetch } from '../utils/api';
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

  const fetchDevices = useCallback(async (isInitial = false) => {
    try {
      // Only show loading spinner on initial fetch, not on polls
      if (isInitial) {
        setLoading(true);
      }
      setError(null);

      const response = await apiFetch(`${API_BASE}/api/devices`);
      if (!response.ok) {
        throw new Error('Failed to fetch devices');
      }

      const data = await response.json();
      setDevices(data.devices);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
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
    fetchDevices(true); // Initial fetch shows loading

    // Poll for updates every 10 seconds (without showing loading spinner)
    const interval = setInterval(() => fetchDevices(false), 10000);
    return () => clearInterval(interval);
  }, [fetchDevices]);

  return {
    devices,
    loading,
    error,
    refresh: fetchDevices,
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

  const fetchDevice = useCallback(async (isInitial = false) => {
    if (!deviceId) {
      setDevice(null);
      setLoading(false);
      return;
    }

    try {
      // Only show loading spinner on initial fetch, not on polls
      if (isInitial) {
        setLoading(true);
      }
      setError(null);

      const response = await apiFetch(`${API_BASE}/api/devices/${deviceId}`);
      if (!response.ok) {
        if (response.status === 404) {
          throw new Error('Device not found');
        }
        throw new Error('Failed to fetch device');
      }

      const data = await response.json();
      setDevice(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      setDevice(null);
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    fetchDevice(true); // Initial fetch shows loading

    // Poll for updates every 5 seconds (without showing loading spinner)
    const interval = setInterval(() => fetchDevice(false), 5000);
    return () => clearInterval(interval);
  }, [fetchDevice]);

  return {
    device,
    loading,
    error,
    refresh: fetchDevice,
  };
}
