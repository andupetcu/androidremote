import { NavLink } from 'react-router-dom';
import {
  makeStyles,
  mergeClasses,
  tokens,
  CounterBadge,
} from '@fluentui/react-components';
import {
  GridRegular,
  GridFilled,
  PhoneRegular,
  PhoneFilled,
  FolderRegular,
  FolderFilled,
  DocumentTextRegular,
  DocumentTextFilled,
  AlertRegular,
  AlertFilled,
  AppsRegular,
  AppsFilled,
  HistoryRegular,
  HistoryFilled,
  SettingsRegular,
  SettingsFilled,
  ChevronLeftRegular,
  ChevronRightRegular,
} from '@fluentui/react-icons';
import type { ReactElement } from 'react';

interface NavItem {
  path: string;
  label: string;
  icon: ReactElement;
  iconActive: ReactElement;
}

const navItems: NavItem[] = [
  { path: '/', label: 'Dashboard', icon: <GridRegular />, iconActive: <GridFilled /> },
  { path: '/devices', label: 'Devices', icon: <PhoneRegular />, iconActive: <PhoneFilled /> },
  { path: '/groups', label: 'Groups', icon: <FolderRegular />, iconActive: <FolderFilled /> },
  { path: '/policies', label: 'Policies', icon: <DocumentTextRegular />, iconActive: <DocumentTextFilled /> },
  { path: '/events', label: 'Events', icon: <AlertRegular />, iconActive: <AlertFilled /> },
  { path: '/apps', label: 'Apps', icon: <AppsRegular />, iconActive: <AppsFilled /> },
  { path: '/audit', label: 'Audit', icon: <HistoryRegular />, iconActive: <HistoryFilled /> },
  { path: '/settings', label: 'Settings', icon: <SettingsRegular />, iconActive: <SettingsFilled /> },
];

interface SidebarProps {
  collapsed?: boolean;
  onToggle?: () => void;
  unreadEvents?: number;
}

const useStyles = makeStyles({
  sidebar: {
    display: 'flex',
    flexDirection: 'column',
    width: '240px',
    height: '100vh',
    backgroundColor: tokens.colorNeutralBackground2,
    borderRight: `1px solid ${tokens.colorNeutralStroke1}`,
    transition: 'width 200ms ease-in-out',
  },
  sidebarCollapsed: {
    width: '64px',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '16px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke1}`,
    minHeight: '64px',
  },
  logo: {
    fontSize: '18px',
    fontWeight: 700,
    color: tokens.colorBrandForeground1,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
  },
  logoCollapsed: {
    fontSize: '16px',
  },
  toggleButton: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '32px',
    height: '32px',
    padding: 0,
    backgroundColor: 'transparent',
    border: 'none',
    borderRadius: '4px',
    color: tokens.colorNeutralForeground2,
    cursor: 'pointer',
    transition: 'all 150ms ease',
    flexShrink: 0,
    ':hover': {
      backgroundColor: tokens.colorSubtleBackgroundHover,
      color: tokens.colorNeutralForeground1,
    },
  },
  nav: {
    flex: 1,
    padding: '8px',
    overflowY: 'auto',
  },
  link: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '10px 12px',
    marginBottom: '4px',
    borderRadius: '6px',
    color: tokens.colorNeutralForeground2,
    textDecoration: 'none',
    fontSize: '14px',
    fontWeight: 500,
    transition: 'all 150ms ease',
    ':hover': {
      backgroundColor: tokens.colorSubtleBackgroundHover,
      color: tokens.colorNeutralForeground1,
    },
  },
  linkActive: {
    backgroundColor: tokens.colorSubtleBackgroundSelected,
    color: tokens.colorBrandForeground1,
  },
  linkCollapsed: {
    justifyContent: 'center',
    padding: '12px',
  },
  icon: {
    width: '20px',
    height: '20px',
    flexShrink: 0,
  },
  label: {
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  badge: {
    marginLeft: 'auto',
  },
  footer: {
    padding: '16px',
    borderTop: `1px solid ${tokens.colorNeutralStroke1}`,
  },
  version: {
    fontSize: '12px',
    color: tokens.colorNeutralForeground3,
  },
});

export function Sidebar({ collapsed = false, onToggle, unreadEvents = 0 }: SidebarProps) {
  const styles = useStyles();

  return (
    <aside className={mergeClasses(styles.sidebar, collapsed && styles.sidebarCollapsed)}>
      <div className={styles.header}>
        <div className={mergeClasses(styles.logo, collapsed && styles.logoCollapsed)}>
          {collapsed ? 'AR' : 'Android Remote'}
        </div>
        <button
          className={styles.toggleButton}
          onClick={onToggle}
          aria-label="Toggle sidebar"
        >
          {collapsed ? <ChevronRightRegular /> : <ChevronLeftRegular />}
        </button>
      </div>

      <nav className={styles.nav}>
        {navItems.map((item) => (
          <NavLink
            key={item.path}
            to={item.path}
            end={item.path === '/'}
            className={({ isActive }) =>
              mergeClasses(
                styles.link,
                isActive && styles.linkActive,
                collapsed && styles.linkCollapsed
              )
            }
            title={collapsed ? item.label : undefined}
          >
            {({ isActive }) => (
              <>
                <span className={styles.icon}>
                  {isActive ? item.iconActive : item.icon}
                </span>
                {!collapsed && <span className={styles.label}>{item.label}</span>}
                {item.path === '/events' && unreadEvents > 0 && !collapsed && (
                  <CounterBadge
                    count={unreadEvents}
                    color="danger"
                    size="small"
                    overflowCount={99}
                    className={styles.badge}
                  />
                )}
              </>
            )}
          </NavLink>
        ))}
      </nav>

      <div className={styles.footer}>
        {!collapsed && (
          <div className={styles.version}>v0.1.0</div>
        )}
      </div>
    </aside>
  );
}
