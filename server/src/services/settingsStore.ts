import { getDatabase } from '../db/connection';

class SettingsStore {
  get(key: string): string | null {
    const db = getDatabase();
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  set(key: string, value: string): void {
    const db = getDatabase();
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
  }

  delete(key: string): boolean {
    const db = getDatabase();
    const result = db.prepare('DELETE FROM settings WHERE key = ?').run(key);
    return result.changes > 0;
  }

  getAll(): Record<string, string> {
    const db = getDatabase();
    const rows = db.prepare('SELECT key, value FROM settings WHERE key NOT LIKE ?').all('admin%') as { key: string; value: string }[];
    const result: Record<string, string> = {};
    for (const row of rows) {
      result[row.key] = row.value;
    }
    return result;
  }

  setMultiple(settings: Record<string, string>): void {
    const db = getDatabase();
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
