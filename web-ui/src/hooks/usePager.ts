import { useState, useCallback } from 'react';

/**
 * Offset paging state. The offset goes back to 0 whenever `resetKey` changes
 * (a different filter or search is a different result set).
 */
export function usePager(limit: number, resetKey: string = '') {
  const [state, setState] = useState({ offset: 0, key: resetKey });
  const offset = state.key === resetKey ? state.offset : 0;
  const setOffset = useCallback((next: number) => setState({ offset: next, key: resetKey }), [resetKey]);
  return { offset, limit, setOffset };
}
