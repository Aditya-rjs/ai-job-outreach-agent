/* eslint-disable @typescript-eslint/no-require-imports */
const path = require('path');
const fs = require('fs');

console.log('======================================================================');
console.log('RAILWAY PROCESS SUPERVISOR VERIFICATION');
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

// ── TEST 1: SUPERVISOR SCRIPT EXISTENCE & MODULE EXPORTS ─────────────────
console.log('\n--- 1. Supervisor Script & Module Exports ---');
const supervisorPath = path.join(__dirname, '..', 'scripts', 'start-railway.js');
assert(fs.existsSync(supervisorPath), 'scripts/start-railway.js exists on disk');

const supervisorModule = require(supervisorPath);
assert(typeof supervisorModule.startSupervisor === 'function', 'startSupervisor function is exported by supervisor module');

// ── TEST 2: PATH & BINARY RESOLUTION ─────────────────────────────────────
console.log('\n--- 2. Binary Resolution Verification ---');
let nextBinResolved = false;
try {
  const nextBin = require.resolve('next/dist/bin/next');
  assert(fs.existsSync(nextBin), `Next.js binary resolved at: ${nextBin}`);
  nextBinResolved = true;
} catch {
  nextBinResolved = false;
}
assert(nextBinResolved, 'Next.js CLI binary is resolvable without subshell');

let tsxResolved = false;
try {
  const tsxCli = require.resolve('tsx/cli');
  assert(fs.existsSync(tsxCli), `TSX CLI resolved at: ${tsxCli}`);
  tsxResolved = true;
} catch {
  tsxResolved = false;
}
assert(tsxResolved, 'TSX CLI is resolvable without subshell');

// ── TEST 3: DYNAMIC PORT & DATA_DIR FORWARDING ───────────────────────────
console.log('\n--- 3. Dynamic PORT & DATA_DIR Environment Forwarding ---');
const testPort = '4567';
const testDataDir = path.resolve(__dirname, '..', 'data', '_test_supervisor_vol');
if (fs.existsSync(testDataDir)) {
  fs.rmSync(testDataDir, { recursive: true, force: true });
}

// ── TEST 4: SUPERVISOR LIFECYCLE & PROCESS MANAGEMENT (SPAWN & SHUTDOWN) ──
console.log('\n--- 4. Supervisor Spawn & Graceful Shutdown Test ---');

// Test startSupervisor invocation
const supervisor = supervisorModule.startSupervisor({
  port: testPort,
  dataDir: testDataDir,
  silent: true,
});

assert(supervisor.webChild !== null, 'Supervisor spawned web child process');
assert(supervisor.workerChild !== null, 'Supervisor spawned worker child process');
assert(fs.existsSync(testDataDir), 'Supervisor created DATA_DIR root directory');
assert(fs.existsSync(path.join(testDataDir, 'resumes')), 'Supervisor created DATA_DIR/resumes directory');
assert(fs.existsSync(path.join(testDataDir, 'uploads')), 'Supervisor created DATA_DIR/uploads directory');

// Wait 1.5 seconds and trigger graceful shutdown
setTimeout(() => {
  console.log('\n--- Triggering Graceful Shutdown ---');
  supervisor.shutdown('SIGTERM');

  setTimeout(() => {
    assert(supervisor.workerChild.killed || supervisor.workerChild.exitCode !== null, 'Worker child received termination signal');
    assert(supervisor.webChild.killed || supervisor.webChild.exitCode !== null, 'Web child received termination signal');

    // Clean up test directory
    try {
      fs.rmSync(testDataDir, { recursive: true, force: true });
    } catch {}

    console.log('\n======================================================================');
    console.log(`SUPERVISOR VERIFICATION COMPLETE: ${passedTests} / ${totalTests} TESTS PASSED`);
    console.log('======================================================================');
    process.exit(0);
  }, 1000);
}, 1500);
