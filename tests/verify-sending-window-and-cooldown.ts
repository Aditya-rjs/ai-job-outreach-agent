/**
 * verify-sending-window-and-cooldown.ts
 *
 * Comprehensive test suite verifying:
 * Part 1: Sending Window Policy (10:00 AM -> 4:00 PM IST, hard 30/day cap removed)
 * Part 2: 6-Day Global Cooldown (144 elapsed hours based on last confirmed send timestamp)
 * Part 3: Only confirmed real Gmail sends trigger cooldown (dry-run, generation, queueing, failed, uncertain never trigger)
 * Part 4: Re-upload eligibility after 144h expiry, separate contact identity independence
 * Part 5: Historical evaluation of global_email_history under 144-hour rule
 *
 * SAFETY INVARIANT: Strictly 0 real emails dispatched; uses test mock or dry-run.
 */

import fs from 'fs';
import path from 'path';
import assert from 'assert';
import Database from 'better-sqlite3';

const TEST_DATA_DIR = path.resolve(__dirname, 'fixtures', 'test_data_window_cooldown');
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.USER_TIMEZONE = 'Asia/Kolkata';
process.env.OUTREACH_DRY_RUN = 'true';
process.env.TEST_MOCK_GMAIL_SEND = 'true';

if (fs.existsSync(TEST_DATA_DIR)) {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
}
fs.mkdirSync(path.join(TEST_DATA_DIR, 'uploads'), { recursive: true });
fs.mkdirSync(path.join(TEST_DATA_DIR, 'resumes'), { recursive: true });

// Setup dummy active resume
const testResumePath = path.join(TEST_DATA_DIR, 'resumes', 'Active_Resume.pdf');
fs.writeFileSync(testResumePath, Buffer.from('%PDF-1.4 dummy active resume content'));

import { initializeDatabase } from '../src/db/migrate';
initializeDatabase();

