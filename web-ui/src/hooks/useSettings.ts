import { useState, useEffect } from 'react';
import { API_BASE, apiFetch } from '../utils/api';

interface Settings {
  serverName: string;
  appsUpdateTime: string;
}

const DEFAULT_SERVER_NAME = 'Android Remote';

interface UseSettingsResult {
  settings: Settings;
  loading: boolean;
}

export function useSettings(): UseSettingsResult {
  const [settings, setSettings] = useState<Settings>({
    serverName: DEFAULT_SERVER_NAME,
    appsUpdateTime: '',
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function fetchSettings() {
      try {
        const res = await apiFetch(`${API_BASE}/api/settings`);
        if (res.ok && !cancelled) {
          const data = await res.json();
          setSettings((prev) => ({
            ...prev,
            serverName: data.serverName || DEFAULT_SERVER_NAME,
            appsUpdateTime: data.appsUpdateTime || '',
          }));
        }
      } catch {
        // Keep defaults on error
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchSettings();
    return () => { cancelled = true; };
  }, []);

  return { settings, loading };
}
