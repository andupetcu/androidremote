import { createServer } from 'http';
import { app } from './app';
import { setupSignaling } from './signaling';

const PORT = process.env.PORT || 7899;

const server = createServer(app);

// Attach WebSocket signaling
setupSignaling(server);

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Server running on http://localhost:${PORT}`);
  // eslint-disable-next-line no-console
  console.log(`WebSocket signaling on ws://localhost:${PORT}/ws`);
});
