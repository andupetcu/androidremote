import { useCallback, useRef, useState, type ReactNode } from 'react';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';

export interface ConfirmOptions {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  requireText?: string;
  requireTextLabel?: string;
}

/**
 * Promise-based in-page confirmation (replaces window.confirm).
 *   const { confirm, dialog } = useConfirm();
 *   if (!(await confirm({ title, body, confirmLabel }))) return;
 *   ... render {dialog} once in the component.
 */
export function useConfirm() {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const confirm = useCallback((options: ConfirmOptions) => {
    resolver.current?.(false);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
      setOpts(options);
    });
  }, []);

  const settle = (ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    setOpts(null);
  };

  const dialog = opts ? (
    <ConfirmDialog
      open
      title={opts.title}
      confirmLabel={opts.confirmLabel}
      danger={opts.danger}
      requireText={opts.requireText}
      requireTextLabel={opts.requireTextLabel}
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
    >
      {typeof opts.body === 'string' ? <p>{opts.body}</p> : opts.body}
    </ConfirmDialog>
  ) : null;

  return { confirm, dialog };
}
