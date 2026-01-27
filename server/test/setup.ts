import Database from 'better-sqlite3';
import { pairingStore } from '../src/services/pairingStore';
import { deviceStore } from '../src/services/deviceStore';
import { enrollmentStore } from '../src/services/enrollmentStore';
import { commandStore } from '../src/services/commandStore';
import { initializeSchema } from '../src/db/schema';

// Create a shared in-memory database for tests
let testDb: Database.Database;

export function setupTestDatabase(): Database.Database {
  // Create fresh in-memory database
  testDb = new Database(':memory:');
  testDb.pragma('foreign_keys = ON');
  initializeSchema(testDb);

  // Configure stores to use test database
  pairingStore.setDatabase(testDb);
  deviceStore.setDatabase(testDb);
  enrollmentStore.setDatabase(testDb);
  commandStore.setDatabase(testDb);

  return testDb;
}

export function cleanupTestDatabase(): void {
  if (testDb) {
    // Clear all data but keep schema
    testDb.exec('DELETE FROM device_commands');
    testDb.exec('DELETE FROM sessions');
    testDb.exec('DELETE FROM pairing_sessions');
    testDb.exec('DELETE FROM enrollment_tokens');
    testDb.exec('DELETE FROM devices');
  }
}

export function closeTestDatabase(): void {
  if (testDb) {
    testDb.close();
  }
}
