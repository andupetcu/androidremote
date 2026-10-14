import type { Server } from 'http';

export interface ShutdownDeps {
  server: Pick<Server, 'close' | 'closeIdleConnections' | 'closeAllConnections'>;
  /** Stop timers and background jobs. */
  stopJobs: () => void;
  /** Close the WebSocket servers and their clients. */
  closeWebSockets: () => void;
  closeDatabase: () => void;
  exit: (code: number) => void;
  log?: (...args: unknown[]) => void;
  /** Force exit (code 1) when shutdown has not finished by then. Default 10 s. */
  timeoutMs?: number;
}

/**
 * Graceful shutdown (SR-13): stop jobs, stop accepting connections, close WebSocket clients, finish or
 * drop HTTP connections, close the database, exit. Runs once; a second call returns the first result.
 */
export function createShutdown(deps: ShutdownDeps): (reason: string, code: number) => Promise<void> {
  const log = deps.log ?? console.log;
  let running: Promise<void> | null = null;

  const step = (name: string, fn: () => void) => {
    try { fn(); } catch (err) { log(`[shutdown] ${name} failed:`, err); }
  };

  return (reason, code) => {
    if (running) return running;
    log(`[shutdown] ${reason}: shutting down`);
    running = new Promise<void>(resolve => {
      let finished = false;
      const finish = (exitCode: number) => {
        if (finished) return;
        finished = true;
        clearTimeout(force);
        step('close database', deps.closeDatabase);
        deps.exit(exitCode);
        resolve();
      };
      const force = setTimeout(() => {
        log('[shutdown] timed out, forcing exit');
        step('close connections', () => deps.server.closeAllConnections());
        finish(1);
      }, deps.timeoutMs ?? 10_000);
      force.unref();

      step('stop jobs', deps.stopJobs);
      const closed = new Promise<void>(res => {
        try { deps.server.close(() => res()); } catch (err) { log('[shutdown] close server failed:', err); res(); }
      });
      step('close websockets', deps.closeWebSockets);
      step('close idle connections', () => deps.server.closeIdleConnections());
      // Keep-alive and in-flight requests get a short grace period, then they are dropped.
      const grace = setTimeout(() => step('close connections', () => deps.server.closeAllConnections()), 2000);
      grace.unref();
      void closed.then(() => { clearTimeout(grace); finish(code); });
    });
    return running;
  };
}

type ProcessLike = Pick<NodeJS.Process, 'on'>;

/** SIGTERM/SIGINT shut down cleanly; unhandledRejection and uncaughtException are logged and exit non-zero. */
export function installProcessHandlers(
  proc: ProcessLike,
  shutdown: (reason: string, code: number) => Promise<void>,
  log: (...args: unknown[]) => void = console.error
): void {
  proc.on('SIGTERM', () => { void shutdown('SIGTERM', 0); });
  proc.on('SIGINT', () => { void shutdown('SIGINT', 0); });
  proc.on('unhandledRejection', (reason: unknown) => {
    log('[fatal] unhandledRejection:', reason instanceof Error ? reason.stack || reason.message : reason);
    void shutdown('unhandledRejection', 1);
  });
  proc.on('uncaughtException', (err: Error) => {
    log('[fatal] uncaughtException:', err instanceof Error ? err.stack || err.message : err);
    void shutdown('uncaughtException', 1);
  });
}
