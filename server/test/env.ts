// Runs before each test file's modules are loaded (jest setupFiles).
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

// Cheap bcrypt: cost 12 takes 0.3-1 s per hash in pure JS and starves a parallel run (BCRYPT_ROUNDS, see auth.ts).
process.env.BCRYPT_ROUNDS = '4';

// Every test file gets its own scratch root, so parallel workers never share upload, installer, binary or DB paths.
// The app reads these at import time, which is why this must happen here and not in a beforeAll.
// A file that wants specific directories (t11-api, t6-helpers) simply overrides them afterwards.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-jest-'));
process.env.UPLOADS_DIR = path.join(root, 'uploads');
process.env.INSTALLERS_DIR = path.join(root, 'installers');
process.env.AGENT_BINARIES_DIR = path.join(root, 'agent-binaries');
process.env.DB_PATH = path.join(root, 'data', 'mdm.db');
process.on('exit', () => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
});

// supertest starts a fresh server on an ephemeral port for every request. Node's default agent keeps sockets alive
// and pools them per host:port; when the OS hands the same port to the next request's server, the agent reuses a
// socket whose old server already closed it, and the request dies with "socket hang up". Under a parallel run
// that race fires about once per few runs. No keep-alive, no stale sockets.
const agent = http.globalAgent as http.Agent & { keepAlive: boolean; options: { keepAlive?: boolean } };
agent.keepAlive = false;
agent.options.keepAlive = false;
