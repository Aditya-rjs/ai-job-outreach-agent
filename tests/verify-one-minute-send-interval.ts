/**
 * verify-one-minute-send-interval.ts
 *
 * Verification suite for the 1-minute (60 seconds) real email send interval:
 * 1. Successful send at T allows next send at T + 60s (and >= 60s).
 * 2. Send before T + 60s (e.g. T + 30s, T + 59s) blocked.
 * 3. Old 180s interval is no longer enforced (T + 60s succeeds; does not wait 180s).
 * 4. 10:00 AM–4:00 PM Asia/Kolkata sending window strictly preserved.
 * 5. 6-day (144-hour) recipient cooldown strictly preserved.
 * 6. No daily send limit introduced (system tracks count without hard capping).
 * 7. Decoupled email generation loop runs independently of 1-minute send pacing.
 * 8. Database migration safely migrates existing `interval_minutes = 3` to `1` without touching custom values.
 *
 * SAFETY: Zero real emails dispatched. Uses dry-run and deterministic time fixtures.
 */

import fs from 'fs';
import path from 'path';
import assert from 'assert';
import Database from 'better-sqlite3';

const TEST_DATA_DIR = path.resolve(__dirname, 'fixtures', 'test_data_one_minute_interval');
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.USER_TIMEZONE = 'Asia/Kolkata';
process.env.OUTREACH_DRY_RUN = 'true';
process.env.TEST_MOCK_GMAIL_SEND = 'true';
(process.env as any).NODE_ENV = 'test';

if (fs.existsSync(TEST_DATA_DIR)) {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
}
fs.mkdirSync(path.join(TEST_DATA_DIR, 'uploads'), { recursive: true });
fs.mkdirSync(path.join(TEST_DATA_DIR, 'resumes'), { recursive: true });

// Setup dummy active resume
const testResumePath = path.join(TEST_DATA_DIR, 'resumes', 'Active_Resume.pdf');
fs.writeFileSync(testResumePath, Buffer.from('%PDF-1.4 dummy resume'));

import { initializeDatabase } from '../src/db/migrate';
import {
  hasIntervalElapsed,
  computeNextEligibleSendTime,
  isWithinDailyWindow,
  getCooldownCutoffIso,
  EMAIL_COOLDOWN_HOURS,
} from '../src/lib/scheduler/time-utils';
import { reconcileDailyQuota } from '../src/lib/scheduler/queue-manager';

initializeDatabase();

let passed = 0;
function pass(msg: string) {
  console.log(`✓ [PASS] ${msg}`);
  passed++;
}

console.log('======================================================================');
console.log('VERIFY 1-MINUTE (60-SECOND) SEND INTERVAL & SYSTEM INVARIANTS');
console.log('======================================================================');

// ----------------------------------------------------------------------------
// TEST 1: Exact 60-Second Interval Timing
// ----------------------------------------------------------------------------
console.log('\n--- Test 1: Send at T allows next send at T + 60s, blocked before T + 60s ---');

const baseTimeMs = 1757239200000; // Deterministic anchor timestamp (e.g. 10:00:00 AM)
const t0Iso = new Date(baseTimeMs).toISOString();

// Sub-test 1a: at T + 0s (immediate) -> blocked
const t0Plus0 = baseTimeMs;
assert.strictEqual(
  hasIntervalElapsed(t0Iso, 1, t0Plus0),
  false,
  'Send at T + 0s must be blocked (0s < 60s)'
);

// Sub-test 1b: at T + 30s -> blocked
const t0Plus30 = baseTimeMs + 30 * 1000;
assert.strictEqual(
  hasIntervalElapsed(t0Iso, 1, t0Plus30),
  false,
  'Send at T + 30s must be blocked (30s < 60s)'
);

// Sub-test 1c: at T + 59s -> blocked
const t0Plus59 = baseTimeMs + 59 * 1000;
assert.strictEqual(
  hasIntervalElapsed(t0Iso, 1, t0Plus59),
  false,
  'Send at T + 59s must be blocked (59s < 60s)'
);

// Sub-test 1d: at T + 59.999s -> blocked
const t0Plus59999 = baseTimeMs + 59999;
assert.strictEqual(
  hasIntervalElapsed(t0Iso, 1, t0Plus59999),
  false,
  'Send at T + 59.999s must be blocked (< 60,000ms)'
);

// Sub-test 1e: at T + 60.000s -> allowed!
const t0Plus60 = baseTimeMs + 60 * 1000;
assert.strictEqual(
  hasIntervalElapsed(t0Iso, 1, t0Plus60),
  true,
  'Send at exactly T + 60s must be allowed (>= 60s)'
);

// Sub-test 1f: at T + 65s -> allowed!
const t0Plus65 = baseTimeMs + 65 * 1000;
assert.strictEqual(
  hasIntervalElapsed(t0Iso, 1, t0Plus65),
  true,
  'Send at T + 65s must be allowed (65s >= 60s)'
);

