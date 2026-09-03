import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';
import { getDbPath, ensureDataDirsExist } from '@/lib/config/paths';

function createConnection() {
  // Ensure data directory and subdirectories exist
  ensureDataDirsExist();

  const dbPath = getDbPath();
  const sqlite = new Database(dbPath);

  // Enable WAL mode for better concurrent read performance
  sqlite.pragma('journal_mode = WAL');
  // Enable foreign key enforcement
  sqlite.pragma('foreign_keys = ON');
  // Busy timeout for lock contention
  sqlite.pragma('busy_timeout = 5000');

  return drizzle(sqlite, { schema });
}

// Singleton pattern - reuse connection across requests
let dbInstance: ReturnType<typeof createConnection> | null = null;

export function getDb() {
  if (!dbInstance) {
    dbInstance = createConnection();
  }
  return dbInstance;
}

/**
 * Resets the active database connection singleton.
 * Useful for test suites when switching DATA_DIR.
 */
export function resetDbConnection(): void {
  dbInstance = null;
}

export { getDbPath };
export type DbClient = ReturnType<typeof getDb>;
