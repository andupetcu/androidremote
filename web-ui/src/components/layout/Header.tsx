import { useLocation, Link, useNavigate } from 'react-router-dom';
import {
  makeStyles,
  mergeClasses,
  tokens,
  CounterBadge,
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbDivider,
  BreadcrumbButton,
  Button,
} from '@fluentui/react-components';
import { AlertRegular, SignOutRegular, NavigationRegular } from '@fluentui/react-icons';
import { useAuth } from '../../hooks/useAuth';

interface HeaderProps {
  unreadEvents?: number;
  onNotificationClick?: () => void;
  onMenuClick?: () => void;
}

const routeTitles: Record<string, string> = {
  '/': 'Dashboard',
  '/devices': 'Devices',
  '/groups': 'Groups',
  '/policies': 'Policies',
  '/events': 'Events',
  '/apps': 'Applications',
  '/audit': 'Audit Log',
  '/settings': 'Settings',
};

function getBreadcrumbs(pathname: string): { label: string; path: string }[] {
  const parts = pathname.split('/').filter(Boolean);
  const breadcrumbs: { label: string; path: string }[] = [];

  if (parts.length === 0) {
    return [{ label: 'Dashboard', path: '/' }];
  }

  let currentPath = '';
  for (const part of parts) {
    currentPath += `/${part}`;
    const title = routeTitles[currentPath];
    if (title) {
      breadcrumbs.push({ label: title, path: currentPath });
    } else {
      // Handle dynamic segments like device IDs
      const parentPath = currentPath.split('/').slice(0, -1).join('/') || '/';
      const parentTitle = routeTitles[parentPath];
      if (parentTitle) {
        breadcrumbs.push({ label: part, path: currentPath });
      }
    }
  }

  return breadcrumbs.length > 0 ? breadcrumbs : [{ label: 'Dashboard', path: '/' }];
}

const useStyles = makeStyles({
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 24px',
    backgroundColor: tokens.colorNeutralBackground1,
    borderBottom: `1px solid ${tokens.colorNeutralStroke1}`,
    minHeight: '56px',
  },
  breadcrumbs: {
    display: 'flex',
    alignItems: 'center',
  },
  breadcrumbItem: {
    color: tokens.colorNeutralForeground2,
    fontSize: '14px',
  },
  breadcrumbCurrent: {
    color: tokens.colorNeutralForeground1,
    fontWeight: 600,
  },
  breadcrumbLink: {
    color: tokens.colorNeutralForeground2,
    textDecoration: 'none',
    ':hover': {
      color: tokens.colorBrandForeground1,
      textDecoration: 'underline',
    },
  },
  actions: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  notificationButton: {
    position: 'relative',
    minWidth: '40px',
    height: '40px',
    padding: '8px',
    color: tokens.colorNeutralForeground2,
    ':hover': {
      color: tokens.colorNeutralForeground1,
    },
  },
  badge: {
    position: 'absolute',
    top: '4px',
    right: '4px',
  },
  menuButton: {
    display: 'none',
    minWidth: '40px',
    height: '40px',
    padding: '8px',
    color: tokens.colorNeutralForeground2,
    '@media (max-width: 768px)': {
      display: 'inline-flex',
    },
  },
  headerMobile: {
    '@media (max-width: 768px)': {
      padding: '12px 12px',
    },
  },
});

export function Header({ unreadEvents = 0, onNotificationClick, onMenuClick }: HeaderProps) {
  const styles = useStyles();
  const location = useLocation();
  const navigate = useNavigate();
  const { username, logout } = useAuth();
  const breadcrumbs = getBreadcrumbs(location.pathname);

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  return (
    <header className={mergeClasses(styles.header, styles.headerMobile)}>
      {onMenuClick && (
        <Button
          appearance="subtle"
          className={styles.menuButton}
          onClick={onMenuClick}
          icon={<NavigationRegular />}
          aria-label="Open menu"
        />
      )}
      <Breadcrumb className={styles.breadcrumbs}>
        {breadcrumbs.map((crumb, index) => (
          <span key={crumb.path}>
            {index > 0 && <BreadcrumbDivider />}
            <BreadcrumbItem>
              {index === breadcrumbs.length - 1 ? (
                <BreadcrumbButton current className={styles.breadcrumbCurrent}>
                  {crumb.label}
                </BreadcrumbButton>
              ) : (
                <Link to={crumb.path} className={styles.breadcrumbLink}>
                  <BreadcrumbButton>{crumb.label}</BreadcrumbButton>
                </Link>
              )}
            </BreadcrumbItem>
          </span>
        ))}
      </Breadcrumb>

      <div className={styles.actions}>
        <Button
          appearance="subtle"
          className={styles.notificationButton}
          onClick={onNotificationClick}
          icon={<AlertRegular />}
          aria-label={`Notifications${unreadEvents > 0 ? ` (${unreadEvents} unread)` : ''}`}
        >
          {unreadEvents > 0 && (
            <CounterBadge
              count={unreadEvents}
              color="danger"
              size="small"
              overflowCount={99}
              className={styles.badge}
            />
          )}
        </Button>
        {username && (
          <Button
            appearance="subtle"
            icon={<SignOutRegular />}
            onClick={handleLogout}
          >
            {username}
          </Button>
        )}
      </div>
    </header>
  );
}
