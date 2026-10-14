import { useId, useState, type ReactNode } from 'react';
import { Modal } from './Modal';
import { Button } from './Button';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  /** When set, the confirm button stays disabled until the user types exactly this text. */
  requireText?: string;
  /** Label for the typed-confirmation field. Default: "Type the device ID to confirm". */
  requireTextLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/** In-page replacement for window.confirm. */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  danger = true,
  requireText,
  requireTextLabel = 'Type the device ID to confirm',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState('');
  const inputId = useId();
  const blocked = requireText !== undefined && typed !== requireText;

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      size="sm"
      actions={
        <>
          <Button variant="secondary" onClick={onCancel}>Cancel</Button>
          <Button variant={danger ? 'danger' : 'primary'} disabled={blocked} onClick={onConfirm}>{confirmLabel}</Button>
        </>
      }
    >
      {children}
      {requireText !== undefined && (
        <div style={{ marginTop: 12 }}>
          <label htmlFor={inputId} style={{ display: 'block', marginBottom: 4 }}>
            {requireTextLabel}: <code>{requireText}</code>
          </label>
          <input
            id={inputId}
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            style={{ width: '100%', boxSizing: 'border-box', padding: 6 }}
          />
        </div>
      )}
    </Modal>
  );
}
