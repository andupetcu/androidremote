import {
  Spinner as FluentSpinner,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';

export interface SpinnerProps {
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  label?: string;
}

const useStyles = makeStyles({
  spinner: {
    // Use brand color for spinner
    '--spinner-color': tokens.colorBrandForeground1,
  },
});

// Map our sizes to Fluent UI spinner sizes
const sizeMap = {
  sm: 'tiny',
  md: 'small',
  lg: 'medium',
} as const;

export function Spinner({ size = 'md', className = '', label }: SpinnerProps) {
  const styles = useStyles();

  return (
    <FluentSpinner
      size={sizeMap[size]}
      className={mergeClasses(styles.spinner, className)}
      label={label}
      labelPosition="below"
    />
  );
}
