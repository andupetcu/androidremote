import { useState, useEffect, useCallback } from 'react';
import type { DeviceEvent, EventSeverity, DeviceEventType } from '../types/api';
import { API_BASE, apiFetch } from '../utils/api';

interface EventFilters {
  deviceId?: string;
  eventType?: DeviceEventType;
  severity?: EventSeverity;
  acknowledged?: boolean;
  from?: number;
  to?: number;
}

interface UseEventsResult {
  events: DeviceEvent[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  acknowledge: (eventId: string) => Promise<void>;
  acknowledgeMultiple: (eventIds: string[]) => Promise<void>;
}

export function useEvents(filters?: EventFilters): UseEventsResult {
  const [events, setEvents] = useState<DeviceEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const params = new URLSearchParams();
      if (filters?.deviceId) params.set('deviceId', filters.deviceId);
      if (filters?.eventType) params.set('eventType', filters.eventType);
      if (filters?.severity) params.set('severity', filters.severity);
      if (filters?.acknowledged !== undefined) params.set('acknowledged', String(filters.acknowledged));
      if (filters?.from) params.set('from', filters.from.toString());
      if (filters?.to) params.set('to', filters.to.toString());

      const url = `${API_BASE}/api/events?${params}`;
      const res = await apiFetch(url);
      if (!res.ok) throw new Error('Failed to fetch events');
      const data = await res.json();
      setEvents(data.events);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [filters?.deviceId, filters?.eventType, filters?.severity, filters?.acknowledged, filters?.from, filters?.to]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const acknowledge = async (eventId: string): Promise<void> => {
    const res = await apiFetch(`${API_BASE}/api/events/${eventId}/acknowledge`, {
      method: 'POST',
    });
    if (!res.ok) throw new Error('Failed to acknowledge event');
    await refresh();
  };

  const acknowledgeMultiple = async (eventIds: string[]): Promise<void> => {
    await Promise.all(
      eventIds.map((id) =>
        apiFetch(`${API_BASE}/api/events/${id}/acknowledge`, { method: 'POST' })
      )
    );
    await refresh();
  };

  return { events, loading, error, refresh, acknowledge, acknowledgeMultiple };
}

interface UseDeviceEventsResult {
  events: DeviceEvent[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useDeviceEvents(deviceId: string): UseDeviceEventsResult {
  const [events, setEvents] = useState<DeviceEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const res = await apiFetch(`${API_BASE}/api/devices/${deviceId}/events`);
      if (!res.ok) throw new Error('Failed to fetch device events');
      const data = await res.json();
      setEvents(data.events);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { events, loading, error, refresh };
}

interface UseEventStatsResult {
  stats: {
    total: number;
    unacknowledged: number;
    bySeverity: Record<EventSeverity, number>;
    byType: Record<string, number>;
  } | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useEventStats(): UseEventStatsResult {
  const [stats, setStats] = useState<UseEventStatsResult['stats']>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const res = await apiFetch(`${API_BASE}/api/events/stats`);
      if (!res.ok) throw new Error('Failed to fetch event stats');
      const data = await res.json();
      setStats(data.stats);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { stats, loading, error, refresh };
}
