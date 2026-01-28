import { useState, useCallback, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { makeStyles } from '@fluentui/react-components';
import { useDevices } from '../hooks/useDevices';
import { useEvents } from '../hooks/useEvents';
import { useRealtimeEvents, useRealtimeDeviceStatus } from '../hooks/useAdminWebSocket';
import { DeviceCard } from '../components/DeviceCard';
import { EnrollmentModal } from '../components/EnrollmentModal';
import { StatCard } from '../components/data/StatCard';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Spinner } from '../components/ui/Spinner';
import { EmptyState } from '../components/ui/EmptyState';
import type { DeviceEvent } from '../types/api';

const useStyles = makeStyles({
  root: {
    padding: '1.5rem',
    maxWidth: '1400px',
    margin: '0 auto',
    '@media (max-width: 640px)': {
      padding: '1rem',
    },
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '1.5rem',
    '@media (max-width: 640px)': {
      flexDirection: 'column',
      gap: '1rem',
      alignItems: 'stretch',
    },
  },
  titleWrapper: {},
  title: {
    margin: 0,
    fontSize: '1.75rem',
    color: '#fff',
  },
  subtitle: {
    color: '#888',
    fontSize: '0.875rem',
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
  stats: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
    gap: '1rem',
    marginBottom: '1.5rem',
    '@media (max-width: 640px)': {
      gridTemplateColumns: '1fr 1fr',
    },
  },
  content: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '1.5rem',
    marginBottom: '1.5rem',
    '@media (max-width: 900px)': {
      gridTemplateColumns: '1fr',
    },
  },
  panel: {
    backgroundColor: '#16213e',
    borderRadius: '8px',
    padding: '1.25rem',
  },
  panelHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '1rem',
  },
  panelTitle: {
    margin: 0,
    fontSize: '1rem',
    color: '#fff',
    fontWeight: '600',
  },
  panelLink: {
    color: '#e94560',
    textDecoration: 'none',
    fontSize: '0.875rem',
    ':hover': {
      textDecoration: 'underline',
    },
  },
  eventsList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
  },
  eventItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    padding: '0.5rem',
    backgroundColor: 'rgba(0, 0, 0, 0.2)',
    borderRadius: '4px',
  },
  eventType: {
    flex: 1,
    fontSize: '0.875rem',
    color: '#ccc',
  },
  eventTime: {
    fontSize: '0.75rem',
    color: '#666',
  },
  noEvents: {
    color: '#666',
    textAlign: 'center',
    padding: '1rem',
  },
  actionsGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '0.75rem',
    '@media (max-width: 640px)': {
      gridTemplateColumns: '1fr',
    },
  },
  actionsLink: {
    textDecoration: 'none',
  },
  actionsButton: {
    width: '100%',
  },
  devicesSection: {
    backgroundColor: '#16213e',
    borderRadius: '8px',
    padding: '1.25rem',
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
    gap: '1rem',
    '@media (max-width: 640px)': {
      gridTemplateColumns: '1fr',
    },
  },
});

