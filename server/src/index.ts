import { createServer } from 'http';
import { app } from './app';
import { setupSignaling } from './signaling';

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

const server = createServer(app);

// Attach WebSocket signaling
setupSignaling(server);

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Server running on http://localhost:${PORT}`);
  // eslint-disable-next-line no-console
  console.log(`WebSocket signaling on ws://localhost:${PORT}/ws`);
});
