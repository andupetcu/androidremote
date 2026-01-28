import {
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import { ArrowUpRegular, ArrowDownRegular } from '@fluentui/react-icons';
import type { ReactNode } from 'react';

export interface StatCardProps {
  label: string;
  value: string | number;
  icon?: ReactNode;
  trend?: {
    value: number;
    direction: 'up' | 'down';
  };
  variant?: 'default' | 'success' | 'warning' | 'error';
}

const useStyles = makeStyles({
  card: {
    display: 'flex',
    alignItems: 'center',
    gap: '16px',
    padding: '20px',
    backgroundColor: tokens.colorNeutralBackground2,
    borderRadius: '8px',
    border: `1px solid ${tokens.colorNeutralStroke1}`,
  },
  icon: {
    fontSize: '32px',
    flexShrink: 0,
  },
  fluentIcon: {
    width: '32px',
    height: '32px',
    flexShrink: 0,
    color: tokens.colorNeutralForeground3,
  },
  content: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    minWidth: 0,
  },
  value: {
    fontSize: '28px',
    fontWeight: 700,
    color: tokens.colorNeutralForeground1,
    lineHeight: 1.2,
  },
  label: {
    fontSize: '13px',
    fontWeight: 500,
    color: tokens.colorNeutralForeground2,
  },
  trend: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    fontSize: '12px',
    fontWeight: 500,
  },
  trendUp: {
    color: tokens.colorPaletteGreenForeground1,
  },
  trendDown: {
    color: tokens.colorPaletteRedForeground1,
  },
  // Variant accents
  variantSuccess: {
    borderLeftWidth: '4px',
    borderLeftStyle: 'solid',
    borderLeftColor: tokens.colorPaletteGreenBorder1,
  },
  variantWarning: {
    borderLeftWidth: '4px',
    borderLeftStyle: 'solid',
    borderLeftColor: tokens.colorPaletteYellowBorder1,
  },
  variantError: {
    borderLeftWidth: '4px',
    borderLeftStyle: 'solid',
    borderLeftColor: tokens.colorPaletteRedBorder1,
  },
});

export function StatCard({ label, value, icon, trend, variant = 'default' }: StatCardProps) {
  const styles = useStyles();

  const variantClass = {
    default: undefined,
    success: styles.variantSuccess,
    warning: styles.variantWarning,
    error: styles.variantError,
  }[variant];

  // Determine if icon is a string (emoji) or React node
  const isEmojiIcon = typeof icon === 'string';

  return (
    <div className={mergeClasses(styles.card, variantClass)}>
      {icon && (
        isEmojiIcon ? (
          <span className={styles.icon}>{icon}</span>
        ) : (
          <span className={styles.fluentIcon}>{icon}</span>
        )
      )}
      <div className={styles.content}>
        <span className={styles.value}>{value}</span>
        <span className={styles.label}>{label}</span>
        {trend && (
          <span className={mergeClasses(
            styles.trend,
            trend.direction === 'up' ? styles.trendUp : styles.trendDown
          )}>
            {trend.direction === 'up' ? (
              <ArrowUpRegular />
            ) : (
              <ArrowDownRegular />
            )}
            {Math.abs(trend.value)}%
          </span>
        )}
      </div>
    </div>
  );
}
