import { useState } from 'react';
import { makeStyles } from '@fluentui/react-components';
import { useAppCatalog, useAppPackages } from '../hooks/useApps';
import type { AppPackage } from '../hooks/useApps';
import { Button } from '../components/ui/Button';
import { Badge } from '../components/ui/Badge';
import { Tabs } from '../components/ui/Tabs';
import { DataTable } from '../components/data/DataTable';
import type { Column } from '../components/data/DataTable';
import { Spinner } from '../components/ui/Spinner';
import { EmptyState } from '../components/ui/EmptyState';
import { UploadApkModal } from '../components/apps/UploadApkModal';
import { InstallApkModal } from '../components/apps/InstallApkModal';
import type { AppCatalogEntry } from '../types/api';

const useStyles = makeStyles({
  root: {
    padding: '1.5rem',
    maxWidth: '1200px',
    margin: '0 auto',
    '@media (max-width: 900px)': {
      padding: '1rem',
    },
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: '1.5rem',
    '@media (max-width: 900px)': {
      flexDirection: 'column',
      gap: '1rem',
    },
  },
  headerTitle: {
    margin: 0,
    fontSize: '1.75rem',
    color: '#fff',
  },
  subtitle: {
    margin: '0.25rem 0 0',
    color: '#888',
    fontSize: '0.875rem',
  },
  headerActions: {
    display: 'flex',
    gap: '0.75rem',
  },
  loading: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '400px',
    gap: '1rem',
    color: '#888',
  },
  filters: {
    display: 'flex',
    gap: '0.75rem',
  },
  select: {
    backgroundColor: '#16213e',
    border: '1px solid #0f3460',
    borderRadius: '0.375rem',
    padding: '0.5rem 0.75rem',
    color: '#eee',
    fontSize: '0.875rem',
    cursor: 'pointer',
    minWidth: '150px',
    ':focus': {
      outline: 'none',
      border: '1px solid #e94560',
    },
  },
  appInfo: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.25rem',
  },
  appName: {
    fontWeight: '500',
    color: '#fff',
  },
  packageName: {
    fontFamily: 'monospace',
    fontSize: '0.75rem',
    color: '#666',
  },
  category: {
    color: '#888',
    fontSize: '0.875rem',
  },
  version: {
    color: '#eee',
  },
  versionCode: {
    color: '#666',
    fontSize: '0.75rem',
  },
  date: {
    color: '#888',
    fontSize: '0.875rem',
  },
  actions: {
    display: 'flex',
    gap: '0.5rem',
  },
});

