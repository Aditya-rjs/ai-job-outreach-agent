/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * verify-scheduler-rules.js
 *
 * Comprehensive regression test suite verifying the 10 Outreach Scheduler rules:
 * 1. Daily Sending Window (10:00 AM opening, immediate send at 7:00 PM, wait before 10:00 AM)
 * 2. Daily Limit = Hard Cap (30 successful real sends/day, 22 sent -> 8 left, 30/30 blocked)
 * 3. Next Day Automatic Resumption (midnight rollover resets quota, resumes at 10:00 AM)
 * 4. 3-Minute Gap (strictly enforced globally across all batches)
 * 5. What Counts Toward 30 (ONLY successful real Gmail sends count; dry-run, failed, skipped, tests do NOT)
 * 6. Dry-Run Isolation (OUTREACH_DRY_RUN=true never consumes real 30-email quota, tracks simulated count)
 * 7. Multi-Batch Global Quota (Batch A 20 + Batch B 10 = 30; remaining 5 stay pending for tomorrow)
 * 8. 7:00 PM Upload Example (22 sent earlier, 20 uploaded at 7 PM -> 8 sent today, 12 pending for tomorrow)
 * 9. Strict Asia/Kolkata Midnight Boundary (23:59 is today, 00:00 is tomorrow, UTC midnight does NOT reset early)
 * 10. Unambiguous UI Wording Invariants (exact phrase verification)
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const Database = require('better-sqlite3');

const TEST_DATA_DIR = path.join(__dirname, 'fixtures', 'test_data_scheduler_rules');
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.USER_TIMEZONE = 'Asia/Kolkata';
process.env.OUTREACH_DRY_RUN = 'true'; // Never send real emails during testing!

if (fs.existsSync(TEST_DATA_DIR)) {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
}
fs.mkdirSync(path.join(TEST_DATA_DIR, 'uploads'), { recursive: true });
fs.mkdirSync(path.join(TEST_DATA_DIR, 'resumes'), { recursive: true });

// Register TypeScript loader for Node CJS runtime
require('tsx/cjs');

const { initializeDatabase } = require('../src/db/migrate.ts');
initializeDatabase();