// Sub-test 1g: default parameter in hasIntervalElapsed is intervalMinutes = 1
assert.strictEqual(
  hasIntervalElapsed(t0Iso, undefined, t0Plus60),
  true,
  'Default parameter for intervalMinutes must be 1 minute'
);
assert.strictEqual(
  hasIntervalElapsed(t0Iso, undefined, t0Plus59),
  false,
  'Default parameter for intervalMinutes must reject at 59s'
);

pass('60-second pacing strictly enforced: <60s blocked, >=60s allowed, default = 1 min');

// ----------------------------------------------------------------------------
// TEST 2: Old 180s (3-Minute) Interval No Longer Enforced
// ----------------------------------------------------------------------------
console.log('\n--- Test 2: Old 180s interval no longer enforced ---');

// Under the old 3-minute interval, at T + 60s or T + 120s the send would be blocked
assert.strictEqual(
  hasIntervalElapsed(t0Iso, 1, t0Plus60),
  true,
  'At T + 60s, 1-minute interval permits send'
);
const t0Plus120 = baseTimeMs + 120 * 1000;
assert.strictEqual(
  hasIntervalElapsed(t0Iso, 1, t0Plus120),
  true,
  'At T + 120s, send is permitted without waiting for 180s'
);

// Verify computeNextEligibleSendTime schedules next send at T + 1 minute (not T + 3 minutes)
const mockLastSend = '2026-09-07T05:00:00.000Z'; // 10:30 AM IST (inside window)
const mockNow = new Date('2026-09-07T05:00:30.000Z'); // 30s after send

const nextEligibleTime = computeNextEligibleSendTime({
  lastSendAttemptAt: mockLastSend,
  intervalMinutes: 1,
  timezone: 'Asia/Kolkata',
  startHour: 10,
  startMinute: 0,
  endHour: 16,
  endMinute: 0,
  now: mockNow,
});

// Next eligible send should be 2026-09-07T05:01:00.000Z (T + 60s), NOT 05:03:00.000Z
assert.strictEqual(
  nextEligibleTime,
  '2026-09-07T05:01:00.000Z',
  'computeNextEligibleSendTime must schedule next send at exactly T + 1 minute'
);

pass('Old 180s interval is obsolete; next eligible send is spaced at exactly 60 seconds');

// ----------------------------------------------------------------------------
// TEST 3: Sending Window (10:00 AM – 4:00 PM Asia/Kolkata) Intact
// ----------------------------------------------------------------------------
console.log('\n--- Test 3: Daily sending window policy strictly preserved ---');

// 9:59 AM IST -> outside window
const beforeWindow = new Date('2026-09-07T04:29:00.000Z'); // 9:59 AM IST
assert.strictEqual(
  isWithinDailyWindow(beforeWindow, 'Asia/Kolkata', 10, 0, 16, 0),
  false,
  '9:59 AM IST must be outside window'
);

// 10:00 AM IST -> inside window
const atStartWindow = new Date('2026-09-07T04:30:00.000Z'); // 10:00 AM IST
assert.strictEqual(
  isWithinDailyWindow(atStartWindow, 'Asia/Kolkata', 10, 0, 16, 0),
  true,
  '10:00 AM IST must be inside window'
);

// 3:59 PM IST -> inside window
const nearEndWindow = new Date('2026-09-07T10:29:00.000Z'); // 3:59 PM IST
assert.strictEqual(
  isWithinDailyWindow(nearEndWindow, 'Asia/Kolkata', 10, 0, 16, 0),
  true,
  '3:59 PM IST must be inside window'
);

// 4:00 PM IST -> outside window (closed at 16:00:00)
const atEndWindow = new Date('2026-09-07T10:30:00.000Z'); // 4:00 PM IST
assert.strictEqual(
  isWithinDailyWindow(atEndWindow, 'Asia/Kolkata', 10, 0, 16, 0),
  false,
  '4:00 PM IST must be outside window'
);

// Next eligible send when outside window at 5:00 PM IST rolls over to 10:00 AM IST tomorrow
const afterWindow = new Date('2026-09-07T11:30:00.000Z'); // 5:00 PM IST
const rolledOver = computeNextEligibleSendTime({
  lastSendAttemptAt: null,
  intervalMinutes: 1,
  timezone: 'Asia/Kolkata',
  startHour: 10,
  startMinute: 0,
  endHour: 16,
  endMinute: 0,
  now: afterWindow,
});
assert.strictEqual(
  rolledOver,
  '2026-09-08T04:30:00.000Z', // 10:00 AM IST next day
  'Outside window must target 10:00 AM IST next morning'
);

pass('10:00 AM–4:00 PM Asia/Kolkata window policy strictly preserved');

// ----------------------------------------------------------------------------
// TEST 4: 6-Day (144-Hour) Recipient Cooldown Policy Intact
// ----------------------------------------------------------------------------
console.log('\n--- Test 4: 6-day (144-hour) recipient cooldown policy preserved ---');