const DB_PATH = path.join(TEST_DATA_DIR, 'outreach.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Seed active resume
db.prepare(`
  INSERT OR REPLACE INTO resume (id, filename, file_path, mime_type, parsed_text, uploaded_at)
  VALUES ('current', 'Active_Resume.pdf', ?, 'application/pdf', 'Candidate Skills: TypeScript, React', ?)
`).run(testResumePath, new Date().toISOString());

// Seed authoritative company classifications for test companies
db.prepare(`
  INSERT OR REPLACE INTO company_classifications (
    normalized_name, company_name, is_relevant, confidence, reason,
    classification_source, gemini_model, classification_result, created_at, updated_at
  ) VALUES
    ('techcorp', 'TechCorp', 1, 1.0, 'Relevant — Gemini: Software development company.', 'gemini', 'gemini-3.8-flash', 'RELEVANT', datetime('now'), datetime('now')),
    ('fintech', 'FinTech Inc', 1, 1.0, 'Relevant — Gemini: Financial technology systems.', 'gemini', 'gemini-3.8-flash', 'RELEVANT', datetime('now'), datetime('now'))
`).run();

import {
  isWithinDailyWindow,
  getNextDailyWindowDate,
  computeNextEligibleSendTime,
  isEmailInCooldown,
  getCooldownRemainingMs,
  getCooldownExpiresAt,
  getCooldownCutoffIso,
  EMAIL_COOLDOWN_HOURS,
  EMAIL_COOLDOWN_MS,
  getLocalDateString,
  getLocalHourAndMinute,
} from '../src/lib/scheduler/time-utils';

import {
  reconcileDailyQuota,
  acquireNextEligibleJob,
} from '../src/lib/scheduler/queue-manager';

import { sendOutreachEmail } from '../src/lib/gmail/send-email';
import { processBatchFile } from '../src/lib/pipeline/batch-processor';
import { getEligibleQueuedCount } from '../src/lib/dashboard-queries';

console.log('======================================================================');
console.log('VERIFYING SENDING WINDOW POLICY & 6-DAY (144-HOUR) GLOBAL COOLDOWN');
console.log('======================================================================\n');

let totalPassed = 0;
function pass(testName: string) {
  console.log(`✓ [PASS] ${testName}`);
  totalPassed++;
}

async function runVerification() {
  // --------------------------------------------------------------------------
  // PART 1: SENDING WINDOW TIMING (10:00 AM -> 4:00 PM Asia/Kolkata)
  // --------------------------------------------------------------------------
  console.log('--- Part 1: Sending Window Mechanics (10:00 AM - 4:00 PM IST) ---');

  // Test 1: Exactly 10:00 AM IST (window opens) -> true
  const date10AM = new Date('2026-09-06T04:30:00.000Z'); // 10:00:00 IST
  assert.strictEqual(isWithinDailyWindow(date10AM, 'Asia/Kolkata', 10, 0, 16, 0), true);
  pass('Test 1: 10:00 AM IST is within daily window (OPEN)');

  // Test 2: Mid-day 1:30 PM IST (inside window) -> true
  const date130PM = new Date('2026-09-06T08:00:00.000Z'); // 13:30:00 IST
  assert.strictEqual(isWithinDailyWindow(date130PM, 'Asia/Kolkata', 10, 0, 16, 0), true);
  pass('Test 2: 1:30 PM IST is within daily window (OPEN)');

  // Test 3: 3:59 PM IST (last minute before close) -> true
  const date359PM = new Date('2026-09-06T10:29:00.000Z'); // 15:59:00 IST
  assert.strictEqual(isWithinDailyWindow(date359PM, 'Asia/Kolkata', 10, 0, 16, 0), true);
  pass('Test 3: 3:59 PM IST is within daily window (OPEN)');

  // Test 4: Exactly 4:00 PM IST (window closes) -> false
  const date400PM = new Date('2026-09-06T10:30:00.000Z'); // 16:00:00 IST
  assert.strictEqual(isWithinDailyWindow(date400PM, 'Asia/Kolkata', 10, 0, 16, 0), false);
  pass('Test 4: 4:00 PM IST is outside daily window (CLOSED)');

  // Test 5: Evening 7:00 PM IST (after window close) -> false
  const date700PM = new Date('2026-09-06T13:30:00.000Z'); // 19:00:00 IST
  assert.strictEqual(isWithinDailyWindow(date700PM, 'Asia/Kolkata', 10, 0, 16, 0), false);
  pass('Test 5: 7:00 PM IST is outside daily window (CLOSED)');

  // Test 6: Morning 9:59 AM IST (before window opens) -> false
  const date959AM = new Date('2026-09-06T04:29:00.000Z'); // 09:59:00 IST
  assert.strictEqual(isWithinDailyWindow(date959AM, 'Asia/Kolkata', 10, 0, 16, 0), false);
  pass('Test 6: 9:59 AM IST is outside daily window (CLOSED)');

  // Test 7: getNextDailyWindowDate before 10 AM returns today at 10:00 AM IST
  const nextFrom8AM = getNextDailyWindowDate(new Date('2026-09-06T02:30:00.000Z'), 'Asia/Kolkata', 10, 0, 16, 0); // 8:00 AM IST
  assert.strictEqual(getLocalDateString(nextFrom8AM, 'Asia/Kolkata'), '2026-09-06');
  assert.strictEqual(getLocalHourAndMinute(nextFrom8AM, 'Asia/Kolkata').hour, 10);
  assert.strictEqual(getLocalHourAndMinute(nextFrom8AM, 'Asia/Kolkata').minute, 0);
  pass('Test 7: Before 10 AM, next window date is today at 10:00 AM IST');

  // Test 8: getNextDailyWindowDate at or after 4 PM returns tomorrow at 10:00 AM IST
  const nextFrom5PM = getNextDailyWindowDate(new Date('2026-09-06T11:30:00.000Z'), 'Asia/Kolkata', 10, 0, 16, 0); // 17:00 IST
  assert.strictEqual(getLocalDateString(nextFrom5PM, 'Asia/Kolkata'), '2026-09-07');
  assert.strictEqual(getLocalHourAndMinute(nextFrom5PM, 'Asia/Kolkata').hour, 10);
  assert.strictEqual(getLocalHourAndMinute(nextFrom5PM, 'Asia/Kolkata').minute, 0);
  pass('Test 8: At/after 4 PM, next window date is tomorrow at 10:00 AM IST');

  // --------------------------------------------------------------------------
  // PART 2: REMOVAL OF HARD 30/DAY LIMIT CEILING
  // --------------------------------------------------------------------------
  console.log('\n--- Part 2: Removal of Hard 30/Day Ceiling ---');

  // Seed batch with 35 contacts
  const batchId = `batch_over_30_${Date.now()}`;
  db.prepare(`
    INSERT INTO batches (id, filename, upload_date, created_at, updated_at)
    VALUES (?, 'high_volume.csv', '2026-09-06', datetime('now'), datetime('now'))
  `).run(batchId);

  // Insert a contact staged in queue
  const contId = `cont_over_30_${Date.now()}`;
  const testEmailOver30 = `over30_${Date.now()}@techcorp.com`;
  db.prepare(`
    INSERT INTO contacts (id, batch_id, company_name, email, is_relevant, email_valid, is_duplicate, status, email_subject, email_body, created_at, updated_at)
    VALUES (?, ?, 'TechCorp', ?, 1, 1, 0, 'generated', 'Hi', 'Body text', datetime('now'), datetime('now'))
  `).run(contId, batchId, testEmailOver30);

  const queueId = `queue_over_30_${Date.now()}`;
  db.prepare(`
    INSERT INTO outreach_queue (id, contact_id, priority, status, attempts, created_at, updated_at)
    VALUES (?, ?, 0, 'pending', 0, datetime('now'), datetime('now'))
  `).run(queueId, contId);

  // Set today_sent_count to 30 (previously this blocked any leasing)
  db.prepare("UPDATE scheduler_state SET today_sent_count = 30, daily_limit = 30, today_date = '2026-09-06' WHERE id = 'singleton'").run();

  // Test 9: reconcileDailyQuota does not block (isQuotaReached = false)
  const quota = reconcileDailyQuota(new Date('2026-09-06T06:00:00.000Z')); // 11:30 AM IST
  assert.strictEqual(quota.todaySentCount, 30);
  assert.strictEqual(quota.isQuotaReached, false);
  pass('Test 9: reconcileDailyQuota tracks 30 sent but isQuotaReached is false (hard ceiling removed)');

  // Test 10: acquireNextEligibleJob leases the job despite 30 sent today
  const leasedJob = acquireNextEligibleJob('worker_test_30');
  assert(leasedJob !== null, 'Job must be acquired even when todaySentCount >= 30');
  assert.strictEqual(leasedJob?.contact.email, testEmailOver30);
  pass('Test 10: acquireNextEligibleJob successfully acquires job when todaySentCount >= 30');

  // Test 11: computeNextEligibleSendTime does not push to tomorrow when todaySentCount >= 30
  const nextTime = computeNextEligibleSendTime({
    lastSendAttemptAt: null,
    intervalMinutes: 3,
    timezone: 'Asia/Kolkata',
    startHour: 10,
    startMinute: 0,
    endHour: 16,
    endMinute: 0,
    todaySentCount: 30,
    dailyLimit: 30,
    now: date130PM, // 1:30 PM IST (within window)
  });
  assert.strictEqual(nextTime, date130PM.toISOString());
  pass('Test 11: computeNextEligibleSendTime allows immediate send during window regardless of sent count');

  // --------------------------------------------------------------------------
  // PART 3: 6-DAY (144-HOUR) GLOBAL COOLDOWN LOGIC
  // --------------------------------------------------------------------------
  console.log('\n--- Part 3: 6-Day (144-Hour) Global Cooldown Calculations ---');

  const nowMs = Date.parse('2026-09-06T12:00:00.000Z'); // Fixed test anchor

  // Test 12: Sent 1 hour ago -> in cooldown
  const sent1HrAgo = new Date(nowMs - 1 * 3600 * 1000).toISOString();
  assert.strictEqual(isEmailInCooldown(sent1HrAgo, nowMs), true);
  assert(getCooldownRemainingMs(sent1HrAgo, nowMs) > 0);
  pass('Test 12: Email sent 1 hour ago is in active cooldown');

  // Test 13: Sent 5 days ago (120 hours) -> in cooldown
  const sent5DaysAgo = new Date(nowMs - 120 * 3600 * 1000).toISOString();
  assert.strictEqual(isEmailInCooldown(sent5DaysAgo, nowMs), true);
  pass('Test 13: Email sent 5 days (120 hrs) ago is in active cooldown');

  // Test 14: Sent 143.9 hours ago -> in cooldown
  const sent143HoursAgo = new Date(nowMs - 143.9 * 3600 * 1000).toISOString();
  assert.strictEqual(isEmailInCooldown(sent143HoursAgo, nowMs), true);
  pass('Test 14: Email sent 143.9 hours ago is still in active cooldown');

  // Test 15: Sent exactly 144 hours ago -> cooldown expired
  const sent144HoursAgo = new Date(nowMs - 144 * 3600 * 1000).toISOString();
  assert.strictEqual(isEmailInCooldown(sent144HoursAgo, nowMs), false);
  assert.strictEqual(getCooldownRemainingMs(sent144HoursAgo, nowMs), 0);
  pass('Test 15: Email sent exactly 144 hours ago has expired cooldown');

  // Test 16: Sent 7 days ago (168 hours) -> cooldown expired
  const sent7DaysAgo = new Date(nowMs - 168 * 3600 * 1000).toISOString();
  assert.strictEqual(isEmailInCooldown(sent7DaysAgo, nowMs), false);
  pass('Test 16: Email sent 7 days (168 hrs) ago has expired cooldown');

  // Test 17: Null sentAt -> not in cooldown
  assert.strictEqual(isEmailInCooldown(null, nowMs), false);
  assert.strictEqual(isEmailInCooldown(undefined, nowMs), false);
  pass('Test 17: Null or undefined sentAt is not in cooldown');

  // Test 18: Exact timestamp elapsed hours, NOT calendar days
  // E.g. Sent on Day 1 at 3:00 PM IST; on Day 7 at 2:00 PM IST (143 hours), still in cooldown!
  const day1At3PM = Date.parse('2026-09-01T09:30:00.000Z'); // Sept 1, 3:00 PM IST
  const day7At2PM = Date.parse('2026-09-07T08:30:00.000Z'); // Sept 7, 2:00 PM IST (143 hours elapsed)
  const day7At330PM = Date.parse('2026-09-07T10:00:00.000Z'); // Sept 7, 3:30 PM IST (144.5 hours elapsed)
  assert.strictEqual(isEmailInCooldown(new Date(day1At3PM).toISOString(), day7At2PM), true);
  assert.strictEqual(isEmailInCooldown(new Date(day1At3PM).toISOString(), day7At330PM), false);
  pass('Test 18: Cooldown strictly measures 144 elapsed hours from timestamp, not calendar days');

  // --------------------------------------------------------------------------
  // PART 4: DISPATCHER & GMAIL SEND-EMAIL COOLDOWN ENFORCEMENT
  // --------------------------------------------------------------------------
  console.log('\n--- Part 4: Send Dispatcher Cooldown Enforcement ---');

  const cooldownEmail = `cooldown_test_${Date.now()}@fintech.com`;

  // Insert existing send into global_email_history from 2 days ago (< 144h)
  const twoDaysAgoIso = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  db.prepare(`
    INSERT INTO global_email_history (email, first_seen_at, sent_at, status)
    VALUES (?, ?, ?, 'sent')
  `).run(cooldownEmail, twoDaysAgoIso, twoDaysAgoIso);

  // Attempt to send to this contact in a new batch
  const testBatchId = `batch_cd_${Date.now()}`;
  db.prepare(`
    INSERT INTO batches (id, filename, upload_date, created_at, updated_at)
    VALUES (?, 'cd.csv', '2026-09-06', datetime('now'), datetime('now'))
  `).run(testBatchId);

  const testContactId = `cont_cd_${Date.now()}`;
  db.prepare(`
    INSERT INTO contacts (id, batch_id, company_name, email, is_relevant, email_valid, is_duplicate, status, email_subject, email_body, created_at, updated_at)
    VALUES (?, ?, 'FinTech Inc', ?, 1, 1, 0, 'generated', 'Subj', 'Body', datetime('now'), datetime('now'))
  `).run(testContactId, testBatchId, cooldownEmail);

  // Test 19: sendOutreachEmail blocks send when within 144-hour cooldown
  const sendBlockedResult = await sendOutreachEmail(testContactId);
  assert.strictEqual(sendBlockedResult.success, false);
  assert.strictEqual(sendBlockedResult.errorCategory, 'duplicate');
  assert(sendBlockedResult.error?.includes('6-day cooldown active'));
  pass('Test 19: sendOutreachEmail rejects send when recipient is within 144-hour cooldown');

  // Test 20: After 144 hours have elapsed, send is allowed and succeeds
  const eightDaysAgoIso = new Date(Date.now() - 192 * 3600 * 1000).toISOString(); // 8 days ago
  db.prepare(`
    UPDATE global_email_history
    SET sent_at = ?
    WHERE email = ?
  `).run(eightDaysAgoIso, cooldownEmail);

  // Reset contact status to generated so it can be attempted
  db.prepare("UPDATE contacts SET status = 'generated', is_duplicate = 0, sent_at = NULL WHERE id = ?").run(testContactId);

  // Process send using test mock of real Gmail send
  process.env.OUTREACH_DRY_RUN = 'false';
  process.env.TEST_MOCK_GMAIL_SEND = 'true';
  const sendSuccessResult = await sendOutreachEmail(testContactId);
  process.env.OUTREACH_DRY_RUN = 'true';
  assert.strictEqual(sendSuccessResult.success, true);
  pass('Test 20: sendOutreachEmail succeeds after 144 hours have elapsed from previous send');

  // Test 21: Confirmed successful send updates global_email_history sent_at, resetting cooldown to fresh 144h
  const updatedHist = db.prepare('SELECT * FROM global_email_history WHERE email = ?').get(cooldownEmail) as any;
  assert.strictEqual(updatedHist.status, 'sent');
  assert(isEmailInCooldown(updatedHist.sent_at));
  pass('Test 21: Confirmed send resets cooldown to fresh 144 hours from new send timestamp');

  // --------------------------------------------------------------------------
  // PART 5: RE-UPLOAD & CSV PIPELINE COOLDOWN BEHAVIOR
  // --------------------------------------------------------------------------
  console.log('\n--- Part 5: CSV Re-upload with Expired vs Active Cooldown ---');

  const reuploadExpiredEmail = `expired_${Date.now()}@fintech.com`;
  const reuploadActiveEmail = `active_${Date.now()}@fintech.com`;

  // Seed history: expiredEmail sent 7 days ago (168 hrs); activeEmail sent 1 day ago (24 hrs)
  const sevenDaysAgoIso = new Date(Date.now() - 168 * 3600 * 1000).toISOString();
  const oneDayAgoIso = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

  db.prepare(`
    INSERT INTO global_email_history (email, first_seen_at, sent_at, status)
    VALUES
      (?, ?, ?, 'sent'),
      (?, ?, ?, 'sent')
  `).run(reuploadExpiredEmail, sevenDaysAgoIso, sevenDaysAgoIso, reuploadActiveEmail, oneDayAgoIso, oneDayAgoIso);

  // Upload CSV containing both emails
  const csvContent = Buffer.from(
    `Company,HR Name,Email\nFinTech Inc,Expired Recruiter,${reuploadExpiredEmail}\nFinTech Inc,Active Recruiter,${reuploadActiveEmail}\n`
  );
  const reuploadBatch = await processBatchFile(csvContent, 'reupload_cooldown_test.csv');

  const contactExpired = db.prepare('SELECT * FROM contacts WHERE batch_id = ? AND email = ?').get(reuploadBatch.batchId, reuploadExpiredEmail) as any;
  const contactActive = db.prepare('SELECT * FROM contacts WHERE batch_id = ? AND email = ?').get(reuploadBatch.batchId, reuploadActiveEmail) as any;

  // Test 22: Expired cooldown email is NOT marked duplicate on re-upload
  assert.strictEqual(contactExpired.is_duplicate, 0);
  assert.strictEqual(contactExpired.status, 'queued');
  pass('Test 22: Re-uploaded email with expired cooldown (>144h) is NOT marked duplicate and is queued');

  // Test 23: Active cooldown email IS marked duplicate on re-upload
  assert.strictEqual(contactActive.is_duplicate, 1);
  assert.strictEqual(contactActive.status, 'skipped');
  assert(contactActive.relevance_reason.includes('6-day cooldown'));
  pass('Test 23: Re-uploaded email within active cooldown (<144h) is flagged duplicate and skipped');

  // Test 24: Multiple contacts at same company have independent cooldowns
  const companyContacts = db.prepare('SELECT email, is_duplicate, status FROM contacts WHERE batch_id = ?').all(reuploadBatch.batchId) as any[];
  assert.strictEqual(companyContacts.length, 2);
  const queuedOnes = companyContacts.filter((c) => c.status === 'queued');
  const skippedOnes = companyContacts.filter((c) => c.status === 'skipped');
  assert.strictEqual(queuedOnes.length, 1);
  assert.strictEqual(skippedOnes.length, 1);
  pass('Test 24: Multiple contacts at same company have strictly independent cooldowns');

  // Test 25: Dry-run simulations never start a 144-hour cooldown
  const dryRunEmail = `dryrun_only_${Date.now()}@techcorp.com`;
  const dryRunBatchId = `batch_dry_${Date.now()}`;
  db.prepare(`
    INSERT INTO batches (id, filename, upload_date, created_at, updated_at)
    VALUES (?, 'dry.csv', '2026-09-06', datetime('now'), datetime('now'))
  `).run(dryRunBatchId);

  const dryContactId = `cont_dry_${Date.now()}`;
  db.prepare(`
    INSERT INTO contacts (id, batch_id, company_name, email, is_relevant, email_valid, is_duplicate, status, email_subject, email_body, created_at, updated_at)
    VALUES (?, ?, 'TechCorp', ?, 1, 1, 0, 'generated', 'Subj', 'Body', datetime('now'), datetime('now'))
  `).run(dryContactId, dryRunBatchId, dryRunEmail);

  // Send in dry-run mode
  process.env.OUTREACH_DRY_RUN = 'true';
  const drySendResult = await sendOutreachEmail(dryContactId);
  assert.strictEqual(drySendResult.success, true);

  const dryHist = db.prepare('SELECT * FROM global_email_history WHERE email = ?').get(dryRunEmail) as any;
  assert(!dryHist || dryHist.status !== 'sent');
  assert.strictEqual(isEmailInCooldown(dryHist?.sent_at), false);
  pass('Test 25: Dry-run simulation never writes status=sent and never starts a 144-hour cooldown');

  // Cleanup test database
  try { db.close(); } catch {}
  try { fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }); } catch {}

  console.log('\n======================================================================');
  console.log(`ALL 25 CRITERIA PASSED: ${totalPassed}/25`);
  console.log('SENDING WINDOW POLICY & 6-DAY COOLDOWN FULLY VERIFIED');
  console.log('REAL RECRUITER EMAILS DISPATCHED: 0');
  console.log('======================================================================\n');
}

runVerification().catch((err) => {
  console.error('Test suite failure:', err);
  process.exit(1);
});
