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

export interface DevicePageQuery {
  limit: number;
  offset: number;
  search?: string;
}

interface UseDevicePageResult {
  devices: Device[];
  /** Total matching devices (server total, or the filtered list length in the client fallback). */
  total: number;
  /** Fleet-wide counts when the server sends `summary`; otherwise counted over what was loaded. */
  online: number;
  offline: number;
  summaryIsPageOnly: boolean;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  unenrollDevice: (id: string) => Promise<boolean>;
  /** Every device id, paging through the server if needed (for fleet-wide actions). */
  listAllIds: () => Promise<string[]>;
}

interface DeviceListResponse {
  devices: Device[];
  total?: number;
  summary?: { online?: number; offline?: number };
}

function matches(d: Device, q: string): boolean {
  const needle = q.toLowerCase();
  return [d.name, d.model, d.id, d.hostname].some((v) => typeof v === 'string' && v.toLowerCase().includes(needle));
}

/**
 * One page of devices (WU-17). Sends limit/offset/search to the server. While the server still
 * returns the whole list without a `total` the hook pages and filters on the client instead, so
 * the UI works against both.
 */
export function useDevicePage({ limit, offset, search }: DevicePageQuery): UseDevicePageResult {
  const [data, setData] = useState<DeviceListResponse>({ devices: [] });
  const [serverPaged, setServerPaged] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const q = (search ?? '').trim();
  const url = (() => {
    const p = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (q) p.set('search', q);
    return `${API_BASE}/api/devices?${p}`;
  })();

  const fetchPage = useCallback(async (): Promise<boolean> => {
    try {
      setError(null);
      const res = await fetchJsonShared<DeviceListResponse>(url);
      if (!res.ok || !res.data) throw new Error('Failed to fetch devices');
      setData(res.data);
      setServerPaged(typeof res.data.total === 'number');
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      return false;
    } finally {
      setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    void fetchPage();
  }, [fetchPage]);

  usePolling(fetchPage, 10000);

  const refresh = useCallback(async () => {
    await fetchPage();
  }, [fetchPage]);

  const unenrollDevice = useCallback(async (id: string): Promise<boolean> => {
    try {
      const response = await apiFetch(`${API_BASE}/api/devices/${id}`, { method: 'DELETE' });
      if (!response.ok) throw new Error('Failed to unenroll device');
      await fetchPage();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      return false;
    }
  }, [fetchPage]);

  const listAllIds = useCallback(async (): Promise<string[]> => {
    const ids: string[] = [];
    const pageSize = 500;
    for (let off = 0; off < 100_000; off += pageSize) {
      const res = await fetchJsonShared<DeviceListResponse>(`${API_BASE}/api/devices?limit=${pageSize}&offset=${off}`);
      if (!res.ok || !res.data) throw new Error('Failed to list devices');
      ids.push(...res.data.devices.map((d) => d.id));
      if (typeof res.data.total !== 'number') break; // server returned everything at once
      if (off + pageSize >= res.data.total) break;
    }
    return ids;
  }, []);

  const filtered = serverPaged || !q ? data.devices : data.devices.filter((d) => matches(d, q));
  const devices = serverPaged ? filtered : filtered.slice(offset, offset + limit);
  const total = serverPaged ? (data.total as number) : filtered.length;
  const summary = serverPaged ? data.summary : undefined;
  const pageOnly = serverPaged && !summary;
  const source = serverPaged ? devices : filtered;

  return {
    devices,
    total,
    online: summary?.online ?? source.filter((d) => d.status === 'online').length,
    offline: summary?.offline ?? source.filter((d) => d.status === 'offline').length,
    summaryIsPageOnly: pageOnly,
    loading,
    error,
    refresh,
    unenrollDevice,
    listAllIds,
  };
}
