/**
 * One polling scheduler for the whole UI (WU-16).
 *  - never overlaps runs of the same poller (a slow request cannot pile up)
 *  - pauses while the tab is hidden and runs once when it becomes visible
 *  - exponential backoff after a failed run, reset by the first success
 *  - `inflight` shares one request between hooks that fetch the same URL
 */
import { apiFetch } from '../utils/api';

export interface PollerOptions {
  /** Return false (or throw) to report a failed run. */
  task: () => Promise<boolean | void>;
  intervalMs: number;
  /** Backoff ceiling. Default: 8 x intervalMs. */
  maxIntervalMs?: number;
}

export interface Poller {
  start: () => void;
  stop: () => void;
  /** Run now (ignored while a run is in flight or the tab is hidden). */
  trigger: () => void;
  /** Change the base interval, for example when live events take over. */
  setInterval: (ms: number) => void;
}

export function createPoller(opts: PollerOptions): Poller {
  let base = opts.intervalMs;
  const ceiling = () => opts.maxIntervalMs ?? base * 8;
  let delay = base;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let started = false;

  const hidden = () => typeof document !== 'undefined' && document.hidden;

  const clear = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const schedule = () => {
    clear();
    if (!started || hidden()) return; // resumed by visibilitychange
    timer = setTimeout(run, delay);
  };

  async function run() {
    timer = null;
    if (!started || running || hidden()) return;
    running = true;
    let ok = true;
    try {
      ok = (await opts.task()) !== false;
    } catch {
      ok = false;
    } finally {
      running = false;
    }
    delay = ok ? base : Math.min(delay * 2, ceiling());
    schedule();
  }

  const onVisibility = () => {
    if (!started) return;
    if (hidden()) {
      clear();
    } else if (!running) {
      clear();
      void run();
    }
  };

  return {
    start() {
      if (started) return;
      started = true;
      delay = base;
      document.addEventListener('visibilitychange', onVisibility);
      schedule();
    },
    stop() {
      started = false;
      clear();
      document.removeEventListener('visibilitychange', onVisibility);
    },
    trigger() {
      if (started && !running && !hidden()) {
        clear();
        void run();
      }
    },
    setInterval(ms: number) {
      base = ms;
      delay = ms;
      if (started && !running) schedule();
    },
  };
}

/** Trailing-edge debounce with cancel. */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | null = null;
  const wrapped = (...args: A) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      t = null;
      fn(...args);
    }, ms);
  };
  wrapped.cancel = () => {
    if (t) clearTimeout(t);
    t = null;
  };
  return wrapped;
}

const inflightRequests = new Map<string, Promise<unknown>>();

/** Concurrent callers with the same key share one in-flight promise. */
export function inflight<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inflightRequests.get(key);
  if (existing) return existing as Promise<T>;
  const p = fn().finally(() => {
    if (inflightRequests.get(key) === p) inflightRequests.delete(key);
  });
  inflightRequests.set(key, p);
  return p;
}

export interface SharedJson<T = unknown> {
  ok: boolean;
  status: number;
  data: T | null;
}

/** GET a URL as JSON; concurrent callers for the same URL share one request. */
export function fetchJsonShared<T = unknown>(url: string): Promise<SharedJson<T>> {
  return inflight(`GET ${url}`, async () => {
    const res = await apiFetch(url);
    let data: T | null = null;
    if (res.ok) {
      try {
        data = (await res.json()) as T;
      } catch {
        data = null;
      }
    }
    return { ok: res.ok, status: res.status, data };
  });
}
