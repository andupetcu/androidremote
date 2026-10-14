import { useState, useEffect, useCallback } from 'react';
import type { DeviceTelemetry } from '../types/api';
import { normalizeHistory, type HistoryPoint } from '../lib/telemetrySeries';
import { API_BASE, apiFetch } from '../utils/api';
import { fetchJsonShared } from '../lib/polling';
import { usePolling } from './usePolling';

/** Telemetry as the server returns it (field names differ from DeviceTelemetry). */
interface TelemetryApiResponse {
  deviceId: string;
  batteryLevel: number | null;
  batteryCharging: boolean | null;
  batteryHealth: string | null;
  networkType: string | null;
  signalStrength: number | null;
  networkSsid: string | null;
  ipAddress: string | null;
  storageTotalBytes: number | null;
  storageUsedBytes: number | null;
  memoryTotalBytes: number | null;
  memoryUsedBytes: number | null;
  latitude: number | null;
  longitude: number | null;
  locationAccuracy: number | null;
  kioskActive?: boolean | null;
  kioskPackage?: string | null;
  lockTask?: boolean | null;
  protectedPackages?: unknown;
  rooted?: boolean | null;
  updatedAt?: number | null;
}

interface UseTelemetryResult {
  telemetry: DeviceTelemetry | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useTelemetry(deviceId: string): UseTelemetryResult {
  const [telemetry, setTelemetry] = useState<DeviceTelemetry | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchOnce = useCallback(async (): Promise<boolean> => {
    try {
      setError(null);
      const res = await fetchJsonShared<TelemetryApiResponse>(`${API_BASE}/api/devices/${deviceId}/telemetry`);
      if (!res.ok || !res.data) throw new Error('Failed to fetch telemetry');
      const data = res.data;

      // Transform API field names to frontend interface names
      // API returns: storageTotalBytes, storageUsedBytes, networkSsid, etc.
      // Frontend expects: storageTotal, storageUsed, wifiSsid, etc.
      const transformed: DeviceTelemetry = {
        deviceId: data.deviceId,
        batteryLevel: data.batteryLevel,
        batteryCharging: data.batteryCharging,
        batteryHealth: data.batteryHealth,
        networkType: data.networkType,
        networkStrength: data.signalStrength,
        wifiSsid: data.networkSsid,
        ipAddress: data.ipAddress,
        storageTotal: data.storageTotalBytes,
        storageUsed: data.storageUsedBytes,
        memoryTotal: data.memoryTotalBytes,
        memoryUsed: data.memoryUsedBytes,
        latitude: data.latitude,
        longitude: data.longitude,
        locationAccuracy: data.locationAccuracy,
        locationUpdatedAt: null, // Not provided by API
        kioskActive: data.kioskActive ?? null,
        kioskPackage: data.kioskPackage ?? null,
        lockTask: data.lockTask ?? null,
        protectedPackages: Array.isArray(data.protectedPackages) ? data.protectedPackages : null,
        rooted: typeof data.rooted === 'boolean' ? data.rooted : null,
        updatedAt: data.updatedAt ?? Date.now(),
      };

      // Only set telemetry if we have meaningful data (not just empty shell)
      if (transformed.batteryLevel !== null || transformed.storageTotal !== null) {
        setTelemetry(transformed);
      } else {
        setTelemetry(null);
      }
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
    void fetchOnce();
  }, [fetchOnce]);

  usePolling(fetchOnce, 30000);

  return { telemetry, loading, error, refresh };
}

interface UseTelemetryHistoryResult {
  points: HistoryPoint[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

/**
 * Bounded, server-downsampled telemetry history for one device (WU-19).
 * `window` must be stable between renders (memoize it); pass enabled=false to stay idle (lazy).
 */
export function useTelemetryHistory(
  deviceId: string,
  window: { from: number; to: number; bucket?: string; limit?: number },
  enabled = true
): UseTelemetryHistoryResult {
  const [points, setPoints] = useState<HistoryPoint[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const { from, to, bucket, limit } = window;

  const refresh = useCallback(async () => {
    if (!enabled) return;
    try {
      setError(null);
      const params = new URLSearchParams({ from: String(from), to: String(to) });
      if (bucket) params.set('bucket', bucket);
      if (limit) params.set('limit', String(limit));
      const res = await apiFetch(`${API_BASE}/api/devices/${deviceId}/telemetry/history?${params}`);
      if (!res.ok) throw new Error('Failed to fetch telemetry history');
      setPoints(normalizeHistory(await res.json()));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [deviceId, from, to, bucket, limit, enabled]);

  useEffect(() => {
    setLoading(enabled);
    void refresh();
  }, [refresh, enabled]);

  return { points, loading, error, refresh };
}

interface UseAllTelemetryResult {
  telemetry: DeviceTelemetry[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useAllTelemetry(): UseAllTelemetryResult {
  const [telemetry, setTelemetry] = useState<DeviceTelemetry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchOnce = useCallback(async (): Promise<boolean> => {
    try {
      setError(null);
      const res = await fetchJsonShared<{ telemetry: DeviceTelemetry[] }>(`${API_BASE}/api/telemetry`);
      if (!res.ok || !res.data) throw new Error('Failed to fetch telemetry');
      setTelemetry(res.data.telemetry);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    await fetchOnce();
  }, [fetchOnce]);

  useEffect(() => {
    void fetchOnce();
  }, [fetchOnce]);

  usePolling(fetchOnce, 30000);

  return { telemetry, loading, error, refresh };
}
