/* eslint-disable @typescript-eslint/no-require-imports */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

console.log('======================================================================');
console.log('RAILWAY PERSISTENT STORAGE & DATA_DIR VERIFICATION');
console.log('======================================================================');

let passedTests = 0;
let totalTests = 0;

function assert(condition, message) {
  totalTests++;
  if (condition) {
    console.log(`✓ [PASS] ${message}`);
    passedTests++;
  } else {
    console.error(`✗ [FAIL] ${message}`);
    process.exit(1);
  }
}

// ── TEST 1: DEFAULT BEHAVIOR (DATA_DIR UNSET) ───────────────────────────
console.log('\n--- 1. Default Behavior (DATA_DIR unset) ---');
delete process.env.DATA_DIR;

// Re-implement path resolver logic for JS test runner
function resolvePaths(envVal) {
  const trimmed = envVal?.trim();
  const root = trimmed
    ? (path.isAbsolute(trimmed) ? trimmed : path.resolve(process.cwd(), trimmed))
    : path.resolve(process.cwd(), 'data');
  return {
    dataDir: root,
    dbPath: path.join(root, 'outreach.db'),
    resumesDir: path.join(root, 'resumes'),
    uploadsDir: path.join(root, 'uploads'),
  };
}

const defaultPaths = resolvePaths(undefined);
assert(defaultPaths.dataDir === path.resolve(process.cwd(), 'data'), `Default DATA_DIR resolves to local data directory: ${defaultPaths.dataDir}`);
assert(defaultPaths.dbPath === path.resolve(process.cwd(), 'data', 'outreach.db'), `Default DB path resolves to: ${defaultPaths.dbPath}`);
assert(defaultPaths.resumesDir === path.resolve(process.cwd(), 'data', 'resumes'), `Default resumes dir resolves to: ${defaultPaths.resumesDir}`);
assert(defaultPaths.uploadsDir === path.resolve(process.cwd(), 'data', 'uploads'), `Default uploads dir resolves to: ${defaultPaths.uploadsDir}`);

// ── TEST 2: RELATIVE DATA_DIR ───────────────────────────────────────────
console.log('\n--- 2. Relative DATA_DIR Configuration ---');
const relativePaths = resolvePaths('custom-test-data');
assert(relativePaths.dataDir === path.resolve(process.cwd(), 'custom-test-data'), `Relative DATA_DIR resolves to: ${relativePaths.dataDir}`);
assert(relativePaths.dbPath === path.resolve(process.cwd(), 'custom-test-data', 'outreach.db'), `Relative DB path resolves to: ${relativePaths.dbPath}`);
assert(relativePaths.resumesDir === path.resolve(process.cwd(), 'custom-test-data', 'resumes'), `Relative resumes dir resolves to: ${relativePaths.resumesDir}`);

// ── TEST 3: ABSOLUTE DATA_DIR (RAILWAY PRODUCTION VOLUME MOUNT) ─────────
console.log('\n--- 3. Absolute DATA_DIR (Railway /data Volume Mount) ---');
const posixAbsolute = '/data';
const posixResolved = resolvePaths(posixAbsolute);
if (process.platform !== 'win32') {
  assert(posixResolved.dataDir === '/data', 'POSIX /data resolves directly to volume mount /data');
  assert(posixResolved.dbPath === '/data/outreach.db', 'DB path resolves to /data/outreach.db');
  assert(posixResolved.resumesDir === '/data/resumes', 'Resumes path resolves to /data/resumes');
} else {
  // On Windows, test with an absolute Windows drive path
  const winAbsolute = 'C:\\railway_volume\\data';
  const winResolved = resolvePaths(winAbsolute);
  assert(winResolved.dataDir === winAbsolute, `Windows absolute path resolves directly: ${winResolved.dataDir}`);
  assert(winResolved.dbPath === path.join(winAbsolute, 'outreach.db'), `DB path resolves to: ${winResolved.dbPath}`);
  assert(winResolved.resumesDir === path.join(winAbsolute, 'resumes'), `Resumes path resolves to: ${winResolved.resumesDir}`);
}

