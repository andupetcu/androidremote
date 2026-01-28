import type { ButtonHTMLAttributes, ReactNode, ReactElement } from 'react';
import { forwardRef } from 'react';
import {
  Button as FluentButton,
  Spinner,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  children?: ReactNode;
  icon?: ReactElement;
}

const useStyles = makeStyles({
  // Size variants
  sm: {
    minWidth: 'auto',
    paddingLeft: '12px',
    paddingRight: '12px',
    paddingTop: '4px',
    paddingBottom: '4px',
    fontSize: '12px',
    height: '28px',
  },
  md: {
    minWidth: 'auto',
    paddingLeft: '16px',
    paddingRight: '16px',
    paddingTop: '6px',
    paddingBottom: '6px',
    fontSize: '14px',
    height: '36px',
  },
  lg: {
    minWidth: 'auto',
    paddingLeft: '24px',
    paddingRight: '24px',
    paddingTop: '10px',
    paddingBottom: '10px',
    fontSize: '16px',
    height: '44px',
  },

  // Variant: primary (brand color)
  primary: {
    backgroundColor: tokens.colorBrandBackground,
    color: '#ffffff',
  },

  // Variant: secondary (subtle)
  secondary: {
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground1,
  },

  // Variant: danger (red)
  danger: {
    backgroundColor: tokens.colorPaletteRedBackground3,
    color: '#ffffff',
  },

  // Variant: ghost (transparent)
  ghost: {
    backgroundColor: 'transparent',
    color: tokens.colorNeutralForeground2,
  },

  // Loading state
  loading: {
    position: 'relative',
    color: 'transparent',
    pointerEvents: 'none',
  },
  spinner: {
    position: 'absolute',
    left: '50%',
    top: '50%',
    transform: 'translate(-50%, -50%)',
  },
});

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'primary', size = 'md', loading, children, className, disabled, icon, onClick, type }, ref) => {
    const styles = useStyles();

    const sizeClass = styles[size];
    const variantClass = styles[variant];

    // Map our appearance to Fluent's
    const appearance = variant === 'ghost' ? 'subtle' : variant === 'secondary' ? 'outline' : 'primary';

    return (
      <FluentButton
        ref={ref}
        appearance={appearance}
        icon={icon}
        className={mergeClasses(
          sizeClass,
          variantClass,
          loading && styles.loading,
          className
        )}
        disabled={disabled || loading}
        onClick={onClick}
        type={type}
      >
        {loading && <Spinner size="tiny" className={styles.spinner} />}
        {children}
      </FluentButton>
    );
  }
);

Button.displayName = 'Button';
