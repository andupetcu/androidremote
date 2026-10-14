import Database from 'better-sqlite3';
import jwt from 'jsonwebtoken';
import { getJwtSecret } from '../src/middleware/auth';
import { pairingStore } from '../src/services/pairingStore';
import { deviceStore } from '../src/services/deviceStore';
import { enrollmentStore } from '../src/services/enrollmentStore';
import { commandStore } from '../src/services/commandStore';
import { appInventoryStore } from '../src/services/appInventoryStore';
import { auditStore } from '../src/services/auditStore';
import { eventStore } from '../src/services/eventStore';
import { fileTransferStore } from '../src/services/fileTransferStore';
import { groupStore } from '../src/services/groupStore';
import { policyStore } from '../src/services/policyStore';
import { telemetryStore } from '../src/services/telemetryStore';
import { settingsStore } from '../src/services/settingsStore';
import { setAuthDatabase } from '../src/middleware/auth';
import { initializeSchema } from '../src/db/schema';

// Tables wiped between tests (settings is left alone; it holds no per-test data).
const DATA_TABLES = [
  'device_commands', 'device_events', 'device_apps', 'device_telemetry', 'telemetry_history',
  'file_transfers', 'device_group_members', 'device_groups', 'sessions', 'pairing_sessions',
  'enrollment_tokens', 'audit_logs', 'app_versions', 'app_catalog', 'app_packages',
  'policies', 'devices', 'revoked_tokens',
];

let testDb: Database.Database | undefined;

export function setupTestDatabase(): Database.Database {
  // Create fresh in-memory database
  testDb = new Database(':memory:');
  testDb.pragma('foreign_keys = ON');
  initializeSchema(testDb);

  // Point every store at the test database so nothing touches the real one
  pairingStore.setDatabase(testDb);
  deviceStore.setDatabase(testDb);
  enrollmentStore.setDatabase(testDb);
  commandStore.setDatabase(testDb);
  appInventoryStore.setDatabase(testDb);
  auditStore.setDatabase(testDb);
  eventStore.setDatabase(testDb);
  fileTransferStore.setDatabase(testDb);
  groupStore.setDatabase(testDb);
  policyStore.setDatabase(testDb);
  telemetryStore.setDatabase(testDb);
  settingsStore.setDatabase(testDb);
  setAuthDatabase(testDb);

  return testDb;
}

export function cleanupTestDatabase(): void {
  if (testDb) {
    testDb.pragma('foreign_keys = OFF');
    for (const table of DATA_TABLES) {
      testDb.exec(`DELETE FROM ${table}`);
    }
    testDb.pragma('foreign_keys = ON');
  }
}

export function closeTestDatabase(): void {
  if (testDb) {
    setAuthDatabase(null);
    settingsStore.setDatabase(null);
    testDb.close();
    testDb = undefined;
  }
}

// Admin JWT for supertest calls against admin-only /api routes.
// Device-facing routes authenticate with X-Session-Token instead and must use plain request(app).
export function adminAuthHeader(): string {
  return `Bearer ${jwt.sign({ username: 'admin' }, getJwtSecret(), { expiresIn: '1h' })}`;
}

// Session token for an already-enrolled device, for device-facing routes (contract C1: X-Session-Token).
export function deviceTokenFor(deviceId: string, ttlMs = 60 * 60 * 1000): string {
  if (!testDb) throw new Error('setupTestDatabase() has not been called');
  const token = require('crypto').randomBytes(32).toString('base64url') as string;
  const now = Date.now();
  testDb
    .prepare('INSERT INTO sessions (token, device_id, created_at, last_activity, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(token, deviceId, now, now, now + ttlMs);
  return token;
}
