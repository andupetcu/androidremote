import { useParams, Link, useNavigate } from 'react-router-dom';
import { useMemo } from 'react';
import { makeStyles } from '@fluentui/react-components';
import { useDevice } from '../hooks/useDevices';
import { Tabs } from '../components/ui/Tabs';
import { Spinner } from '../components/ui/Spinner';
import {
  DeviceOverview,
  DeviceApps,
  DeviceCommands,
  DeviceEvents,
  DeviceFiles,
  DeviceRemote,
} from '../components/device';
import type { Tab } from '../components/ui/Tabs';

const spinKeyframes = {
  to: { transform: 'rotate(360deg)' },
};

const pulseKeyframes = {
  '0%, 100%': { opacity: 1 },
  '50%': { opacity: 0.6 },
};

const useStyles = makeStyles({
  root: {
    minHeight: '100vh',
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: '#1a1a2e',
    color: '#eee',
  },
  loading: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    textAlign: 'center',
    padding: '2rem',
  },
  loadingSpinner: {
    width: '48px',
    height: '48px',
    border: '3px solid #0f3460',
    borderTopColor: '#e94560',
    borderRadius: '50%',
    animationName: spinKeyframes,
    animationDuration: '1s',
    animationTimingFunction: 'linear',
    animationIterationCount: 'infinite',
  },
  loadingText: {
    marginTop: '1rem',
    color: '#888',
  },
  error: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    textAlign: 'center',
    padding: '2rem',
  },
  errorTitle: {
    margin: '0 0 0.5rem',
  },
  errorText: {
    color: '#888',
    marginBottom: '1.5rem',
  },
  backLink: {
    color: '#e94560',
    textDecoration: 'none',
    ':hover': {
      textDecoration: 'underline',
    },
  },
  header: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '1rem',
    padding: '1rem 2rem',
    backgroundColor: '#16213e',
    borderBottom: '1px solid #0f3460',
    '@media (max-width: 768px)': {
      padding: '1rem',
    },
  },
  nav: {
    display: 'flex',
    alignItems: 'center',
    gap: '1rem',
  },
  back: {
    backgroundColor: 'transparent',
    border: '1px solid #0f3460',
    color: '#888',
    padding: '0.5rem 1rem',
    borderRadius: '0.25rem',
    cursor: 'pointer',
    fontSize: '0.875rem',
    ':hover': {
      border: '1px solid #e94560',
      color: '#eee',
    },
  },
  breadcrumb: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    fontSize: '0.875rem',
    color: '#888',
  },
  breadcrumbLink: {
    color: '#888',
    textDecoration: 'none',
    ':hover': {
      color: '#e94560',
    },
  },
  breadcrumbCurrent: {
    color: '#eee',
  },
  info: {
    flex: 1,
  },
  title: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
  },
  titleH1: {
    margin: 0,
    fontSize: '1.25rem',
    fontWeight: '600',
  },
  status: {
    width: '12px',
    height: '12px',
    borderRadius: '50%',
  },
  statusOnline: {
    backgroundColor: '#0f9d58',
    boxShadow: '0 0 8px rgba(15, 157, 88, 0.5)',
  },
  statusOffline: {
    backgroundColor: '#666',
  },
  meta: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '1rem',
    marginTop: '0.25rem',
    fontSize: '0.875rem',
    color: '#888',
    '@media (max-width: 768px)': {
      flexDirection: 'column',
      gap: '0.25rem',
    },
  },
  connection: {
    marginLeft: 'auto',
  },
  connectionBadge: {
    padding: '0.375rem 0.75rem',
    borderRadius: '1rem',
    fontSize: '0.75rem',
    fontWeight: '500',
    textTransform: 'uppercase',
  },
  connectionDisconnected: {
    backgroundColor: '#4a4a4a',
    color: '#aaa',
  },
  connectionConnecting: {
    backgroundColor: '#e94560',
    color: 'white',
    animationName: pulseKeyframes,
    animationDuration: '1.5s',
    animationIterationCount: 'infinite',
  },
  connectionConnected: {
    backgroundColor: '#0f9d58',
    color: 'white',
  },
  connectionFailed: {
    backgroundColor: '#d32f2f',
    color: 'white',
  },
  main: {
    flex: 1,
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    padding: '2rem',
    '@media (max-width: 768px)': {
      padding: '1rem',
    },
  },
  mainTabs: {
    display: 'block',
    padding: 0,
  },
  footer: {
    padding: '1rem 2rem',
    textAlign: 'center',
    backgroundColor: '#16213e',
    borderTop: '1px solid #0f3460',
  },
  footerText: {
    margin: 0,
    fontSize: '0.875rem',
    color: '#666',
  },
});

export function DeviceDetail() {
  const styles = useStyles();
  const { deviceId } = useParams<{ deviceId: string }>();
  const navigate = useNavigate();
  const { device, loading, error, refresh } = useDevice(deviceId);

  const tabs: Tab[] = useMemo(() => {
    if (!device) return [];
    return [
      {
        id: 'overview',
        label: 'Overview',
        content: <DeviceOverview device={device} onDeviceUpdate={refresh} />,
      },
      {
        id: 'apps',
        label: 'Apps',
        content: <DeviceApps deviceId={device.id} />,
      },
      {
        id: 'commands',
        label: 'Commands',
        content: <DeviceCommands deviceId={device.id} />,
      },
      {
        id: 'events',
        label: 'Events',
        content: <DeviceEvents deviceId={device.id} />,
      },
      {
        id: 'files',
        label: 'Files',
        content: <DeviceFiles deviceId={device.id} />,
      },
      {
        id: 'remote',
        label: 'Remote',
        content: <DeviceRemote deviceId={device.id} />,
      },
    ];
  }, [device, refresh]);

  if (loading) {
    return (
      <div className={styles.root}>
        <div className={styles.loading}>
          <Spinner size="lg" />
          <p className={styles.loadingText}>Loading device...</p>
        </div>
      </div>
    );
  }

  if (error || !device) {
    return (
      <div className={styles.root}>
        <div className={styles.error}>
          <h2 className={styles.errorTitle}>Device not found</h2>
          <p className={styles.errorText}>{error || 'The requested device does not exist.'}</p>
          <Link to="/" className={styles.backLink}>
            Back to Dashboard
          </Link>
        </div>
      </div>
    );
  }

  const handleBack = () => {
    navigate('/devices');
  };

  const formatDate = (timestamp: number | null) => {
    if (!timestamp) return 'Never';
    return new Date(timestamp).toLocaleString();
  };

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <div className={styles.nav}>
          <button onClick={handleBack} className={styles.back}>
            &larr; Back
          </button>
          <div className={styles.breadcrumb}>
            <Link to="/devices" className={styles.breadcrumbLink}>Devices</Link>
            <span>/</span>
            <span className={styles.breadcrumbCurrent}>{device.name}</span>
          </div>
        </div>

        <div className={styles.info}>
          <div className={styles.title}>
            <span className={`${styles.status} ${device.status === 'online' ? styles.statusOnline : styles.statusOffline}`} />
            <h1 className={styles.titleH1}>{device.name}</h1>
          </div>
          <div className={styles.meta}>
            {device.model && <span>Model: {device.model}</span>}
            {device.androidVersion && <span>Android {device.androidVersion}</span>}
            <span>Last seen: {formatDate(device.lastSeenAt)}</span>
          </div>
        </div>
      </header>

      <main className={`${styles.main} ${styles.mainTabs}`}>
        <Tabs tabs={tabs} defaultTab="overview" />
      </main>
    </div>
  );
}
