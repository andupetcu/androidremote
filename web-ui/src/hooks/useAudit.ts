import { useState, useEffect, useCallback } from 'react';
import type { AuditLog, AuditAction, ActorType, ResourceType } from '../types/api';
import { API_BASE, apiFetch } from '../utils/api';

interface AuditFilters {
  actorType?: ActorType;
  actorId?: string;
  action?: AuditAction;
  resourceType?: ResourceType;
  resourceId?: string;
  from?: number;
  to?: number;
  limit?: number;
  offset?: number;
}

interface UseAuditResult {
  logs: AuditLog[];
  total: number;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  exportCsv: () => Promise<void>;
}

export function useAudit(filters?: AuditFilters): UseAuditResult {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const buildParams = useCallback(() => {
    const params = new URLSearchParams();
    if (filters?.actorType) params.set('actorType', filters.actorType);
    if (filters?.actorId) params.set('actorId', filters.actorId);
    if (filters?.action) params.set('action', filters.action);
    if (filters?.resourceType) params.set('resourceType', filters.resourceType);
    if (filters?.resourceId) params.set('resourceId', filters.resourceId);
    if (filters?.from) params.set('from', filters.from.toString());
    if (filters?.to) params.set('to', filters.to.toString());
    if (filters?.limit) params.set('limit', filters.limit.toString());
    if (filters?.offset) params.set('offset', filters.offset.toString());
    return params;
  }, [filters]);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const params = buildParams();
      const url = `${API_BASE}/api/audit?${params}`;
      const res = await apiFetch(url);
      if (!res.ok) throw new Error('Failed to fetch audit logs');
      const data = await res.json();
      setLogs(data.logs);
      setTotal(data.total ?? data.logs.length);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [buildParams]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const exportCsv = async (): Promise<void> => {
    const params = buildParams();
    params.set('format', 'csv');
    const url = `${API_BASE}/api/audit/export?${params}`;

    const res = await apiFetch(url);
    if (!res.ok) throw new Error('Failed to export audit logs');

    const blob = await res.blob();
    const downloadUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = `audit-logs-${new Date().toISOString().split('T')[0]}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(downloadUrl);
  };

  return { logs, total, loading, error, refresh, exportCsv };
}

interface UseDeviceAuditResult {
  logs: AuditLog[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useDeviceAudit(deviceId: string): UseDeviceAuditResult {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const res = await apiFetch(`${API_BASE}/api/audit?resourceType=device&resourceId=${deviceId}`);
      if (!res.ok) throw new Error('Failed to fetch device audit logs');
      const data = await res.json();
      setLogs(data.logs);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { logs, loading, error, refresh };
}
