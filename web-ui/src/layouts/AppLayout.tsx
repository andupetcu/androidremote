import { useState, useEffect, useRef, useCallback } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { makeStyles, tokens } from '@fluentui/react-components';
import { Sidebar } from '../components/layout/Sidebar';
import { Header } from '../components/layout/Header';
import { useEventStats } from '../hooks/useEvents';
import { useSettings } from '../hooks/useSettings';

const MOBILE_BREAKPOINT = 768;

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
    minWidth: 0,
  },
  content: {
    flex: 1,
    padding: '24px',
    overflowY: 'auto',
    '@media (max-width: 768px)': {
      padding: '12px',
    },
  },
  backdrop: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    zIndex: 999,
  },
});

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth <= MOBILE_BREAKPOINT);

  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);

  return isMobile;
}

export function AppLayout() {
  const styles = useStyles();
  const isMobile = useIsMobile();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { stats } = useEventStats();
  const unreadEvents = stats?.unacknowledged ?? 0;
  const navigate = useNavigate();
  const location = useLocation();
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

  // Close mobile sidebar on route change
  useEffect(() => {
    if (isMobile) {
      setSidebarOpen(false);
    }
  }, [location.pathname, isMobile]);

  const handleNotificationClick = () => {
    navigate('/events');
  };

  const handleMenuClick = useCallback(() => {
    setSidebarOpen(prev => !prev);
  }, []);

  // On mobile: sidebar is hidden by default, shown as overlay when open
  // On desktop: sidebar uses collapsed state as before
  const showSidebar = isMobile ? sidebarOpen : true;

  return (
    <div className={styles.layout}>
      {isMobile && sidebarOpen && (
        <div className={styles.backdrop} onClick={() => setSidebarOpen(false)} />
      )}
      {showSidebar && (
        <Sidebar
          collapsed={isMobile ? false : sidebarCollapsed}
          onToggle={isMobile ? () => setSidebarOpen(false) : () => setSidebarCollapsed(!sidebarCollapsed)}
          unreadEvents={unreadEvents}
          serverName={settings.serverName}
          isMobile={isMobile}
        />
      )}
      <div className={styles.main}>
        <Header
          unreadEvents={unreadEvents}
          onNotificationClick={handleNotificationClick}
          onMenuClick={isMobile ? handleMenuClick : undefined}
        />
        <main className={styles.content}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