export function Dashboard() {
  const styles = useStyles();
  const { devices, loading, error, refresh, unenrollDevice } = useDevices();
  const { events, refresh: refreshEvents } = useEvents({ acknowledged: false });
  const [showEnrollment, setShowEnrollment] = useState(false);
  const [recentEvents, setRecentEvents] = useState<DeviceEvent[]>([]);
  const mountIdRef = useRef(Math.random().toString(36).slice(2, 8));

  // Track Dashboard mounts
  useEffect(() => {
    console.log('[Dashboard] MOUNTED, id:', mountIdRef.current);
    return () => {
      console.log('[Dashboard] UNMOUNTED, id:', mountIdRef.current);
    };
  }, []);

  // Real-time event updates
  const handleNewEvent = useCallback((event: DeviceEvent) => {
    setRecentEvents((prev) => [event, ...prev].slice(0, 5));
  }, []);

  // Memoize device status callbacks to avoid effect re-runs
  const handleDeviceOnline = useCallback(() => {
    refresh();
  }, [refresh]);

  const handleDeviceOffline = useCallback(() => {
    refresh();
  }, [refresh]);

  // Memoize modal callbacks to ensure stable references
  const handleCloseEnrollment = useCallback(() => {
    setShowEnrollment(false);
  }, []);

  const handleEnrollmentSuccess = useCallback(() => {
    refresh();
  }, [refresh]);

  useRealtimeEvents(handleNewEvent);
  useRealtimeDeviceStatus(handleDeviceOnline, handleDeviceOffline);

  const onlineCount = devices.filter((d) => d.status === 'online').length;
  const offlineCount = devices.filter((d) => d.status === 'offline').length;
  const compliantCount = devices.filter((d) => d.complianceStatus === 'compliant').length;

  const displayEvents = recentEvents.length > 0 ? recentEvents : (events || []).slice(0, 5);

  const severityVariant = (severity: string): 'error' | 'warning' | 'info' => {
    switch (severity) {
      case 'critical': return 'error';
      case 'warning': return 'warning';
      default: return 'info';
    }
  };

  // Render content based on loading/error state
  const renderContent = () => {
    if (loading && devices.length === 0) {
      return (
        <div className={styles.loading}>
          <Spinner size="lg" />
          <p>Loading dashboard...</p>
        </div>
      );
    }

    if (error) {
      return (
        <EmptyState
          title="Error loading dashboard"
          description={error}
          action={<Button onClick={refresh}>Retry</Button>}
        />
      );
    }

    return (
      <>
        <header className={styles.header}>
          <div className={styles.titleWrapper}>
            <h1 className={styles.title}>Dashboard</h1>
            <span className={styles.subtitle}>Fleet Overview</span>
          </div>
          <Button onClick={() => setShowEnrollment(true)}>
            + Enroll Device
          </Button>
        </header>

        {/* Stats Row */}
        <div className={styles.stats}>
          <StatCard
            label="Total Devices"
            value={devices.length}
            icon="📱"
          />
          <StatCard
            label="Online"
            value={onlineCount}
            icon="🟢"
            variant="success"
          />
          <StatCard
            label="Offline"
            value={offlineCount}
            icon="⚪"
            variant={offlineCount > 0 ? 'warning' : 'default'}
          />
          <StatCard
            label="Compliant"
            value={`${devices.length > 0 ? Math.round((compliantCount / devices.length) * 100) : 0}%`}
            icon="✓"
            variant={compliantCount === devices.length ? 'success' : 'warning'}
          />
        </div>

        <div className={styles.content}>
          {/* Recent Events Panel */}
          <div className={styles.panel}>
            <div className={styles.panelHeader}>
              <h2 className={styles.panelTitle}>Recent Events</h2>
              <Link to="/events" className={styles.panelLink}>View All</Link>
            </div>
            <div className={styles.eventsList}>
              {displayEvents.length > 0 ? (
                displayEvents.map((event) => (
                  <div key={event.id} className={styles.eventItem}>
                    <Badge variant={severityVariant(event.severity)} size="sm">
                      {event.severity}
                    </Badge>
                    <span className={styles.eventType}>{event.eventType}</span>
                    <span className={styles.eventTime}>
                      {new Date(event.createdAt).toLocaleTimeString()}
                    </span>
                  </div>
                ))
              ) : (
                <p className={styles.noEvents}>No recent events</p>
              )}
            </div>
          </div>

          {/* Quick Actions Panel */}
          <div className={styles.panel}>
            <div className={styles.panelHeader}>
              <h2 className={styles.panelTitle}>Quick Actions</h2>
            </div>
            <div className={styles.actionsGrid}>
              <Button variant="secondary" onClick={() => setShowEnrollment(true)}>
                Enroll Device
              </Button>
              <Link to="/groups" className={styles.actionsLink}>
                <Button variant="secondary" className={styles.actionsButton}>Manage Groups</Button>
              </Link>
              <Link to="/policies" className={styles.actionsLink}>
                <Button variant="secondary" className={styles.actionsButton}>Manage Policies</Button>
              </Link>
              <Button variant="ghost" onClick={refreshEvents}>
                Refresh Events
              </Button>
            </div>
          </div>
        </div>

        {/* Devices Grid */}
        <div className={styles.devicesSection}>
          <div className={styles.panelHeader}>
            <h2 className={styles.panelTitle}>Devices</h2>
            <Link to="/devices" className={styles.panelLink}>View All</Link>
          </div>

          {devices.length === 0 ? (
            <EmptyState
              title="No devices enrolled"
              description="Add your first Android device to get started"
              action={
                <Button onClick={() => setShowEnrollment(true)}>
                  Enroll Device
                </Button>
              }
            />
          ) : (
            <div className={styles.grid}>
              {devices.slice(0, 6).map((device) => (
                <DeviceCard
                  key={device.id}
                  device={device}
                  onUnenroll={unenrollDevice}
                />
              ))}
            </div>
          )}
        </div>
      </>
    );
  };

  // Single return with EnrollmentModal always in the same position
  return (
    <>
      <div className={styles.root}>
        {renderContent()}
      </div>
      {/* EnrollmentModal is OUTSIDE the conditional content, always in the same JSX position */}
      <EnrollmentModal
        isOpen={showEnrollment}
        onClose={handleCloseEnrollment}
        onSuccess={handleEnrollmentSuccess}
      />
    </>
  );
}