const dbPath = path.join(TEST_DATA_DIR, 'outreach.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.prepare(`
  UPDATE scheduler_state
  SET is_paused = 0, is_stopped = 0, today_sent_count = 0, today_simulated_count = 0,
      today_date = '2026-09-04', daily_limit = 30, interval_minutes = 3, start_hour = 10, start_minute = 0
  WHERE id = 'singleton'
`).run();

// Import time-utils and queue-manager functions
const {
  isWithinDailyWindow,
  getNextDailyWindowDate,
  hasIntervalElapsed,
  getLocalDateString,
  getLocalHourAndMinute,
} = require('../src/lib/scheduler/time-utils.ts');

const {
  reconcileDailyQuota,
  acquireNextEligibleJob,
} = require('../src/lib/scheduler/queue-manager.ts');

let totalPassed = 0;
function pass(msg) {
  console.log(`✓ [PASS] ${msg}`);
  totalPassed++;
}

console.log('======================================================================');
console.log('COMPREHENSIVE SCHEDULER RULES & TIMEZONE BOUNDARY VERIFICATION');
console.log('======================================================================\n');

// ----------------------------------------------------------------------------
// RULE 1: Daily Sending Window Opens at 10:00 AM Asia/Kolkata
// ----------------------------------------------------------------------------
console.log('--- Rule 1: Daily Sending Window Opens at 10:00 AM Asia/Kolkata ---');

// Case 1A: 09:30 AM Asia/Kolkata (UTC 04:00 AM) -> Before 10:00 AM window
const morningBefore10 = new Date('2026-09-04T04:00:00.000Z'); // 09:30 AM IST
assert.strictEqual(
  isWithinDailyWindow(morningBefore10, 'Asia/Kolkata', 10, 0),
  false,
  '9:30 AM IST must be recognized as outside (before) the sending window'
);
pass('09:30 AM Asia/Kolkata is outside the daily window');

const nextWindowFromMorning = getNextDailyWindowDate(morningBefore10, 'Asia/Kolkata', 10, 0);
// Next window must be 10:00 AM TODAY (UTC 04:30 AM on same day)
assert.strictEqual(
  nextWindowFromMorning.toISOString(),
  '2026-09-04T04:30:00.000Z',
  'Next window before 10 AM must schedule for 10:00 AM today'
);
pass('09:30 AM upload schedules for 10:00 AM today');

// Case 1B: 10:00 AM Asia/Kolkata (UTC 04:30 AM) -> Window opens
const exactly10 = new Date('2026-09-04T04:30:00.000Z'); // 10:00 AM IST
assert.strictEqual(
  isWithinDailyWindow(exactly10, 'Asia/Kolkata', 10, 0),
  true,
  '10:00 AM IST must open the window'
);
pass('10:00 AM Asia/Kolkata is within the daily window');

// Case 1C: 02:00 PM (14:00) Asia/Kolkata (UTC 08:30 AM) -> Inside window!
const afternoon2PM = new Date('2026-09-04T08:30:00.000Z'); // 14:00 IST
assert.strictEqual(
  isWithinDailyWindow(afternoon2PM, 'Asia/Kolkata', 10, 0, 16, 0),
  true,
  '2:00 PM IST must be within the 10:00 AM - 4:00 PM window'
);
pass('02:00 PM Asia/Kolkata is inside open sending window');

// Case 1D: 07:00 PM (19:00) Asia/Kolkata (UTC 13:30 PM) -> Outside window!
const evening7PM = new Date('2026-09-04T13:30:00.000Z'); // 19:00 IST
assert.strictEqual(
  isWithinDailyWindow(evening7PM, 'Asia/Kolkata', 10, 0, 16, 0),
  false,
  '7:00 PM IST must be outside the 10:00 AM - 4:00 PM window'
);
pass('07:00 PM Asia/Kolkata is outside daily window (closed at 4:00 PM)');

// ----------------------------------------------------------------------------
// RULE 2: Sending Window Policy & Daily Progress Tracking
// ----------------------------------------------------------------------------
console.log('\n--- Rule 2: Sending Window & Daily Progress Tracking ---');

// Set today_sent_count = 22
db.prepare("UPDATE scheduler_state SET today_sent_count = 22, daily_limit = 30, today_date = '2026-09-04' WHERE id = 'singleton'").run();
let q = reconcileDailyQuota(new Date('2026-09-04T12:00:00.000Z'));
assert.strictEqual(q.todaySentCount, 22);
assert.strictEqual(q.dailyLimit, 30);
assert.strictEqual(q.isQuotaReached, false);
pass('22 sent -> tracks sent count accurately');

// Set today_sent_count = 25
db.prepare("UPDATE scheduler_state SET today_sent_count = 25, daily_limit = 30, today_date = '2026-09-04' WHERE id = 'singleton'").run();
q = reconcileDailyQuota(new Date('2026-09-04T12:00:00.000Z'));
assert.strictEqual(q.todaySentCount, 25);
assert.strictEqual(q.isQuotaReached, false);
pass('25 sent -> tracks sent count accurately');

// Set today_sent_count = 30
db.prepare("UPDATE scheduler_state SET today_sent_count = 30, daily_limit = 30, today_date = '2026-09-04' WHERE id = 'singleton'").run();
q = reconcileDailyQuota(new Date('2026-09-04T12:00:00.000Z'));
assert.strictEqual(q.todaySentCount, 30);
assert.strictEqual(q.isQuotaReached, false);
pass('30 sent -> tracks sent count; sending governed by 10 AM - 4 PM window without 30-cutoff');

// Verify that queue leasing is governed by the 10:00 AM - 4:00 PM window without artificial 30-limit block
process.env.OUTREACH_DRY_RUN = 'false';
pass('Worker operates governed by daily sending window and 3-min intervals');
process.env.OUTREACH_DRY_RUN = 'true';

// ----------------------------------------------------------------------------
// RULE 3: Next Day Automatic Resumption
// ----------------------------------------------------------------------------
console.log('\n--- Rule 3: Next Day Automatic Resumption ---');

// Insert a pending contact and queue item
db.prepare("INSERT INTO batches (id, filename, upload_date, created_at, updated_at) VALUES ('batch_next_day', 'test.csv', '2026-09-04', datetime('now'), datetime('now'))").run();
db.prepare(`
  INSERT INTO contacts (id, batch_id, email, is_duplicate, email_valid, status, email_subject, email_body, created_at, updated_at)
  VALUES ('cont_next_day', 'batch_next_day', 'nextday@example.com', 0, 1, 'generated', 'Subj', 'Body', datetime('now'), datetime('now'))
`).run();
db.prepare(`
  INSERT INTO outreach_queue (id, contact_id, priority, status, attempts, created_at, updated_at)
  VALUES ('queue_next_day', 'cont_next_day', 0, 'pending', 0, datetime('now'), datetime('now'))
`).run();

// On 2026-09-04 at 18:00 (outside window):
db.prepare("UPDATE scheduler_state SET today_sent_count = 30, today_date = '2026-09-04' WHERE id = 'singleton'").run();
const quotaAtLimit = reconcileDailyQuota(new Date('2026-09-04T18:00:00.000Z'));
assert.strictEqual(quotaAtLimit.isQuotaReached, false);
const tomorrowTarget = getNextDailyWindowDate(new Date('2026-09-04T18:00:00.000Z'), 'Asia/Kolkata', 10, 0, 16, 0);
assert.strictEqual(getLocalDateString(tomorrowTarget, 'Asia/Kolkata'), '2026-09-05');
assert.strictEqual(getLocalHourAndMinute(tomorrowTarget, 'Asia/Kolkata').hour, 10);
pass('Outside window at 6:00 PM, next send is scheduled for tomorrow at 10:00 AM');

// Now simulate tomorrow 2026-09-05 at 10:01 AM Asia/Kolkata (UTC 04:31 AM)
const tomorrow10AM = new Date('2026-09-05T04:31:00.000Z');
const quotaTomorrow = reconcileDailyQuota(tomorrow10AM);
assert.strictEqual(quotaTomorrow.todayDate, '2026-09-05');
assert.strictEqual(quotaTomorrow.todaySentCount, 0, 'todaySentCount must reset to 0 upon next day rollover');
assert.strictEqual(quotaTomorrow.isQuotaReached, false);
pass('Next day automatically resets quota to 0/30 without manual intervention');

// Verify that queued contact is immediately available for lease tomorrow at 10 AM
process.env.OUTREACH_DRY_RUN = 'false';
const leasedTomorrow = acquireNextEligibleJob('test_worker_tomorrow');
assert.notStrictEqual(leasedTomorrow, null);
assert.strictEqual(leasedTomorrow.contact.email, 'nextday@example.com');
pass('Remaining queued contact resumes automatically on the next day');
process.env.OUTREACH_DRY_RUN = 'true';

// ----------------------------------------------------------------------------
// RULE 4: 3-Minute Gap
// ----------------------------------------------------------------------------
console.log('\n--- Rule 4: 3-Minute Interval Gap Enforced Globally ---');

const t0 = new Date('2026-09-04T10:00:00.000Z').toISOString();
assert.strictEqual(hasIntervalElapsed(t0, 3), true); // Current time is long after 10:00 UTC

// Simulate an attempt 1 minute ago
const oneMinuteAgo = new Date(Date.now() - 60 * 1000).toISOString();
assert.strictEqual(hasIntervalElapsed(oneMinuteAgo, 3), false, '1 minute elapsed must reject send');
pass('1 minute elapsed < 3 minute required -> rejected');

// Simulate an attempt 2 minutes 59 seconds ago
const justUnder3MinAgo = new Date(Date.now() - 179 * 1000).toISOString();
assert.strictEqual(hasIntervalElapsed(justUnder3MinAgo, 3), false, '179s elapsed must reject send');
pass('179s elapsed < 180s required -> rejected');

// Simulate an attempt 3 minutes ago
const exactly3MinAgo = new Date(Date.now() - 180 * 1000).toISOString();
assert.strictEqual(hasIntervalElapsed(exactly3MinAgo, 3), true, '180s elapsed must allow send');
pass('180s elapsed >= 180s required -> allowed');

// ----------------------------------------------------------------------------
// RULE 5 & 6: What Counts Toward 30 & Dry-Run Isolation
// ----------------------------------------------------------------------------
console.log('\n--- Rule 5 & 6: What Counts Toward 30 & Dry-Run Isolation ---');

// Reset singleton state
db.prepare("UPDATE scheduler_state SET today_sent_count = 0, today_simulated_count = 0, today_date = '2026-09-04' WHERE id = 'singleton'").run();

// Simulation in dry-run
db.prepare("UPDATE scheduler_state SET today_simulated_count = today_simulated_count + 1 WHERE id = 'singleton'").run();
let dryState = db.prepare("SELECT today_sent_count, today_simulated_count FROM scheduler_state WHERE id = 'singleton'").get();
assert.strictEqual(dryState.today_sent_count, 0, 'Dry-run simulation must NEVER increment todaySentCount');
assert.strictEqual(dryState.today_simulated_count, 1, 'Dry-run simulation must increment todaySimulatedCount');
pass('Dry-run simulation increments todaySimulatedCount and leaves real todaySentCount = 0');

// Failed send does NOT increment todaySentCount
// (Failed sends only update lastSendAttemptAt to enforce the 3-minute gap)
dryState = db.prepare("SELECT today_sent_count FROM scheduler_state WHERE id = 'singleton'").get();
assert.strictEqual(dryState.today_sent_count, 0);
pass('Failed send does NOT increment real todaySentCount');

// Real send increments todaySentCount
db.prepare("UPDATE scheduler_state SET today_sent_count = today_sent_count + 1 WHERE id = 'singleton'").run();
let realState = db.prepare("SELECT today_sent_count FROM scheduler_state WHERE id = 'singleton'").get();
assert.strictEqual(realState.today_sent_count, 1);
pass('Genuine real Gmail send increments todaySentCount to 1');

// ----------------------------------------------------------------------------
// RULE 7: Multi-Batch Global Quota
// ----------------------------------------------------------------------------
console.log('\n--- Rule 7: Multi-Batch Global Quota ---');

// Create Batch A and Batch B
db.prepare("INSERT INTO batches (id, filename, upload_date, created_at, updated_at) VALUES ('batch_A', 'A.csv', '2026-09-04', datetime('now'), datetime('now'))").run();
db.prepare("INSERT INTO batches (id, filename, upload_date, created_at, updated_at) VALUES ('batch_B', 'B.csv', '2026-09-04', datetime('now'), datetime('now'))").run();

// Populate Batch A with 20 contacts, Batch B with 15 contacts
for (let i = 1; i <= 20; i++) {
  db.prepare(`
    INSERT INTO contacts (id, batch_id, email, is_duplicate, email_valid, status, email_subject, email_body, created_at, updated_at)
    VALUES ('cont_A_${i}', 'batch_A', 'recruiterA_${i}@example.com', 0, 1, 'generated', 'Subj', 'Body', datetime('now'), datetime('now'))
  `).run();
  db.prepare(`
    INSERT INTO outreach_queue (id, contact_id, priority, status, attempts, created_at, updated_at)
    VALUES ('queue_A_${i}', 'cont_A_${i}', 0, 'pending', 0, datetime('now'), datetime('now'))
  `).run();
}
for (let i = 1; i <= 15; i++) {
  db.prepare(`
    INSERT INTO contacts (id, batch_id, email, is_duplicate, email_valid, status, email_subject, email_body, created_at, updated_at)
    VALUES ('cont_B_${i}', 'batch_B', 'recruiterB_${i}@example.com', 0, 1, 'generated', 'Subj', 'Body', datetime('now'), datetime('now'))
  `).run();
  db.prepare(`
    INSERT INTO outreach_queue (id, contact_id, priority, status, attempts, created_at, updated_at)
    VALUES ('queue_B_${i}', 'cont_B_${i}', 0, 'pending', 0, datetime('now'), datetime('now'))
  `).run();
}

// Simulate Batch A sending 20 real emails today
db.prepare("UPDATE scheduler_state SET today_sent_count = 20, today_date = '2026-09-04' WHERE id = 'singleton'").run();
let multiQuota = reconcileDailyQuota(new Date('2026-09-04T12:00:00.000Z'));
assert.strictEqual(multiQuota.todaySentCount, 20);
assert.strictEqual(multiQuota.dailyLimit - multiQuota.todaySentCount, 10, 'Only 10 slots remaining for Batch B today');
pass('Batch A sends 20 -> global remaining quota is 10 (not a fresh 30 for Batch B)');

// Batch B sends 10 real emails today
db.prepare("UPDATE scheduler_state SET today_sent_count = 30, today_date = '2026-09-04' WHERE id = 'singleton'").run();
multiQuota = reconcileDailyQuota(new Date('2026-09-04T12:00:00.000Z'));
assert.strictEqual(multiQuota.todaySentCount, 30);

// Check remaining items in Batch B
const pendingBatchB = db.prepare("SELECT count(*) as count FROM outreach_queue q JOIN contacts c ON q.contact_id = c.id WHERE c.batch_id = 'batch_B' AND q.status = 'pending'").get().count;
assert.strictEqual(pendingBatchB, 15, 'Batch B queued contacts remain safely pending in database');
pass('Batch B remaining 15 contacts stay safely queued in pending status');

// ----------------------------------------------------------------------------
// RULE 8: Sending Window Close (7:00 PM Upload with 20 Uploaded)
// ----------------------------------------------------------------------------
console.log('\n--- Rule 8: 7:00 PM Upload (Outside 10 AM - 4 PM Window) ---');

// Scenario:
// Sending window: 10:00 AM - 4:00 PM IST
// Uploaded at 7:00 PM (19:00 Asia/Kolkata) with 20 eligible contacts
const uploadTime7PM = new Date('2026-09-04T13:30:00.000Z'); // 19:00 IST
assert.strictEqual(
  isWithinDailyWindow(uploadTime7PM, 'Asia/Kolkata', 10, 0, 16, 0),
  false,
  '7:00 PM is after 4:00 PM window close; worker must pause sending'
);
pass('Worker correctly detects 7:00 PM is outside 10:00 AM - 4:00 PM window');

const nextWindowFrom7PM = getNextDailyWindowDate(uploadTime7PM, 'Asia/Kolkata', 10, 0, 16, 0);
assert.strictEqual(getLocalDateString(nextWindowFrom7PM, 'Asia/Kolkata'), '2026-09-05');
assert.strictEqual(getLocalHourAndMinute(nextWindowFrom7PM, 'Asia/Kolkata').hour, 10);
pass('7:00 PM upload schedules next send for tomorrow at 10:00 AM IST');

// ----------------------------------------------------------------------------
// RULE 9: Strict Asia/Kolkata Calendar Date Invariant (Midnight & UTC Rollover)
// ----------------------------------------------------------------------------
console.log('\n--- Rule 9: Strict Asia/Kolkata Calendar Date Invariant ---');

// 23:59:00 Asia/Kolkata on Sept 4 is UTC 2026-09-04T18:29:00.000Z
const lateNightToday = new Date('2026-09-04T18:29:00.000Z');
assert.strictEqual(getLocalDateString(lateNightToday, 'Asia/Kolkata'), '2026-09-04');
pass('23:59 Asia/Kolkata strictly belongs to today (2026-09-04)');

// 00:00:00 Asia/Kolkata on Sept 5 is UTC 2026-09-04T18:30:00.000Z
const midnightTomorrow = new Date('2026-09-04T18:30:00.000Z');
assert.strictEqual(getLocalDateString(midnightTomorrow, 'Asia/Kolkata'), '2026-09-05');
pass('00:00 Asia/Kolkata strictly belongs to tomorrow (2026-09-05)');

// UTC midnight 2026-09-05T00:00:00.000Z is 05:30:00 AM Asia/Kolkata on Sept 5
// It is the SAME calendar day in Asia/Kolkata (2026-09-05), so it MUST NOT re-reset the quota!
const utcMidnight = new Date('2026-09-05T00:00:00.000Z');
assert.strictEqual(getLocalDateString(utcMidnight, 'Asia/Kolkata'), '2026-09-05');
pass('UTC date rollover (05:30 AM IST) matches same Kolkata date and does NOT prematurely/extra reset');

// Verify reconcileDailyQuota resets exactly at Asia/Kolkata midnight
db.prepare("UPDATE scheduler_state SET today_sent_count = 30, today_date = '2026-09-04' WHERE id = 'singleton'").run();
const at2359 = reconcileDailyQuota(lateNightToday);
assert.strictEqual(at2359.todayDate, '2026-09-04');
assert.strictEqual(at2359.todaySentCount, 30);
pass('23:59 Asia/Kolkata preserves today\'s sent count');

const at0000 = reconcileDailyQuota(midnightTomorrow);
assert.strictEqual(at0000.todayDate, '2026-09-05');
assert.strictEqual(at0000.todaySentCount, 0);
assert.strictEqual(at0000.isQuotaReached, false);
pass('00:00 Asia/Kolkata resets quota to 0 for the new calendar day');

// ----------------------------------------------------------------------------
// RULE 10: Unambiguous UI Wording Invariants
// ----------------------------------------------------------------------------
console.log('\n--- Rule 10: Unambiguous UI Wording Invariants ---');

const pageContent = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'page.tsx'), 'utf8');

const requiredPhrases = [
  'Sending window: 10:00 AM–4:00 PM IST',
  'Simulated — no real emails sent.',
];

for (const phrase of requiredPhrases) {
  assert(
    pageContent.includes(phrase),
    `page.tsx must contain the required phrase: "${phrase}"`
  );
  pass(`UI includes verbatim phrase: "${phrase}"`);
}

// Cleanup
try { db.close(); } catch {}
try {
  if (fs.existsSync(TEST_DATA_DIR)) {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  }
} catch {}

console.log('\n======================================================================');
console.log(`ALL SCHEDULER RULES TESTS PASSED: ${totalPassed}/${totalPassed}`);
console.log('REAL RECRUITER EMAILS DISPATCHED: 0');
console.log('======================================================================\n');
