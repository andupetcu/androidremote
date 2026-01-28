import {
  Dialog,
  DialogSurface,
  DialogBody,
  DialogTitle,
  DialogContent,
  DialogActions,
  makeStyles,
  mergeClasses,
  tokens,
  Button,
} from '@fluentui/react-components';
import { Dismiss24Regular } from '@fluentui/react-icons';
import type { ReactNode } from 'react';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  actions?: ReactNode;
}

const useStyles = makeStyles({
  surface: {
    backgroundColor: tokens.colorNeutralBackground2,
    borderRadius: '12px',
    boxShadow: tokens.shadow28,
    maxHeight: '90vh',
    display: 'flex',
    flexDirection: 'column',
  },
  sm: {
    width: '400px',
    maxWidth: '90vw',
  },
  md: {
    width: '560px',
    maxWidth: '90vw',
  },
  lg: {
    width: '800px',
    maxWidth: '90vw',
  },
  title: {
    color: tokens.colorNeutralForeground1,
    fontSize: '18px',
    fontWeight: 600,
    paddingRight: '40px',
  },
  closeButton: {
    position: 'absolute',
    right: '16px',
    top: '16px',
    minWidth: 'auto',
    paddingTop: '4px',
    paddingBottom: '4px',
    paddingLeft: '4px',
    paddingRight: '4px',
    color: tokens.colorNeutralForeground2,
  },
  content: {
    color: tokens.colorNeutralForeground2,
    overflowY: 'auto',
  },
  actions: {
    paddingTop: '16px',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens.colorNeutralStroke1,
  },
});

export function Modal({ open, onClose, title, children, size = 'md', actions }: ModalProps) {
  const styles = useStyles();

  const sizeClass = {
    sm: styles.sm,
    md: styles.md,
    lg: styles.lg,
  }[size];

  return (
    <Dialog open={open} onOpenChange={(_, data) => !data.open && onClose()}>
      <DialogSurface className={mergeClasses(styles.surface, sizeClass)}>
        <DialogBody>
          {title && (
            <DialogTitle className={styles.title}>
              {title}
              <Button
                appearance="subtle"
                className={styles.closeButton}
                onClick={onClose}
                icon={<Dismiss24Regular />}
                aria-label="Close"
              />
            </DialogTitle>
          )}
          <DialogContent className={styles.content}>
            {children}
          </DialogContent>
          {actions && (
            <DialogActions className={styles.actions}>
              {actions}
            </DialogActions>
          )}
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
