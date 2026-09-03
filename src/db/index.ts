import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import path from 'path';
import fs from 'fs';
import * as schema from './schema';

const DB_PATH = path.join(process.cwd(), 'data', 'outreach.db');

function createConnection() {
  // Ensure data directory exists
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const sqlite = new Database(DB_PATH);

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

export type DbClient = ReturnType<typeof getDb>;
