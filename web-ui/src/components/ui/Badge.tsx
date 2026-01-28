import {
  Badge as FluentBadge,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import type { ReactNode } from 'react';

export interface BadgeProps {
  variant?: 'info' | 'success' | 'warning' | 'error' | 'neutral';
  size?: 'sm' | 'md';
  children: ReactNode;
}

const useStyles = makeStyles({
  base: {
    fontWeight: 500,
    borderRadius: '4px',
  },
  sm: {
    fontSize: '11px',
    padding: '2px 6px',
    height: 'auto',
  },
  md: {
    fontSize: '12px',
    padding: '4px 8px',
    height: 'auto',
  },
  info: {
    backgroundColor: 'rgba(59, 130, 246, 0.15)',
    color: '#60a5fa',
  },
  success: {
    backgroundColor: tokens.colorPaletteGreenBackground1,
    color: tokens.colorPaletteGreenForeground1,
  },
  warning: {
    backgroundColor: tokens.colorPaletteYellowBackground1,
    color: tokens.colorPaletteYellowForeground1,
  },
  error: {
    backgroundColor: tokens.colorPaletteRedBackground1,
    color: tokens.colorPaletteRedForeground1,
  },
  neutral: {
    backgroundColor: 'rgba(136, 136, 136, 0.15)',
    color: tokens.colorNeutralForeground2,
  },
});

export function Badge({ variant = 'neutral', size = 'md', children }: BadgeProps) {
  const styles = useStyles();

  const sizeClass = styles[size];
  const variantClass = styles[variant];

  return (
    <FluentBadge
      appearance="filled"
      className={mergeClasses(styles.base, sizeClass, variantClass)}
    >
      {children}
    </FluentBadge>
  );
}
