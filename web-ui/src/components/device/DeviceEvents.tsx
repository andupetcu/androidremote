import { useMemo } from 'react';
import { useEvents } from '../../hooks/useEvents';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { Spinner } from '../ui/Spinner';
import { EmptyState } from '../ui/EmptyState';
import type { EventSeverity } from '../../types/api';
import './DeviceComponents.css';

interface DeviceEventsProps {
  deviceId: string;
}

export function DeviceEvents({ deviceId }: DeviceEventsProps) {
  const filters = useMemo(() => ({ deviceId }), [deviceId]);
  const { events, loading, error, refresh, acknowledge } = useEvents(filters);

  const severityVariant = (severity: EventSeverity): 'error' | 'warning' | 'info' => {
    switch (severity) {
      case 'critical': return 'error';
      case 'warning': return 'warning';
      default: return 'info';
    }
  };

  const handleAcknowledge = async (eventId: string) => {
    try {
      await acknowledge(eventId);
    } catch (err) {
      console.error('Failed to acknowledge event:', err);
    }
  };

  if (loading) {
    return (
      <div className="device-tab__loading">
        <Spinner size="md" />
        <p>Loading events...</p>
      </div>
    );
  }

  if (error) {
    return (
      <EmptyState
        title="Error loading events"
        description={error}
        action={<Button onClick={refresh}>Retry</Button>}
      />
    );
  }

  if (events.length === 0) {
    return (
      <EmptyState
        title="No events"
        description="No events recorded for this device"
      />
    );
  }

  return (
    <div className="device-events">
      <div className="device-events__header">
        <span className="device-events__count">{events.length} events</span>
        <Button variant="ghost" size="sm" onClick={refresh}>
          Refresh
        </Button>
      </div>
      <div className="device-events__list">
        {events.map((event) => (
          <div
            key={event.id}
            className={`device-events__item ${event.acknowledged ? 'device-events__item--acknowledged' : ''}`}
          >
            <div className="device-events__item-header">
              <Badge variant={severityVariant(event.severity)} size="sm">
                {event.severity}
              </Badge>
              <span className="device-events__type">{event.eventType}</span>
              <span className="device-events__time">
                {new Date(event.createdAt).toLocaleString()}
              </span>
              {!event.acknowledged && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleAcknowledge(event.id)}
                >
                  Acknowledge
                </Button>
              )}
            </div>
            {event.data && Object.keys(event.data).length > 0 && (
              <details className="device-events__data">
                <summary>Event Data</summary>
                <pre>{JSON.stringify(event.data, null, 2)}</pre>
              </details>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
