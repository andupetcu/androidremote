import { createServer } from 'http';
import { app } from './app';
import { setupSignaling, closeAllWebSocketServers } from './signaling';
import { shutdownRelay } from './relay';
import { ensureInitialAdminPassword } from './middleware/auth';
import { getDatabase, closeDatabase } from './db/connection';
import { startMaintenance } from './services/maintenance';
import { createShutdown, installProcessHandlers } from './shutdown';

const PORT = process.env.PORT || 7899;

// JWT_SECRET startup check
if (!process.env.JWT_SECRET) {
  const msg = 'WARNING: JWT_SECRET environment variable is not set. ' +
    'A random secret will be generated — all tokens will be invalidated on server restart. ' +
    'Set JWT_SECRET to a strong random value (e.g. `openssl rand -hex 64`) for production use.';

  if (process.env.NODE_ENV === 'production') {
    console.error('FATAL: ' + msg);
    console.error('Refusing to start in production without JWT_SECRET.');
    process.exit(1);
  } else {
    console.warn('\n' + '='.repeat(80));
    console.warn(msg);
    console.warn('='.repeat(80) + '\n');
  }
}

// One-time admin password setup from ADMIN_INITIAL_PASSWORD (ignored once a password is stored).
ensureInitialAdminPassword().catch(err => console.error('Admin password setup failed:', err));

const server = createServer(app);

// Attach WebSocket signaling
setupSignaling(server);

// Retention purges, offline detection, command expiry (SR-08, SR-15)
const maintenance = startMaintenance({ db: getDatabase() });

// Graceful shutdown and process-level error handling (SR-13)
const shutdown = createShutdown({
  server,
  stopJobs: () => maintenance.stop(),
  closeWebSockets: () => {
    shutdownRelay();
    closeAllWebSocketServers();
  },
  closeDatabase: closeDatabase,
  exit: code => process.exit(code),
});
installProcessHandlers(process, shutdown);

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Server running on http://localhost:${PORT}`);
  // eslint-disable-next-line no-console
  console.log(`WebSocket signaling on ws://localhost:${PORT}/ws`);
});
