import type { ReactNode } from 'react';

/**
 * Test double for components/ui/Modal (installed globally in setupTests.ts).
 *
 * The real Modal is a Fluent UI Dialog. Fluent's focus manager (tabster) is a per-window
 * singleton that moves focus, restores focus and toggles aria-hidden on the dialog from
 * timers and animation frames after mount/unmount. Under CPU load those callbacks land in
 * the middle of a test (even in the next test): typed characters go missing, the dialog
 * turns aria-hidden and role queries inside it fail. That made dialog tests fail about one
 * run in seven. This double keeps the contract the app relies on (role=dialog, a title,
 * a Close button, children and the action row, onClose) without the async focus machinery.
 */
export function ModalDouble(props: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  if (!props.open) return null;
  return (
    <div role="dialog" aria-modal="true" aria-label={props.title}>
      {props.title && (
        <h2>
          {props.title}
          <button type="button" aria-label="Close" onClick={props.onClose} />
        </h2>
      )}
      <div>{props.children}</div>
      {props.actions && <div>{props.actions}</div>}
    </div>
  );
}
