import { useState, useEffect, useCallback } from 'react';
import type { DeviceTelemetry, TelemetryHistory } from '../types/api';
import { API_BASE, apiFetch } from '../utils/api';

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

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const res = await apiFetch(`${API_BASE}/api/devices/${deviceId}/telemetry`);
      if (!res.ok) throw new Error('Failed to fetch telemetry');
      const data = await res.json();

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
        updatedAt: data.updatedAt ?? Date.now(),
      };

      // Only set telemetry if we have meaningful data (not just empty shell)
      if (transformed.batteryLevel !== null || transformed.storageTotal !== null) {
        setTelemetry(transformed);
      } else {
        setTelemetry(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 30000); // Poll every 30 seconds
    return () => clearInterval(interval);
  }, [refresh]);

  return { telemetry, loading, error, refresh };
}

interface UseTelemetryHistoryResult {
  history: TelemetryHistory[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useTelemetryHistory(
  deviceId: string,
  from?: number,
  to?: number
): UseTelemetryHistoryResult {
  const [history, setHistory] = useState<TelemetryHistory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const params = new URLSearchParams();
      if (from) params.set('from', from.toString());
      if (to) params.set('to', to.toString());
      const url = `${API_BASE}/api/devices/${deviceId}/telemetry/history?${params}`;
      const res = await apiFetch(url);
      if (!res.ok) throw new Error('Failed to fetch telemetry history');
      const data = await res.json();
      setHistory(data.history);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [deviceId, from, to]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { history, loading, error, refresh };
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

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const res = await apiFetch(`${API_BASE}/api/telemetry`);
      if (!res.ok) throw new Error('Failed to fetch telemetry');
      const data = await res.json();
      setTelemetry(data.telemetry);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 30000);
    return () => clearInterval(interval);
  }, [refresh]);

  return { telemetry, loading, error, refresh };
}