export function AppsPage() {
  const styles = useStyles();
  const { apps, loading: catalogLoading, error: catalogError, refresh: refreshCatalog, approveApp, blockApp, setAppStatus } = useAppCatalog();
  const { packages, loading: packagesLoading, error: packagesError, refresh: refreshPackages, uploadPackage, deletePackage, installOnDevices } = useAppPackages();

  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [installPkg, setInstallPkg] = useState<AppPackage | null>(null);

  const filteredApps = statusFilter === 'all'
    ? apps
    : apps.filter((app) => app.status === statusFilter);

  const handleStatusChange = async (packageName: string, status: 'approved' | 'blocked' | 'pending') => {
    try {
      await setAppStatus(packageName, status);
    } catch (err) {
      console.error('Failed to update app status:', err);
    }
  };

  const handleDelete = async (packageName: string) => {
    if (!confirm(`Delete ${packageName}? This will remove the APK file.`)) return;
    try {
      await deletePackage(packageName);
    } catch (err) {
      console.error('Failed to delete package:', err);
    }
  };

  const catalogColumns: Column<AppCatalogEntry>[] = [
    {
      key: 'appName',
      header: 'App Name',
      render: (app) => (
        <div className={styles.appInfo}>
          <span className={styles.appName}>{app.appName || 'Unknown'}</span>
          <span className={styles.packageName}>{app.packageName}</span>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (app) => {
        const variant = app.status === 'approved' ? 'success' :
                       app.status === 'blocked' ? 'error' : 'warning';
        return <Badge variant={variant} size="sm">{app.status}</Badge>;
      },
    },
    {
      key: 'deviceCount',
      header: 'Devices',
      render: (app) => <span>{app.deviceCount}</span>,
    },
    {
      key: 'category',
      header: 'Category',
      render: (app) => <span className={styles.category}>{app.category || '-'}</span>,
    },
    {
      key: 'actions',
      header: 'Actions',
      render: (app) => (
        <div className={styles.actions}>
          {app.status !== 'approved' && (
            <Button
              variant="ghost"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                approveApp(app.packageName);
              }}
            >
              Approve
            </Button>
          )}
          {app.status !== 'blocked' && (
            <Button
              variant="ghost"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                blockApp(app.packageName);
              }}
            >
              Block
            </Button>
          )}
          {app.status !== 'pending' && (
            <Button
              variant="ghost"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                handleStatusChange(app.packageName, 'pending');
              }}
            >
              Reset
            </Button>
          )}
        </div>
      ),
    },
  ];

  const formatFileSize = (bytes: number | null): string => {
    if (!bytes) return '-';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const formatDate = (timestamp: number): string => {
    return new Date(timestamp).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  const packageColumns: Column<AppPackage>[] = [
    {
      key: 'appName',
      header: 'App Name',
      render: (pkg) => (
        <div className={styles.appInfo}>
          <span className={styles.appName}>{pkg.appName || 'Unknown'}</span>
          <span className={styles.packageName}>{pkg.packageName}</span>
        </div>
      ),
    },
    {
      key: 'versionName',
      header: 'Version',
      render: (pkg) => (
        <span className={styles.version}>
          {pkg.versionName || '-'}
          {pkg.versionCode && <span className={styles.versionCode}> ({pkg.versionCode})</span>}
        </span>
      ),
    },
    {
      key: 'fileSize',
      header: 'Size',
      render: (pkg) => <span>{formatFileSize(pkg.fileSize)}</span>,
    },
    {
      key: 'uploadedAt',
      header: 'Uploaded',
      render: (pkg) => <span className={styles.date}>{formatDate(pkg.uploadedAt)}</span>,
    },
    {
      key: 'actions',
      header: 'Actions',
      render: (pkg) => (
        <div className={styles.actions}>
          <Button
            variant="primary"
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              setInstallPkg(pkg);
            }}
          >
            Install
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              handleDelete(pkg.packageName);
            }}
          >
            Delete
          </Button>
        </div>
      ),
    },
  ];

  // Show loading if either is loading
  const loading = catalogLoading || packagesLoading;
  const error = catalogError || packagesError;
  const refresh = () => { refreshCatalog(); refreshPackages(); };

  if (loading) {
    return (
      <div className={styles.root}>
        <div className={styles.loading}>
          <Spinner size="lg" />
          <p>Loading applications...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={styles.root}>
        <EmptyState
          title="Error loading applications"
          description={error}
          action={<Button onClick={refresh}>Retry</Button>}
        />
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.headerTitle}>Applications</h1>
          <p className={styles.subtitle}>
            Manage app catalog and uploaded packages
          </p>
        </div>
        <div className={styles.headerActions}>
          <Button variant="primary" onClick={() => setShowUploadModal(true)}>
            Upload APK
          </Button>
        </div>
      </div>

      <Tabs
        defaultTab="catalog"
        tabs={[
          {
            id: 'catalog',
            label: `Catalog (${apps.length})`,
            content: (
              <>
                <div className={styles.filters}>
                  <select
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value)}
                    className={styles.select}
                  >
                    <option value="all">All Status ({apps.length})</option>
                    <option value="approved">Approved ({apps.filter(a => a.status === 'approved').length})</option>
                    <option value="blocked">Blocked ({apps.filter(a => a.status === 'blocked').length})</option>
                    <option value="pending">Pending ({apps.filter(a => a.status === 'pending').length})</option>
                  </select>
                </div>

                {filteredApps.length === 0 ? (
                  <EmptyState
                    title="No applications"
                    description={statusFilter === 'all'
                      ? 'No applications have been discovered yet'
                      : `No ${statusFilter} applications`
                    }
                  />
                ) : (
                  <DataTable
                    columns={catalogColumns}
                    data={filteredApps}
                    keyExtractor={(app) => app.packageName}
                  />
                )}
              </>
            ),
          },
          {
            id: 'packages',
            label: `Uploaded (${packages.length})`,
            content: (
              <>
                {packages.length === 0 ? (
                  <EmptyState
                    title="No uploaded packages"
                    description="Upload APK files to install on your devices"
                    action={<Button onClick={() => setShowUploadModal(true)}>Upload APK</Button>}
                  />
                ) : (
                  <DataTable
                    columns={packageColumns}
                    data={packages}
                    keyExtractor={(pkg) => pkg.id}
                  />
                )}
              </>
            ),
          },
        ]}
      />

      {/* Modals */}
      <UploadApkModal
        open={showUploadModal}
        onClose={() => setShowUploadModal(false)}
        onUpload={uploadPackage}
      />

      <InstallApkModal
        open={installPkg !== null}
        onClose={() => setInstallPkg(null)}
        pkg={installPkg}
        onInstall={installOnDevices}
      />
    </div>
  );
}
