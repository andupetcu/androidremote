import { useState, useEffect, useCallback } from 'react';
import type { AppInfo, AppCatalogEntry } from '../types/api';
import { API_BASE, apiFetch } from '../utils/api';

interface UseDeviceAppsResult {
  apps: AppInfo[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useDeviceApps(deviceId: string): UseDeviceAppsResult {
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const res = await apiFetch(`${API_BASE}/api/devices/${deviceId}/apps`);
      if (!res.ok) throw new Error('Failed to fetch device apps');
      const data = await res.json();
      setApps(data.apps);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { apps, loading, error, refresh };
}

interface UseAppCatalogResult {
  apps: AppCatalogEntry[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  approveApp: (packageName: string) => Promise<void>;
  blockApp: (packageName: string) => Promise<void>;
  setAppStatus: (packageName: string, status: 'approved' | 'blocked' | 'pending') => Promise<void>;
  updateNotes: (packageName: string, notes: string) => Promise<void>;
}

export function useAppCatalog(): UseAppCatalogResult {
  const [apps, setApps] = useState<AppCatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const res = await apiFetch(`${API_BASE}/api/apps`);
      if (!res.ok) throw new Error('Failed to fetch app catalog');
      const data = await res.json();
      setApps(data.apps);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const setAppStatus = async (packageName: string, status: 'approved' | 'blocked' | 'pending'): Promise<void> => {
    const res = await apiFetch(`${API_BASE}/api/apps/${encodeURIComponent(packageName)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    if (!res.ok) throw new Error('Failed to update app status');
    await refresh();
  };

  const approveApp = async (packageName: string): Promise<void> => {
    await setAppStatus(packageName, 'approved');
  };

  const blockApp = async (packageName: string): Promise<void> => {
    await setAppStatus(packageName, 'blocked');
  };

  const updateNotes = async (packageName: string, notes: string): Promise<void> => {
    const res = await apiFetch(`${API_BASE}/api/apps/${encodeURIComponent(packageName)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminNotes: notes }),
    });
    if (!res.ok) throw new Error('Failed to update app notes');
    await refresh();
  };

  return { apps, loading, error, refresh, approveApp, blockApp, setAppStatus, updateNotes };
}

interface UseAppDetailsResult {
  app: AppCatalogEntry | null;
  devices: { deviceId: string; deviceName: string; versionName: string | null }[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useAppDetails(packageName: string): UseAppDetailsResult {
  const [app, setApp] = useState<AppCatalogEntry | null>(null);
  const [devices, setDevices] = useState<UseAppDetailsResult['devices']>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const [appRes, devicesRes] = await Promise.all([
        apiFetch(`${API_BASE}/api/apps/${encodeURIComponent(packageName)}`),
        apiFetch(`${API_BASE}/api/apps/${encodeURIComponent(packageName)}/devices`),
      ]);

      if (!appRes.ok) throw new Error('Failed to fetch app details');
      if (!devicesRes.ok) throw new Error('Failed to fetch app devices');

      const appData = await appRes.json();
      const devicesData = await devicesRes.json();

      setApp(appData.app);
      setDevices(devicesData.devices);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [packageName]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { app, devices, loading, error, refresh };
}

// ============================================
// Uploaded Packages (APKs)
// ============================================

export interface AppPackage {
  id: string;
  packageName: string;
  appName: string | null;
  versionName: string | null;
  versionCode: number | null;
  fileSize: number | null;
  filePath: string;
  uploadedAt: number;
  uploadedBy: string | null;
  downloadUrl?: string;
}

export interface AppVersion {
  id: string;
  packageId: string;
  versionName: string | null;
  versionCode: number | null;
  filePath: string;
  fileSize: number | null;
  uploadedAt: number;
  downloadUrl?: string;
}

interface UseAppPackagesResult {
  packages: AppPackage[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  uploadPackage: (file: File, metadata: {
    packageName: string;
    appName?: string;
    versionName?: string;
    versionCode?: number;
  }) => Promise<AppPackage>;
  deletePackage: (packageName: string) => Promise<void>;
  installOnDevices: (packageName: string, deviceIds: string[]) => Promise<{ commands: unknown[] }>;
  deployToAll: (packageName: string) => Promise<{ queued: number }>;
}

export function useAppPackages(): UseAppPackagesResult {
  const [packages, setPackages] = useState<AppPackage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const res = await apiFetch(`${API_BASE}/api/apps/packages`);
      if (!res.ok) throw new Error('Failed to fetch app packages');
      const data = await res.json();
      setPackages(data.packages);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const uploadPackage = async (
    file: File,
    metadata: { packageName: string; appName?: string; versionName?: string; versionCode?: number }
  ): Promise<AppPackage> => {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('packageName', metadata.packageName);
    if (metadata.appName) formData.append('appName', metadata.appName);
    if (metadata.versionName) formData.append('versionName', metadata.versionName);
    if (metadata.versionCode) formData.append('versionCode', String(metadata.versionCode));

    const res = await apiFetch(`${API_BASE}/api/apps/upload`, {
      method: 'POST',
      body: formData,
    });
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Failed to upload package');
    }
    const pkg = await res.json();
    await refresh();
    return pkg;
  };

  const deletePackage = async (packageName: string): Promise<void> => {
    const res = await apiFetch(`${API_BASE}/api/apps/packages/${encodeURIComponent(packageName)}`, {
      method: 'DELETE',
    });
    if (!res.ok) throw new Error('Failed to delete package');
    await refresh();
  };

  const installOnDevices = async (
    packageName: string,
    deviceIds: string[]
  ): Promise<{ commands: unknown[] }> => {
    const res = await apiFetch(`${API_BASE}/api/apps/packages/${encodeURIComponent(packageName)}/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceIds }),
    });
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Failed to install on devices');
    }
    return res.json();
  };

  const deployToAll = async (packageName: string): Promise<{ queued: number }> => {
    const res = await apiFetch(`${API_BASE}/api/apps/packages/${encodeURIComponent(packageName)}/deploy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Failed to deploy');
    }
    return res.json();
  };

  return { packages, loading, error, refresh, uploadPackage, deletePackage, installOnDevices, deployToAll };
}

// ============================================
// Version History
// ============================================

interface UseAppVersionsResult {
  versions: AppVersion[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useAppVersions(packageName: string | null): UseAppVersionsResult {
  const [versions, setVersions] = useState<AppVersion[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!packageName) return;
    try {
      setLoading(true);
      setError(null);
      const res = await apiFetch(`${API_BASE}/api/apps/packages/${encodeURIComponent(packageName)}/versions`);
      if (!res.ok) throw new Error('Failed to fetch versions');
      const data = await res.json();
      setVersions(data.versions);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [packageName]);

  useEffect(() => {
    if (packageName) refresh();
  }, [refresh, packageName]);

  return { versions, loading, error, refresh };
}
