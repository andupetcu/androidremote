import { useState, useEffect, useCallback } from 'react';
import type { Group, GroupInput, Device } from '../types/api';

const API_BASE = import.meta.env.DEV ? 'http://localhost:7899' : '';

interface UseGroupsResult {
  groups: Group[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  createGroup: (input: GroupInput) => Promise<Group>;
  updateGroup: (id: string, input: Partial<GroupInput>) => Promise<Group>;
  deleteGroup: (id: string) => Promise<boolean>;
}

export function useGroups(): UseGroupsResult {
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const res = await fetch(`${API_BASE}/api/groups`);
      if (!res.ok) throw new Error('Failed to fetch groups');
      const data = await res.json();
      setGroups(data.groups);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const createGroup = async (input: GroupInput): Promise<Group> => {
    const res = await fetch(`${API_BASE}/api/groups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) throw new Error('Failed to create group');
    const data = await res.json();
    await refresh();
    return data.group;
  };

  const updateGroup = async (id: string, input: Partial<GroupInput>): Promise<Group> => {
    const res = await fetch(`${API_BASE}/api/groups/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) throw new Error('Failed to update group');
    const data = await res.json();
    await refresh();
    return data.group;
  };

  const deleteGroup = async (id: string): Promise<boolean> => {
    const res = await fetch(`${API_BASE}/api/groups/${id}`, {
      method: 'DELETE',
    });
    if (!res.ok) throw new Error('Failed to delete group');
    await refresh();
    return true;
  };

  return { groups, loading, error, refresh, createGroup, updateGroup, deleteGroup };
}

interface UseGroupResult {
  group: Group | null;
  devices: Device[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  addDevice: (deviceId: string) => Promise<void>;
  removeDevice: (deviceId: string) => Promise<void>;
}

export function useGroup(groupId: string): UseGroupResult {
  const [group, setGroup] = useState<Group | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const [groupRes, devicesRes] = await Promise.all([
        fetch(`${API_BASE}/api/groups/${groupId}`),
        fetch(`${API_BASE}/api/groups/${groupId}/devices`),
      ]);

      if (!groupRes.ok) throw new Error('Failed to fetch group');
      if (!devicesRes.ok) throw new Error('Failed to fetch group devices');

      const groupData = await groupRes.json();
      const devicesData = await devicesRes.json();

      setGroup(groupData.group);
      setDevices(devicesData.devices);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [groupId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const addDevice = async (deviceId: string) => {
    const res = await fetch(`${API_BASE}/api/groups/${groupId}/devices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId }),
    });
    if (!res.ok) throw new Error('Failed to add device to group');
    await refresh();
  };

  const removeDevice = async (deviceId: string) => {
    const res = await fetch(`${API_BASE}/api/groups/${groupId}/devices/${deviceId}`, {
      method: 'DELETE',
    });
    if (!res.ok) throw new Error('Failed to remove device from group');
    await refresh();
  };

  return { group, devices, loading, error, refresh, addDevice, removeDevice };
}
