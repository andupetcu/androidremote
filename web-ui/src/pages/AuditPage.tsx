import { useState, useMemo } from 'react';
import { makeStyles } from '@fluentui/react-components';
import { useAudit } from '../hooks/useAudit';
import { Button } from '../components/ui/Button';
import { Badge } from '../components/ui/Badge';
import { Spinner } from '../components/ui/Spinner';
import { EmptyState } from '../components/ui/EmptyState';
import type { AuditAction, ActorType, ResourceType } from '../types/api';

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
    marginBottom: '1.5rem',
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
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
  },
  item: {
    backgroundColor: '#16213e',
    border: '1px solid #0f3460',
    borderRadius: '0.5rem',
    overflow: 'hidden',
  },
  itemHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '1rem',
    padding: '1rem',
    cursor: 'pointer',
    transitionProperty: 'background',
    transitionDuration: '0.2s',
    ':hover': {
      backgroundColor: 'rgba(233, 69, 96, 0.05)',
    },
    '@media (max-width: 900px)': {
      flexWrap: 'wrap',
    },
  },
  timestamp: {
    fontSize: '0.75rem',
    color: '#888',
    minWidth: '140px',
  },
  action: {
    flex: 1,
    fontFamily: 'monospace',
    fontSize: '0.875rem',
    color: '#e94560',
    '@media (max-width: 900px)': {
      order: 3,
      width: '100%',
      marginTop: '0.5rem',
    },
  },
  resource: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
  },
  resourceIcon: {
    width: '24px',
    height: '24px',
    backgroundColor: '#0f3460',
    borderRadius: '4px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '0.75rem',
    fontWeight: '600',
    color: '#888',
  },
  resourceType: {
    fontSize: '0.75rem',
    color: '#888',
    textTransform: 'capitalize',
  },
  resourceId: {
    fontSize: '0.75rem',
    color: '#666',
    fontFamily: 'monospace',
  },
  details: {
    backgroundColor: 'rgba(0, 0, 0, 0.2)',
    padding: '1rem',
    borderTop: '1px solid #0f3460',
  },
  detailsPre: {
    margin: 0,
    fontSize: '0.75rem',
    color: '#aaa',
    whiteSpace: 'pre-wrap',
    overflowX: 'auto',
  },
  ip: {
    marginTop: '0.75rem',
    fontSize: '0.75rem',
    color: '#666',
  },
});

export function AuditPage() {
  const styles = useStyles();
  const [actionFilter, setActionFilter] = useState<string>('all');
  const [actorFilter, setActorFilter] = useState<string>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const filters = useMemo(() => {
    const f: { action?: AuditAction; actorType?: ActorType } = {};
    if (actionFilter !== 'all') f.action = actionFilter as AuditAction;
    if (actorFilter !== 'all') f.actorType = actorFilter as ActorType;
    return Object.keys(f).length > 0 ? f : undefined;
  }, [actionFilter, actorFilter]);

  const { logs, loading, error, refresh, exportCsv } = useAudit(filters);

  const handleExport = async () => {
    try {
      await exportCsv();
    } catch (err) {
      console.error('Failed to export audit logs:', err);
    }
  };

  const actorVariant = (actorType: string): 'info' | 'success' | 'warning' => {
    switch (actorType) {
      case 'admin': return 'info';
      case 'device': return 'success';
      default: return 'warning';
    }
  };

  const resourceIcon = (resourceType: ResourceType): string => {
    const icons: Record<ResourceType, string> = {
      device: 'D',
      policy: 'P',
      group: 'G',
      command: 'C',
      app: 'A',
      token: 'T',
      file: 'F',
      event: 'E',
    };
    return icons[resourceType] || '?';
  };

  if (loading) {
    return (
      <div className={styles.root}>
        <div className={styles.loading}>
          <Spinner size="lg" />
          <p>Loading audit logs...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={styles.root}>
        <EmptyState
          title="Error loading audit logs"
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
          <h1 className={styles.headerTitle}>Audit Log</h1>
          <p className={styles.subtitle}>
            Track all actions and changes in your MDM system
          </p>
        </div>
        <Button onClick={handleExport}>Export CSV</Button>
      </div>

      <div className={styles.filters}>
        <select
          value={actorFilter}
          onChange={(e) => setActorFilter(e.target.value)}
          className={styles.select}
        >
          <option value="all">All Actors</option>
          <option value="admin">Admin</option>
          <option value="device">Device</option>
          <option value="system">System</option>
        </select>
        <select
          value={actionFilter}
          onChange={(e) => setActionFilter(e.target.value)}
          className={styles.select}
        >
          <option value="all">All Actions</option>
          <option value="device.enrolled">Device Enrolled</option>
          <option value="device.unenrolled">Device Unenrolled</option>
          <option value="command.queued">Command Queued</option>
          <option value="command.completed">Command Completed</option>
          <option value="policy.created">Policy Created</option>
          <option value="policy.updated">Policy Updated</option>
          <option value="group.created">Group Created</option>
          <option value="app.approved">App Approved</option>
          <option value="app.blocked">App Blocked</option>
        </select>
      </div>

      {logs.length === 0 ? (
        <EmptyState
          title="No audit logs"
          description="No audit logs match the current filters"
        />
      ) : (
        <div className={styles.list}>
          {logs.map((log) => (
            <div key={log.id} className={styles.item}>
              <div
                className={styles.itemHeader}
                onClick={() => setExpandedId(expandedId === log.id ? null : log.id)}
              >
                <div className={styles.timestamp}>
                  {new Date(log.timestamp).toLocaleString()}
                </div>
                <Badge variant={actorVariant(log.actorType)} size="sm">
                  {log.actorType}
                </Badge>
                <div className={styles.action}>{log.action}</div>
                <div className={styles.resource}>
                  <span className={styles.resourceIcon}>
                    {resourceIcon(log.resourceType)}
                  </span>
                  <span className={styles.resourceType}>{log.resourceType}</span>
                  {log.resourceId && (
                    <span className={styles.resourceId}>
                      {log.resourceId.slice(0, 8)}...
                    </span>
                  )}
                </div>
                {log.details && (
                  <Button variant="ghost" size="sm">
                    {expandedId === log.id ? '−' : '+'}
                  </Button>
                )}
              </div>
              {expandedId === log.id && log.details && (
                <div className={styles.details}>
                  <pre className={styles.detailsPre}>{JSON.stringify(log.details, null, 2)}</pre>
                  {log.ipAddress && (
                    <div className={styles.ip}>IP: {log.ipAddress}</div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
