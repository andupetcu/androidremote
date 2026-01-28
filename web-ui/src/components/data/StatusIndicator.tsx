import {
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import {
  WarningFilled,
  ErrorCircleFilled,
} from '@fluentui/react-icons';

export interface StatusIndicatorProps {
  status: 'online' | 'offline' | 'warning' | 'error';
  label?: string;
  pulse?: boolean;
}

const useStyles = makeStyles({
  container: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '8px',
  },
  dot: {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    flexShrink: 0,
  },
  dotOnline: {
    backgroundColor: tokens.colorPaletteGreenForeground1,
  },
  dotOffline: {
    backgroundColor: tokens.colorNeutralForeground3,
  },
  dotWarning: {
    backgroundColor: tokens.colorPaletteYellowForeground1,
  },
  dotError: {
    backgroundColor: tokens.colorPaletteRedForeground1,
  },
  pulse: {
    animationName: {
      '0%': {
        boxShadow: '0 0 0 0 currentColor',
        opacity: 1,
      },
      '70%': {
        boxShadow: '0 0 0 6px currentColor',
        opacity: 0,
      },
      '100%': {
        boxShadow: '0 0 0 0 currentColor',
        opacity: 0,
      },
    },
    animationDuration: '1.5s',
    animationIterationCount: 'infinite',
    animationTimingFunction: 'ease-out',
  },
  pulseOnline: {
    color: 'rgba(34, 197, 94, 0.4)',
  },
  pulseWarning: {
    color: 'rgba(234, 179, 8, 0.4)',
  },
  pulseError: {
    color: 'rgba(239, 68, 68, 0.4)',
  },
  label: {
    fontSize: '13px',
    color: tokens.colorNeutralForeground2,
  },
  icon: {
    width: '16px',
    height: '16px',
    flexShrink: 0,
  },
  iconOnline: {
    color: tokens.colorPaletteGreenForeground1,
  },
  iconOffline: {
    color: tokens.colorNeutralForeground3,
  },
  iconWarning: {
    color: tokens.colorPaletteYellowForeground1,
  },
  iconError: {
    color: tokens.colorPaletteRedForeground1,
  },
});

export function StatusIndicator({ status, label, pulse = false }: StatusIndicatorProps) {
  const styles = useStyles();

  const dotClass = {
    online: styles.dotOnline,
    offline: styles.dotOffline,
    warning: styles.dotWarning,
    error: styles.dotError,
  }[status];

  const pulseClass = pulse ? {
    online: styles.pulseOnline,
    offline: undefined,
    warning: styles.pulseWarning,
    error: styles.pulseError,
  }[status] : undefined;

  const iconClass = {
    online: styles.iconOnline,
    offline: styles.iconOffline,
    warning: styles.iconWarning,
    error: styles.iconError,
  }[status];

  // Use icon for warning/error, dot for online/offline
  const showIcon = status === 'warning' || status === 'error';

  return (
    <span className={styles.container}>
      {showIcon ? (
        <span className={mergeClasses(styles.icon, iconClass)}>
          {status === 'warning' ? <WarningFilled /> : <ErrorCircleFilled />}
        </span>
      ) : (
        <span className={mergeClasses(
          styles.dot,
          dotClass,
          pulse && styles.pulse,
          pulseClass
        )} />
      )}
      {label && <span className={styles.label}>{label}</span>}
    </span>
  );
}
