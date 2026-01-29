import { useState, useEffect, useCallback } from 'react';
import type { Policy, PolicyInput } from '../types/api';
import { API_BASE, apiFetch } from '../utils/api';

interface UsePoliciesResult {
  policies: Policy[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  createPolicy: (input: PolicyInput) => Promise<Policy>;
  updatePolicy: (id: string, input: Partial<PolicyInput>) => Promise<Policy>;
  deletePolicy: (id: string) => Promise<boolean>;
  assignToDevice: (policyId: string, deviceId: string) => Promise<void>;
  assignToGroup: (policyId: string, groupId: string) => Promise<void>;
}

export function usePolicies(): UsePoliciesResult {
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const res = await apiFetch(`${API_BASE}/api/policies`);
      if (!res.ok) throw new Error('Failed to fetch policies');
      const data = await res.json();
      setPolicies(data.policies);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const createPolicy = async (input: PolicyInput): Promise<Policy> => {
    const res = await apiFetch(`${API_BASE}/api/policies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) throw new Error('Failed to create policy');
    const data = await res.json();
    await refresh();
    return data.policy;
  };

  const updatePolicy = async (id: string, input: Partial<PolicyInput>): Promise<Policy> => {
    const res = await apiFetch(`${API_BASE}/api/policies/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) throw new Error('Failed to update policy');
    const data = await res.json();
    await refresh();
    return data.policy;
  };

  const deletePolicy = async (id: string): Promise<boolean> => {
    const res = await apiFetch(`${API_BASE}/api/policies/${id}`, {
      method: 'DELETE',
    });
    if (!res.ok) throw new Error('Failed to delete policy');
    await refresh();
    return true;
  };

  const assignToDevice = async (policyId: string, deviceId: string): Promise<void> => {
    const res = await apiFetch(`${API_BASE}/api/devices/${deviceId}/policy`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ policyId: policyId || null }),
    });
    if (!res.ok) throw new Error('Failed to assign policy to device');
  };

  const assignToGroup = async (policyId: string, groupId: string): Promise<void> => {
    const res = await apiFetch(`${API_BASE}/api/groups/${groupId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ policyId }),
    });
    if (!res.ok) throw new Error('Failed to assign policy to group');
  };

  return {
    policies,
    loading,
    error,
    refresh,
    createPolicy,
    updatePolicy,
    deletePolicy,
    assignToDevice,
    assignToGroup,
  };
}

interface UsePolicyResult {
  policy: Policy | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function usePolicy(policyId: string): UsePolicyResult {
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const res = await apiFetch(`${API_BASE}/api/policies/${policyId}`);
      if (!res.ok) throw new Error('Failed to fetch policy');
      const data = await res.json();
      setPolicy(data.policy);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [policyId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { policy, loading, error, refresh };
}
