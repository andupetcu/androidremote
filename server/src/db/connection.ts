import Database from 'better-sqlite3';
import path from 'path';
import { initializeSchema } from './schema';

// Database file location - use environment variable or default to data directory
const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data', 'mdm.db');

let db: Database.Database | null = null;

/**
 * Get the database instance (singleton pattern)
 */
export function getDatabase(): Database.Database {
  if (!db) {
    // Ensure data directory exists
    const fs = require('fs');
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    db = new Database(DB_PATH);

    // Enable foreign keys
    db.pragma('foreign_keys = ON');

    // WAL mode for better concurrent performance
    db.pragma('journal_mode = WAL');

    // Initialize schema (creates tables if they don't exist)
    initializeSchema(db);
  }
  return db;
}

/**
 * Close the database connection
 */
export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * Get an in-memory database for testing
 */
export function getTestDatabase(): Database.Database {
  const testDb = new Database(':memory:');
  testDb.pragma('foreign_keys = ON');
  return testDb;
}

/**
 * Reset the database singleton (for testing)
 */
export function resetDatabase(): void {
  db = null;
}
