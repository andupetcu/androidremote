import {
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import { MailInboxRegular } from '@fluentui/react-icons';
import type { ReactNode } from 'react';

export interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}

const useStyles = makeStyles({
  container: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '48px 24px',
    textAlign: 'center',
  },
  icon: {
    fontSize: '48px',
    marginBottom: '16px',
    color: tokens.colorNeutralForeground3,
  },
  fluentIcon: {
    width: '48px',
    height: '48px',
    marginBottom: '16px',
    color: tokens.colorNeutralForeground3,
  },
  title: {
    margin: '0 0 8px 0',
    fontSize: '18px',
    fontWeight: 600,
    color: tokens.colorNeutralForeground1,
  },
  description: {
    margin: '0 0 24px 0',
    fontSize: '14px',
    color: tokens.colorNeutralForeground2,
    maxWidth: '400px',
  },
  action: {
    marginTop: '8px',
  },
});

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  const styles = useStyles();

  // Determine if icon is a string (emoji) or a React node
  const isEmojiIcon = typeof icon === 'string';
  const defaultIcon = <MailInboxRegular className={styles.fluentIcon} />;

  return (
    <div className={mergeClasses(styles.container, className)}>
      {icon ? (
        isEmojiIcon ? (
          <span className={styles.icon}>{icon}</span>
        ) : (
          <span className={styles.fluentIcon}>{icon}</span>
        )
      ) : (
        defaultIcon
      )}
      <h3 className={styles.title}>{title}</h3>
      {description && <p className={styles.description}>{description}</p>}
      {action && <div className={styles.action}>{action}</div>}
    </div>
  );
}
