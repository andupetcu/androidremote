import { Button } from './Button';

export interface PagerProps {
  offset: number;
  limit: number;
  /** Items on the current page. */
  count: number;
  /** Total matching items, when the server reports it. */
  total?: number | null;
  onPage: (offset: number) => void;
  disabled?: boolean;
}

/** Previous/Next with a "Showing a-b of N" line. Works with or without a server total. */
export function Pager({ offset, limit, count, total, onPage, disabled }: PagerProps) {
  const hasTotal = typeof total === 'number';
  const from = count === 0 ? 0 : offset + 1;
  const to = offset + count;
  const hasNext = hasTotal ? to < total : count >= limit;
  const hasPrev = offset > 0;

  if (!hasPrev && !hasNext && (hasTotal ? true : count < limit)) {
    // Everything fits on one page: still say how many there are
    return (
      <div role="navigation" aria-label="Pagination" style={{ padding: '8px 0', fontSize: 13, opacity: 0.8 }}>
        Showing {from}–{to}{hasTotal ? ` of ${total}` : ''}
      </div>
    );
  }

  return (
    <div
      role="navigation"
      aria-label="Pagination"
      style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0', fontSize: 13 }}
    >
      <Button variant="secondary" size="sm" disabled={disabled || !hasPrev} onClick={() => onPage(Math.max(0, offset - limit))}>
        Previous
      </Button>
      <span>
        Showing {from}–{to}
        {hasTotal ? ` of ${total}` : ' (more may exist)'}
      </span>
      <Button variant="secondary" size="sm" disabled={disabled || !hasNext} onClick={() => onPage(offset + limit)}>
        Next
      </Button>
    </div>
  );
}
