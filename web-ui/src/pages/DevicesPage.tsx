import { useState } from 'react';
import { Link } from 'react-router-dom';
import { makeStyles, mergeClasses } from '@fluentui/react-components';
import { useDevices } from '../hooks/useDevices';
import { Button } from '../components/ui/Button';
import { API_BASE, apiFetch } from '../utils/api';

const useStyles = makeStyles({
  root: {
    maxWidth: '1400px',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '1.5rem',
  },
  headerTitle: {
    margin: 0,
    fontSize: '1.5rem',
    fontWeight: '600',
  },
  stats: {
    display: 'flex',
    gap: '1.5rem',
  },
  stat: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
  },
  statValue: {
    fontSize: '1.5rem',
    fontWeight: '600',
  },
  statValueOnline: {
    color: '#4ade80',
  },
  statValueOffline: {
    color: '#888',
  },
  statLabel: {
    fontSize: '0.75rem',
    color: '#888',
    textTransform: 'uppercase',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    backgroundColor: '#16213e',
    borderRadius: '0.5rem',
    overflow: 'hidden',
  },
  tableCell: {
    padding: '1rem',
    textAlign: 'left',
    borderBottom: '1px solid #0f3460',
  },
  tableHeader: {
    backgroundColor: '#0f3460',
    fontSize: '0.75rem',
    fontWeight: '600',
    textTransform: 'uppercase',
    color: '#888',
  },
  tableRow: {
    ':hover': {
      backgroundColor: 'rgba(233, 69, 96, 0.05)',
    },
  },
  deviceLink: {
    color: '#e94560',
    textDecoration: 'none',
    ':hover': {
      textDecoration: 'underline',
    },
  },
  statusDot: {
    display: 'inline-block',
    width: '10px',
    height: '10px',
    borderRadius: '50%',
    backgroundColor: '#888',
  },
  statusDotOnline: {
    backgroundColor: '#4ade80',
    boxShadow: '0 0 8px rgba(74, 222, 128, 0.5)',
  },
  statusDotOffline: {
    backgroundColor: '#666',
  },
  actionBtn: {
    color: '#888',
    textDecoration: 'none',
    fontSize: '0.875rem',
    padding: '0.25rem 0.5rem',
    borderRadius: '0.25rem',
    transitionProperty: 'background, color',
    transitionDuration: '0.2s',
    ':hover': {
      backgroundColor: 'rgba(233, 69, 96, 0.1)',
      color: '#e94560',
    },
  },
  deleteBtn: {
    color: '#888',
    fontSize: '0.875rem',
    padding: '0.25rem 0.5rem',
    borderRadius: '0.25rem',
    border: 'none',
    background: 'none',
    cursor: 'pointer',
    transitionProperty: 'background, color',
    transitionDuration: '0.2s',
    marginLeft: '0.5rem',
    ':hover': {
      backgroundColor: 'rgba(239, 68, 68, 0.1)',
      color: '#ef4444',
    },
  },
  empty: {
    textAlign: 'center',
    padding: '3rem',
    color: '#888',
  },
  loading: {
    textAlign: 'center',
    padding: '3rem',
    color: '#888',
  },
  error: {
    textAlign: 'center',
    padding: '3rem',
    color: '#e94560',
  },
});

export function DevicesPage() {
  const styles = useStyles();
  const { devices, loading, error, unenrollDevice } = useDevices();
  const [syncing, setSyncing] = useState(false);

  const handleReapplyAll = async () => {
    if (!confirm('Reapply policies to all devices?')) return;
    setSyncing(true);
    try {
      await Promise.all(
        devices.map((d) =>
          apiFetch(`${API_BASE}/api/commands`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceId: d.id, type: 'SYNC_POLICY', payload: {} }),
          })
        )
      );
    } catch (err) {
      console.error('Failed to reapply policies:', err);
    } finally {
      setSyncing(false);
    }
  };

  const handleUnenroll = async (id: string, name: string) => {
    if (confirm(`Are you sure you want to unenroll "${name}"? This action cannot be undone.`)) {
      await unenrollDevice(id);
    }
  };

  if (loading) {
    return <div className={styles.loading}>Loading devices...</div>;
  }

  if (error) {
    return <div className={styles.error}>{error}</div>;
  }

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <h1 className={styles.headerTitle}>Devices</h1>
          {devices.length > 0 && (
            <Button variant="secondary" size="sm" loading={syncing} onClick={handleReapplyAll}>
              Reapply All Policies
            </Button>
          )}
        </div>
        <div className={styles.stats}>
          <span className={styles.stat}>
            <span className={styles.statValue}>{devices.length}</span>
            <span className={styles.statLabel}>Total</span>
          </span>
          <span className={styles.stat}>
            <span className={mergeClasses(styles.statValue, styles.statValueOnline)}>
              {devices.filter(d => d.status === 'online').length}
            </span>
            <span className={styles.statLabel}>Online</span>
          </span>
          <span className={styles.stat}>
            <span className={mergeClasses(styles.statValue, styles.statValueOffline)}>
              {devices.filter(d => d.status === 'offline').length}
            </span>
            <span className={styles.statLabel}>Offline</span>
          </span>
        </div>
      </div>

      <table className={styles.table}>
        <thead>
          <tr>
            <th className={mergeClasses(styles.tableCell, styles.tableHeader)}>Status</th>
            <th className={mergeClasses(styles.tableCell, styles.tableHeader)}>Name</th>
            <th className={mergeClasses(styles.tableCell, styles.tableHeader)}>Model</th>
            <th className={mergeClasses(styles.tableCell, styles.tableHeader)}>Android</th>
            <th className={mergeClasses(styles.tableCell, styles.tableHeader)}>Last Seen</th>
            <th className={mergeClasses(styles.tableCell, styles.tableHeader)}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {devices.map((device) => (
            <tr key={device.id} className={styles.tableRow}>
              <td className={styles.tableCell}>
                <span className={mergeClasses(
                  styles.statusDot,
                  device.status === 'online' ? styles.statusDotOnline : styles.statusDotOffline
                )} />
              </td>
              <td className={styles.tableCell}>
                <Link to={`/devices/${device.id}`} className={styles.deviceLink}>
                  {device.name || device.id}
                </Link>
              </td>
              <td className={styles.tableCell}>{device.model || '-'}</td>
              <td className={styles.tableCell}>{device.androidVersion || '-'}</td>
              <td className={styles.tableCell}>
                {device.lastSeenAt
                  ? new Date(device.lastSeenAt).toLocaleString()
                  : 'Never'}
              </td>
              <td className={styles.tableCell}>
                <Link to={`/devices/${device.id}`} className={styles.actionBtn}>
                  View
                </Link>
                <button
                  className={styles.deleteBtn}
                  onClick={() => handleUnenroll(device.id, device.name || device.id)}
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {devices.length === 0 && (
        <div className={styles.empty}>
          No devices enrolled yet.
        </div>
      )}
    </div>
  );
}
