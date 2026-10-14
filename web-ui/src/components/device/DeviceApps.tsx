import { useState } from 'react';
import { useDeviceApps } from '../../hooks/useApps';
import { useDeviceCommands, CommandHelpers } from '../../hooks/useCommands';
import { useConfirm } from '../../hooks/useConfirm';
import { protectedPackages } from '../../lib/deviceState';
import { Modal } from '../ui/Modal';
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
  const { commands, sendCommand } = useDeviceCommands(deviceId);
  const { confirm, dialog } = useConfirm();
  const [actionError, setActionError] = useState<string | null>(null);
  const [permApp, setPermApp] = useState<AppInfo | null>(null);
  const [permission, setPermission] = useState('');
  const [permState, setPermState] = useState<'granted' | 'denied' | 'default'>('granted');
  const protectedList = protectedPackages(commands);

  const act = async (what: string, fn: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await fn();
    } catch (err) {
      setActionError(`${what} failed: ${err instanceof Error ? err.message : 'unknown error'}`);
    }
  };

  const disableApp = async (app: AppInfo) => {
    const ok = await confirm({
      title: `Disable ${app.appName || app.packageName}?`,
      body: 'The app is hidden and cannot run until it is enabled again.',
      confirmLabel: 'Disable app',
    });
    if (ok) await act('Disable', () => CommandHelpers.disableApp(sendCommand, app.packageName));
  };

  const toggleProtect = async (app: AppInfo) => {
    const isProtected = protectedList.includes(app.packageName);
    if (isProtected) {
      const ok = await confirm({
        title: `Unprotect ${app.appName || app.packageName}?`,
        body: 'The device will allow this app to be uninstalled or disabled again.',
        confirmLabel: 'Unprotect',
      });
      if (!ok) return;
    }
    const next = isProtected ? protectedList.filter((p) => p !== app.packageName) : [...protectedList, app.packageName];
    await act('Protect', () => CommandHelpers.setProtectedPackages(sendCommand, next));
  };

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
    {
      key: 'actions',
      header: 'Actions',
      render: (app) => {
        const isProtected = protectedList.includes(app.packageName);
        return (
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
            {isProtected && <Badge variant="warning" size="sm">Protected</Badge>}
            <Button variant="ghost" size="sm" onClick={() => act('Launch', () => CommandHelpers.launchApp(sendCommand, app.packageName))}>Launch</Button>
            {app.isEnabled === false ? (
              <Button variant="ghost" size="sm" onClick={() => act('Enable', () => CommandHelpers.enableApp(sendCommand, app.packageName))}>Enable</Button>
            ) : (
              <Button variant="ghost" size="sm" disabled={isProtected} onClick={() => disableApp(app)}>Disable</Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => { setPermApp(app); setPermission(''); setPermState('granted'); }}>Permissions</Button>
            <Button variant="ghost" size="sm" onClick={() => toggleProtect(app)}>{isProtected ? 'Unprotect' : 'Protect'}</Button>
          </div>
        );
      },
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
      {dialog}
      {actionError && <div role="alert" className="device-commands__result device-commands__result--error">{actionError}</div>}
      <Modal
        open={permApp !== null}
        onClose={() => setPermApp(null)}
        title={`Permissions: ${permApp?.appName || permApp?.packageName || ''}`}
        size="sm"
        actions={
          <>
            <Button variant="secondary" onClick={() => setPermApp(null)}>Cancel</Button>
            <Button
              disabled={!permission.trim()}
              onClick={() => {
                const target = permApp;
                setPermApp(null);
                if (target) void act('Permission change', () => CommandHelpers.grantPermission(sendCommand, target.packageName, permission.trim(), permState));
              }}
            >
              Apply
            </Button>
          </>
        }
      >
        <label style={{ display: 'block', marginBottom: 8 }}>
          Permission{' '}
          <input value={permission} onChange={(e) => setPermission(e.target.value)} placeholder="android.permission.CAMERA" style={{ width: '100%' }} />
        </label>
        <label>
          State{' '}
          <select value={permState} onChange={(e) => setPermState(e.target.value as typeof permState)}>
            <option value="granted">Granted</option>
            <option value="denied">Denied</option>
            <option value="default">Default (user decides)</option>
          </select>
        </label>
      </Modal>
      <div className="device-apps__header">
        <span className="device-apps__count">{apps.length} apps installed</span>
        <Button variant="ghost" size="sm" onClick={refresh}>
          Refresh
        </Button>
      </div>
      <DataTable
        columns={columns}
        data={apps}
        keyExtractor={(app) => app.packageName}
        virtualRows={apps.length > 100 ? { rowHeight: 56, height: 560 } : undefined}
      />
    </div>
  );
}
