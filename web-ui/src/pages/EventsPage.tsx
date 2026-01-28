import { useState, useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { makeStyles, mergeClasses } from '@fluentui/react-components';
import { useEvents } from '../hooks/useEvents';
import { useRealtimeEvents } from '../hooks/useAdminWebSocket';
import { Button } from '../components/ui/Button';
import { Badge } from '../components/ui/Badge';
import { Spinner } from '../components/ui/Spinner';
import { EmptyState } from '../components/ui/EmptyState';
import type { DeviceEvent, EventSeverity } from '../types/api';

type FilterType = 'all' | 'unread' | EventSeverity;

const useStyles = makeStyles({
  root: {
    padding: '1.5rem',
    maxWidth: '1000px',
    margin: '0 auto',
    '@media (max-width: 640px)': {
      padding: '1rem',
    },
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: '1.5rem',
    '@media (max-width: 640px)': {
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
    fontSize: '0.875rem',
  },
  live: {
    color: '#4ade80',
    '::before': {
      content: '""',
      display: 'inline-block',
      width: '8px',
      height: '8px',
      backgroundColor: '#4ade80',
      borderRadius: '50%',
      marginRight: '0.5rem',
      animationName: {
        '0%, 100%': { opacity: 1 },
        '50%': { opacity: 0.5 },
      },
      animationDuration: '2s',
      animationIterationCount: 'infinite',
    },
  },
  offline: {
    color: '#f59e0b',
  },
  actions: {
    display: 'flex',
    gap: '0.5rem',
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
    gap: '0.5rem',
    marginBottom: '1.5rem',
    flexWrap: 'wrap',
  },
  filterBtn: {
    backgroundColor: 'transparent',
    border: '1px solid #0f3460',
    color: '#888',
    padding: '0.5rem 1rem',
    borderRadius: '0.375rem',
    fontSize: '0.875rem',
    cursor: 'pointer',
    transitionProperty: 'all',
    transitionDuration: '0.2s',
    ':hover': {
      border: '1px solid #e94560',
      color: '#eee',
    },
    '@media (max-width: 640px)': {
      flex: 1,
      minWidth: '80px',
      textAlign: 'center',
    },
  },
  filterBtnActive: {
    backgroundColor: '#e94560',
    border: '1px solid #e94560',
    color: 'white',
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
  },
  item: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '0.75rem',
    backgroundColor: '#16213e',
    border: '1px solid #0f3460',
    borderRadius: '0.5rem',
    padding: '1rem',
    transitionProperty: 'all',
    transitionDuration: '0.2s',
  },
  itemAcknowledged: {
    opacity: 0.6,
  },
  itemSelected: {
    border: '1px solid #e94560',
    backgroundColor: 'rgba(233, 69, 96, 0.1)',
  },
  checkbox: {
    flexShrink: 0,
    width: '16px',
    height: '16px',
    marginTop: '2px',
    accentColor: '#e94560',
    cursor: 'pointer',
  },
  content: {
    flex: 1,
    minWidth: 0,
  },
  eventType: {
    fontWeight: '500',
    marginBottom: '0.25rem',
    color: '#fff',
  },
  meta: {
    display: 'flex',
    gap: '1rem',
    fontSize: '0.75rem',
    color: '#888',
    '@media (max-width: 640px)': {
      flexDirection: 'column',
      gap: '0.25rem',
    },
  },
  deviceLink: {
    color: '#e94560',
    textDecoration: 'none',
    ':hover': {
      textDecoration: 'underline',
    },
  },
  time: {
    color: '#666',
  },
  data: {
    marginTop: '0.75rem',
  },
  dataSummary: {
    cursor: 'pointer',
    fontSize: '0.75rem',
    color: '#888',
    userSelect: 'none',
    ':hover': {
      color: '#ccc',
    },
  },
  dataPre: {
    margin: '0.5rem 0 0',
    fontSize: '0.75rem',
    color: '#aaa',
    backgroundColor: 'rgba(0, 0, 0, 0.3)',
    padding: '0.75rem',
    borderRadius: '0.25rem',
    overflowX: 'auto',
    maxHeight: '200px',
  },
});

export function EventsPage() {
  const styles = useStyles();
  const [filter, setFilter] = useState<FilterType>('all');
  const [realtimeEvents, setRealtimeEvents] = useState<DeviceEvent[]>([]);
  const [selectedEvents, setSelectedEvents] = useState<Set<string>>(new Set());

  const filters = useMemo(() => {
    if (filter === 'all') return undefined;
    if (filter === 'unread') return { acknowledged: false };
    return { severity: filter };
  }, [filter]);

  const { events, loading, error, refresh, acknowledge, acknowledgeMultiple } = useEvents(filters);

  // Handle real-time events
  const handleNewEvent = useCallback((event: DeviceEvent) => {
    setRealtimeEvents((prev) => {
      // Avoid duplicates
      if (prev.some((e) => e.id === event.id)) return prev;
      return [event, ...prev];
    });
  }, []);

  const { connected } = useRealtimeEvents(handleNewEvent);

  // Merge realtime events with fetched events
  const displayEvents = useMemo(() => {
    const combined = [...realtimeEvents, ...(events || [])];
    // Remove duplicates and sort by createdAt
    const unique = Array.from(new Map(combined.map((e) => [e.id, e])).values());
    return unique.sort((a, b) => b.createdAt - a.createdAt);
  }, [realtimeEvents, events]);

  const handleAcknowledge = async (eventId: string) => {
    try {
      await acknowledge(eventId);
      setRealtimeEvents((prev) =>
        prev.map((e) => (e.id === eventId ? { ...e, acknowledged: true } : e))
      );
    } catch (err) {
      console.error('Failed to acknowledge event:', err);
    }
  };

  const handleBulkAcknowledge = async () => {
    if (selectedEvents.size === 0) return;
    try {
      await acknowledgeMultiple(Array.from(selectedEvents));
      setRealtimeEvents((prev) =>
        prev.map((e) =>
          selectedEvents.has(e.id) ? { ...e, acknowledged: true } : e
        )
      );
      setSelectedEvents(new Set());
    } catch (err) {
      console.error('Failed to acknowledge events:', err);
    }
  };

  const toggleSelect = (eventId: string) => {
    setSelectedEvents((prev) => {
      const next = new Set(prev);
      if (next.has(eventId)) {
        next.delete(eventId);
      } else {
        next.add(eventId);
      }
      return next;
    });
  };

  const selectAllUnread = () => {
    const unreadIds = displayEvents
      .filter((e) => !e.acknowledged)
      .map((e) => e.id);
    setSelectedEvents(new Set(unreadIds));
  };

  const severityVariant = (severity: string): 'error' | 'warning' | 'info' => {
    switch (severity) {
      case 'critical': return 'error';
      case 'warning': return 'warning';
      default: return 'info';
    }
  };

  if (loading && !events) {
    return (
      <div className={styles.root}>
        <div className={styles.loading}>
          <Spinner size="lg" />
          <p>Loading events...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={styles.root}>
        <EmptyState
          title="Error loading events"
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
          <h1 className={styles.headerTitle}>Events</h1>
          <p className={styles.subtitle}>
            {connected ? (
              <span className={styles.live}>Live updates enabled</span>
            ) : (
              <span className={styles.offline}>Reconnecting...</span>
            )}
          </p>
        </div>
        <div className={styles.actions}>
          {selectedEvents.size > 0 && (
            <Button onClick={handleBulkAcknowledge}>
              Acknowledge ({selectedEvents.size})
            </Button>
          )}
          <Button variant="ghost" onClick={selectAllUnread}>
            Select Unread
          </Button>
        </div>
      </div>

      <div className={styles.filters}>
        {(['all', 'unread', 'critical', 'warning', 'info'] as FilterType[]).map((f) => (
          <button
            key={f}
            className={mergeClasses(styles.filterBtn, filter === f && styles.filterBtnActive)}
            onClick={() => setFilter(f)}
          >
            {f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>

      {displayEvents.length === 0 ? (
        <EmptyState
          title="No events"
          description={filter === 'all' ? 'No events have been recorded yet' : `No ${filter} events`}
        />
      ) : (
        <div className={styles.list}>
          {displayEvents.map((event) => (
            <div
              key={event.id}
              className={mergeClasses(
                styles.item,
                event.acknowledged && styles.itemAcknowledged,
                selectedEvents.has(event.id) && styles.itemSelected
              )}
            >
              <input
                type="checkbox"
                checked={selectedEvents.has(event.id)}
                onChange={() => toggleSelect(event.id)}
                className={styles.checkbox}
              />
              <Badge variant={severityVariant(event.severity)} size="sm">
                {event.severity}
              </Badge>
              <div className={styles.content}>
                <div className={styles.eventType}>{event.eventType}</div>
                <div className={styles.meta}>
                  <Link to={`/devices/${event.deviceId}`} className={styles.deviceLink}>
                    {event.deviceId.slice(0, 12)}...
                  </Link>
                  <span className={styles.time}>
                    {new Date(event.createdAt).toLocaleString()}
                  </span>
                </div>
                {event.data && Object.keys(event.data).length > 0 && (
                  <details className={styles.data}>
                    <summary className={styles.dataSummary}>Details</summary>
                    <pre className={styles.dataPre}>{JSON.stringify(event.data, null, 2)}</pre>
                  </details>
                )}
              </div>
              {!event.acknowledged && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleAcknowledge(event.id)}
                >
                  Ack
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
