import type Database from 'better-sqlite3';
import { getDatabase } from '../db/connection';

class SettingsStore {
  private override: Database.Database | null = null;

  /** Use a specific database (tests). Pass null to go back to the default. */
  setDatabase(database: Database.Database | null): void {
    this.override = database;
  }

  private db(): Database.Database {
    return this.override ?? getDatabase();
  }

  get(key: string): string | null {
    const db = this.db();
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  set(key: string, value: string): void {
    const db = this.db();
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
  }

  delete(key: string): boolean {
    const db = this.db();
    const result = db.prepare('DELETE FROM settings WHERE key = ?').run(key);
    return result.changes > 0;
  }

  getAll(): Record<string, string> {
    const db = this.db();
    const rows = db.prepare('SELECT key, value FROM settings WHERE key NOT LIKE ?').all('admin%') as { key: string; value: string }[];
    const result: Record<string, string> = {};
    for (const row of rows) {
      result[row.key] = row.value;
    }
    return result;
  }

  setMultiple(settings: Record<string, string>): void {
    const db = this.db();
    const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    const transaction = db.transaction((entries: [string, string][]) => {
      for (const [key, value] of entries) {
        stmt.run(key, value);
      }
    });
    transaction(Object.entries(settings));
  }
}

export const settingsStore = new SettingsStore();
