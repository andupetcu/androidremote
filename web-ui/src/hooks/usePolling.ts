import { useEffect, useRef } from 'react';
import { createPoller, type Poller } from '../lib/polling';

/**
 * Run `task` every `intervalMs` through the shared scheduler (visibility pause,
 * backoff, no overlap). Set `enabled` false to stop. Returns a ref to the poller
 * so callers can trigger() or change the interval when live events take over.
 */
export function usePolling(
  task: () => Promise<boolean | void>,
  intervalMs: number,
  enabled = true
): React.RefObject<Poller | null> {
  const taskRef = useRef(task);
  taskRef.current = task;
  const pollerRef = useRef<Poller | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const poller = createPoller({ task: () => taskRef.current(), intervalMs });
    pollerRef.current = poller;
    poller.start();
    return () => {
      poller.stop();
      pollerRef.current = null;
    };
  }, [intervalMs, enabled]);

  return pollerRef;
}
