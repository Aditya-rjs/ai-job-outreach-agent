import path from 'path';
import fs from 'fs';

/**
 * Returns the resolved absolute root directory for all persistent application data.
 * - Defaults to `<cwd>/data` if DATA_DIR is not set or empty.
 * - If DATA_DIR is an absolute path (e.g. `/data` on a Railway persistent Volume), it is used directly.
 * - If DATA_DIR is relative (e.g. `data` or `./my-data`), it is resolved relative to `process.cwd()`.
 */
export function getDataDir(): string {
  const envDataDir = process.env.DATA_DIR?.trim();
  if (envDataDir) {
    return path.isAbsolute(envDataDir) ? envDataDir : path.resolve(/*turbopackIgnore: true*/ process.cwd(), envDataDir);
  }
  return path.resolve(/*turbopackIgnore: true*/ process.cwd(), 'data');
}

/**
 * Returns the absolute path to the persistent SQLite database file (outreach.db).
 */
export function getDbPath(): string {
  return path.join(getDataDir(), 'outreach.db');
}

/**
 * Returns the absolute path to the directory where uploaded resumes are stored.
 */
export function getResumesDir(): string {
  return path.join(getDataDir(), 'resumes');
}

/**
 * Returns the absolute path to the directory where uploaded contact files (CSV/PDF) are stored.
 */
export function getUploadsDir(): string {
  return path.join(getDataDir(), 'uploads');
}

/**
 * Ensures that the root data directory and all persistent subdirectories exist.
 */
export function ensureDataDirsExist(): void {
  const dirs = [getDataDir(), getResumesDir(), getUploadsDir()];
  for (const dir of dirs) {
    if (!fs.existsSync(/*turbopackIgnore: true*/ dir)) {
      fs.mkdirSync(/*turbopackIgnore: true*/ dir, { recursive: true });
    }
  }
}
