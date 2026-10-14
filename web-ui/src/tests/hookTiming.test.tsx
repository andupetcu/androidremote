import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePolling } from '../hooks/usePolling';
import { useInView } from '../hooks/useInView';

describe('usePolling latest-task ref', () => {
  it('calls the newest task after a re-render without restarting the poller', async () => {
    vi.useFakeTimers();
    try {
      const a = vi.fn().mockResolvedValue(true);
      const b = vi.fn().mockResolvedValue(true);
      const { rerender } = renderHook(({ t }) => usePolling(t, 1000), { initialProps: { t: a } });
      rerender({ t: b });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1100);
      });
      expect(b).toHaveBeenCalled();
      expect(a).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('useInView', () => {
  it('is immediately seen when IntersectionObserver is missing', () => {
    const g = globalThis as { IntersectionObserver?: unknown };
    const orig = g.IntersectionObserver;
    delete g.IntersectionObserver;
    try {
      const { result } = renderHook(() => useInView<HTMLDivElement>());
      expect(result.current[1]).toBe(true);
    } finally {
      if (orig) g.IntersectionObserver = orig;
    }
  });
});