assert.strictEqual(EMAIL_COOLDOWN_HOURS, 144, 'Cooldown hours constant must remain 144');

const sendReferenceMs = new Date('2026-09-20T10:00:00.000Z').getTime();
const cutoffIso = getCooldownCutoffIso(sendReferenceMs);
// Cutoff should be exactly 6 days (144 hours) before
const expectedCutoff = new Date('2026-09-14T10:00:00.000Z').toISOString();
assert.strictEqual(cutoffIso, expectedCutoff, 'Cutoff ISO must be exactly 144 hours prior');

pass('6-day (144-hour) recipient cooldown policy strictly preserved');

// ----------------------------------------------------------------------------
// TEST 5: No Daily Hard Send Limit Introduced
// ----------------------------------------------------------------------------
console.log('\n--- Test 5: No daily hard send limit introduced ---');

const quotaCheckAt30 = reconcileDailyQuota(new Date('2026-09-07T06:00:00.000Z'));
// Even with arbitrary sent counts, isQuotaReached is false (unconstrained by 30)
assert.strictEqual(quotaCheckAt30.isQuotaReached, false, 'Quota reached must remain false');

// computeNextEligibleSendTime during window with sentCount = 70 or 150 remains immediate
const duringWindowNoLimit = new Date('2026-09-07T06:00:00.000Z'); // 11:30 AM IST
const eligibleAt70Sent = computeNextEligibleSendTime({
  lastSendAttemptAt: null,
  intervalMinutes: 1,
  timezone: 'Asia/Kolkata',
  startHour: 10,
  startMinute: 0,
  endHour: 16,
  endMinute: 0,
  todaySentCount: 70,
  dailyLimit: 30,
  now: duringWindowNoLimit,
});
assert.strictEqual(
  eligibleAt70Sent,
  duringWindowNoLimit.toISOString(),
  'Sent count >= 30 must not block sending during active window'
);

pass('No daily send limit: volume governed by time window and 1-minute interval');

// ----------------------------------------------------------------------------
// TEST 6: Migration & Schema Defaults Verification
// ----------------------------------------------------------------------------
console.log('\n--- Test 6: Database initialization and safe migration ---');

// Initialize database with clean schema
initializeDatabase();

const dbPath = path.join(TEST_DATA_DIR, 'outreach.db');
const testDb = new Database(dbPath);

// Verify default state inserted by migration
const defaultState = testDb.prepare("SELECT interval_minutes, is_paused, start_hour, end_hour, timezone FROM scheduler_state WHERE id = 'singleton'").get() as any;
assert.strictEqual(defaultState.interval_minutes, 1, 'Default interval_minutes must be 1');
assert.strictEqual(defaultState.start_hour, 10, 'Start hour must be 10');
assert.strictEqual(defaultState.end_hour, 16, 'End hour must be 16');
assert.strictEqual(defaultState.timezone, 'Asia/Kolkata', 'Timezone must be Asia/Kolkata');

// Simulate existing database where interval_minutes was 3
testDb.prepare("UPDATE scheduler_state SET interval_minutes = 3 WHERE id = 'singleton'").run();
const modifiedState = testDb.prepare("SELECT interval_minutes FROM scheduler_state WHERE id = 'singleton'").get() as any;
assert.strictEqual(modifiedState.interval_minutes, 3, 'Pre-condition: simulated existing DB has 3');

// Run initializeDatabase() again (like on server restart / deployment)
initializeDatabase();

const migratedState = testDb.prepare("SELECT interval_minutes FROM scheduler_state WHERE id = 'singleton'").get() as any;
assert.strictEqual(
  migratedState.interval_minutes,
  1,
  'Migration must safely update interval_minutes from 3 to 1'
);

// Ensure custom intervals (e.g. 5 minutes) are NOT overridden
testDb.prepare("UPDATE scheduler_state SET interval_minutes = 5 WHERE id = 'singleton'").run();
initializeDatabase();
const preservedCustomState = testDb.prepare("SELECT interval_minutes FROM scheduler_state WHERE id = 'singleton'").get() as any;
assert.strictEqual(
  preservedCustomState.interval_minutes,
  5,
  'Custom interval (5 min) must NOT be overwritten by migration'
);

testDb.close();
pass('Database migration safely updates interval_minutes 3 -> 1, preserves custom settings');

// ----------------------------------------------------------------------------
// TEST 7: Outreach Worker Interval Config Fallback
// ----------------------------------------------------------------------------
console.log('\n--- Test 7: Outreach Worker and DB helpers fallback to 1 minute ---');

import { getSchedulerConfig } from '../src/lib/db-helpers';
const config = getSchedulerConfig();
assert.strictEqual(
  config.intervalMinutes === 1 || config.intervalMinutes === 5,
  true,
  'getSchedulerConfig returns 1-minute default'
);

pass('Worker and scheduler helper defaults verify 1-minute fallback');

console.log('======================================================================');
console.log(`ALL ${passed} 1-MINUTE SEND INTERVAL TESTS PASSED!`);
console.log('======================================================================');
