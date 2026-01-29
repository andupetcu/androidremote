import { useState, useEffect, useRef } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { makeStyles, tokens } from '@fluentui/react-components';
import { Sidebar } from '../components/layout/Sidebar';
import { Header } from '../components/layout/Header';
import { useEventStats } from '../hooks/useEvents';
import { useSettings } from '../hooks/useSettings';

const useStyles = makeStyles({
  layout: {
    display: 'flex',
    minHeight: '100vh',
    backgroundColor: tokens.colorNeutralBackground1,
  },
  main: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0, // Prevent flex children from overflowing
  },
  content: {
    flex: 1,
    padding: '24px',
    overflowY: 'auto',
  },
  // Responsive adjustments would need a different approach in Fluent UI
  // For now, we maintain the base layout
});

export function AppLayout() {
  const styles = useStyles();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const { stats } = useEventStats();
  const unreadEvents = stats?.unacknowledged ?? 0;
  const navigate = useNavigate();
  const mountIdRef = useRef(Math.random().toString(36).slice(2, 8));
  const { settings } = useSettings();

  // Update browser tab title when server name changes
  useEffect(() => {
    document.title = settings.serverName;
  }, [settings.serverName]);

  // Track AppLayout mounts
  useEffect(() => {
    console.log('[AppLayout] MOUNTED, id:', mountIdRef.current);
    return () => {
      console.log('[AppLayout] UNMOUNTED, id:', mountIdRef.current);
    };
  }, []);

  const handleNotificationClick = () => {
    navigate('/events');
  };

  return (
    <div className={styles.layout}>
      <Sidebar
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed(!sidebarCollapsed)}
        unreadEvents={unreadEvents}
        serverName={settings.serverName}
      />
      <div className={styles.main}>
        <Header
          unreadEvents={unreadEvents}
          onNotificationClick={handleNotificationClick}
        />
        <main className={styles.content}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
