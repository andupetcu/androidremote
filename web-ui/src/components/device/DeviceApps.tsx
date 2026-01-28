import { useDeviceApps } from '../../hooks/useApps';
import { DataTable } from '../data/DataTable';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Spinner } from '../ui/Spinner';
import { EmptyState } from '../ui/EmptyState';
import type { Column } from '../data/DataTable';
import type { AppInfo } from '../../types/api';
import './DeviceComponents.css';

interface DeviceAppsProps {
  deviceId: string;
}

export function DeviceApps({ deviceId }: DeviceAppsProps) {
  const { apps, loading, error, refresh } = useDeviceApps(deviceId);

  const columns: Column<AppInfo>[] = [
    {
      key: 'appName',
      header: 'App Name',
      render: (app) => (
        <div className="device-apps__app-info">
          <span className="device-apps__app-name">{app.appName || 'Unknown'}</span>
          <span className="device-apps__package-name">{app.packageName}</span>
        </div>
      ),
    },
    {
      key: 'versionName',
      header: 'Version',
      render: (app) => <span>{app.versionName || '-'}</span>,
    },
    {
      key: 'isSystemApp',
      header: 'Type',
      render: (app) => (
        <Badge variant={app.isSystemApp ? 'info' : 'success'} size="sm">
          {app.isSystemApp ? 'System' : 'User'}
        </Badge>
      ),
    },
    {
      key: 'installedAt',
      header: 'Installed',
      render: (app) => (
        <span className="device-apps__date">
          {app.installedAt ? new Date(app.installedAt).toLocaleDateString() : '-'}
        </span>
      ),
    },
  ];

  if (loading) {
    return (
      <div className="device-tab__loading">
        <Spinner size="md" />
        <p>Loading apps...</p>
      </div>
    );
  }

  if (error) {
    return (
      <EmptyState
        title="Error loading apps"
        description={error}
        action={<Button onClick={refresh}>Retry</Button>}
      />
    );
  }

  if (apps.length === 0) {
    return (
      <EmptyState
        title="No apps found"
        description="No installed apps reported for this device"
      />
    );
  }

  return (
    <div className="device-apps">
      <div className="device-apps__header">
        <span className="device-apps__count">{apps.length} apps installed</span>
        <Button variant="ghost" size="sm" onClick={refresh}>
          Refresh
        </Button>
      </div>
      <DataTable columns={columns} data={apps} keyExtractor={(app) => app.packageName} />
    </div>
  );
}
