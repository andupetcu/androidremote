import {
  Card as FluentCard,
  CardHeader as FluentCardHeader,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import type { ReactNode } from 'react';

export interface CardProps {
  children: ReactNode;
  className?: string;
  padding?: 'none' | 'sm' | 'md' | 'lg';
  hover?: boolean;
  onClick?: () => void;
}

const useStyles = makeStyles({
  card: {
    backgroundColor: tokens.colorNeutralBackground2,
    borderRadius: '8px',
  },
  paddingNone: {
    paddingTop: '0px',
    paddingBottom: '0px',
    paddingLeft: '0px',
    paddingRight: '0px',
  },
  paddingSm: {
    paddingTop: '12px',
    paddingBottom: '12px',
    paddingLeft: '12px',
    paddingRight: '12px',
  },
  paddingMd: {
    paddingTop: '16px',
    paddingBottom: '16px',
    paddingLeft: '16px',
    paddingRight: '16px',
  },
  paddingLg: {
    paddingTop: '24px',
    paddingBottom: '24px',
    paddingLeft: '24px',
    paddingRight: '24px',
  },
  hover: {
    cursor: 'pointer',
    transitionDuration: '150ms',
    transitionTimingFunction: 'ease-in-out',
    ':hover': {
      boxShadow: tokens.shadow4,
    },
  },
  clickable: {
    cursor: 'pointer',
  },
});

const useHeaderStyles = makeStyles({
  header: {
    padding: '0',
    marginBottom: '12px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
});

const useTitleStyles = makeStyles({
  title: {
    margin: '0',
    fontSize: '16px',
    fontWeight: 600,
    color: tokens.colorNeutralForeground1,
  },
});

const useContentStyles = makeStyles({
  content: {
    color: tokens.colorNeutralForeground2,
  },
});

const useFooterStyles = makeStyles({
  footer: {
    marginTop: '16px',
    paddingTop: '16px',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens.colorNeutralStroke1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: '8px',
  },
});

export function Card({ children, className = '', padding = 'md', hover = false, onClick }: CardProps) {
  const styles = useStyles();

  const paddingClass = {
    none: styles.paddingNone,
    sm: styles.paddingSm,
    md: styles.paddingMd,
    lg: styles.paddingLg,
  }[padding];

  return (
    <FluentCard
      className={mergeClasses(
        styles.card,
        paddingClass,
        hover && styles.hover,
        onClick && styles.clickable,
        className
      )}
      onClick={onClick}
    >
      {children}
    </FluentCard>
  );
}

export function CardHeader({ children, className = '' }: { children: ReactNode; className?: string }) {
  const styles = useHeaderStyles();
  return (
    <FluentCardHeader
      className={mergeClasses(styles.header, className)}
      header={<>{children}</>}
    />
  );
}

export function CardTitle({ children }: { children: ReactNode }) {
  const styles = useTitleStyles();
  return <h3 className={styles.title}>{children}</h3>;
}

export function CardContent({ children, className = '' }: { children: ReactNode; className?: string }) {
  const styles = useContentStyles();
  return <div className={mergeClasses(styles.content, className)}>{children}</div>;
}

export function CardFooter({ children, className = '' }: { children: ReactNode; className?: string }) {
  const styles = useFooterStyles();
  return <div className={mergeClasses(styles.footer, className)}>{children}</div>;
}