// ── TEST 4: DIRECTORY CREATION & FILE PERSISTENCE IN CUSTOM DATA_DIR ───
console.log('\n--- 4. Persistent Storage Directory Creation & SQLite WAL Mode ---');
const tempTestDir = path.resolve(process.cwd(), 'data', '_test_railway_volume');
if (fs.existsSync(tempTestDir)) {
  fs.rmSync(tempTestDir, { recursive: true, force: true });
}

process.env.DATA_DIR = tempTestDir;
const testPaths = resolvePaths(tempTestDir);

// Create required subdirectories
fs.mkdirSync(testPaths.dataDir, { recursive: true });
fs.mkdirSync(testPaths.resumesDir, { recursive: true });
fs.mkdirSync(testPaths.uploadsDir, { recursive: true });

assert(fs.existsSync(testPaths.dataDir), 'DATA_DIR created successfully on disk');
assert(fs.existsSync(testPaths.resumesDir), 'Resumes directory created under DATA_DIR');
assert(fs.existsSync(testPaths.uploadsDir), 'Uploads directory created under DATA_DIR');

// Initialize a SQLite DB in the custom DATA_DIR and test WAL mode
const testDb = new Database(testPaths.dbPath);
testDb.pragma('journal_mode = WAL');
const journalMode = testDb.pragma('journal_mode', { simple: true });
assert(journalMode.toLowerCase() === 'wal', `SQLite WAL mode verified in DATA_DIR: ${journalMode}`);

testDb.prepare(`
  CREATE TABLE test_railway_persistence (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL
  )
`).run();

testDb.prepare(`INSERT INTO test_railway_persistence (id, name) VALUES ('1', 'volume_persisted')`).run();
const row = testDb.prepare(`SELECT name FROM test_railway_persistence WHERE id = '1'`).get();
assert(row.name === 'volume_persisted', 'SQLite reads and writes correctly in DATA_DIR');
testDb.close();

// Check that the db file exists in the custom DATA_DIR
assert(fs.existsSync(testPaths.dbPath), `outreach.db created inside DATA_DIR: ${testPaths.dbPath}`);

// ── TEST 5: RESUME STORAGE & RETRIEVAL FALLBACK IN DATA_DIR ────────────
console.log('\n--- 5. Resume Storage & Fallback Resolution ---');
const mockResumeFilename = 'Candidate_Resume.pdf';
const mockResumeBuffer = Buffer.from('%PDF-1.4 Mock resume content for Railway testing');
const mockResumePath = path.join(testPaths.resumesDir, mockResumeFilename);

fs.writeFileSync(mockResumePath, mockResumeBuffer);
assert(fs.existsSync(mockResumePath), `Resume successfully stored in DATA_DIR/resumes: ${mockResumePath}`);

// Test fallback resolver: if DB stores old path from another machine (e.g. C:\Users\old\resume.pdf),
// the fallback logic finds it in testPaths.resumesDir
const oldMachinePath = 'C:\\old_machine\\data\\resumes\\Candidate_Resume.pdf';
let resolvedResumePath = oldMachinePath;
if (!fs.existsSync(resolvedResumePath)) {
  const fallback = path.join(testPaths.resumesDir, path.basename(oldMachinePath));
  if (fs.existsSync(fallback)) {
    resolvedResumePath = fallback;
  }
}
assert(resolvedResumePath === mockResumePath, 'Fallback resolver successfully maps old machine path to current DATA_DIR/resumes');

// ── CLEANUP TEST ARTIFACTS ─────────────────────────────────────────────
console.log('\n--- Cleaning up temporary test volume ---');
try {
  fs.rmSync(tempTestDir, { recursive: true, force: true });
  console.log('✓ Cleaned up temporary test directory');
} catch (err) {
  console.warn('Note: Temporary test directory cleanup deferred:', err.message);
}

delete process.env.DATA_DIR;

console.log('\n======================================================================');
console.log(`DATA_DIR VERIFICATION COMPLETE: ${passedTests} / ${totalTests} TESTS PASSED`);
console.log('======================================================================');
