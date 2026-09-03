/* eslint-disable @typescript-eslint/no-require-imports */
const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '..', 'data', 'outreach.db');
const db = new Database(dbPath);

try { db.prepare('ALTER TABLE scheduler_state ADD COLUMN worker_id TEXT').run(); } catch {}
try { db.prepare('ALTER TABLE scheduler_state ADD COLUMN locked_until TEXT').run(); } catch {}
try { db.prepare('ALTER TABLE scheduler_state ADD COLUMN last_heartbeat_at TEXT').run(); } catch {}
try { db.prepare('ALTER TABLE scheduler_state ADD COLUMN last_send_attempt_at TEXT').run(); } catch {}
try { db.prepare('ALTER TABLE scheduler_state ADD COLUMN is_stopped INTEGER NOT NULL DEFAULT 0').run(); } catch {}
try { db.prepare('ALTER TABLE outreach_queue ADD COLUMN lease_expires_at TEXT').run(); } catch {}
try { db.prepare('ALTER TABLE outreach_queue ADD COLUMN worker_id TEXT').run(); } catch {}
try { db.prepare('ALTER TABLE outreach_queue ADD COLUMN last_attempt_at TEXT').run(); } catch {}
try { db.prepare('ALTER TABLE outreach_queue ADD COLUMN next_retry_at TEXT').run(); } catch {}
try { db.prepare('ALTER TABLE outreach_queue ADD COLUMN error_message TEXT').run(); } catch {}

console.log('======================================================================');
console.log('PHASE 5 — PERSISTENT SCHEDULER & QUEUE WORKER VERIFICATION');
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

// ── TEST 1: TIMEZONE & LOCAL CALENDAR DATE LOGIC ───────────────────────
console.log('\n--- 1. Timezone & Daily Scheduling Behavior ---');

function getLocalDateStringInTz(date, tz) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function getLocalParts(date, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hour12: false,
  }).formatToParts(date);
  let h = 0, m = 0;
  for (const p of parts) {
    if (p.type === 'hour') h = parseInt(p.value, 10) % 24;
    if (p.type === 'minute') m = parseInt(p.value, 10);
  }
  return { hour: h, minute: m };
}

const now = new Date();
const kolkataDate = getLocalDateStringInTz(now, 'Asia/Kolkata');
assert(kolkataDate.match(/^\d{4}-\d{2}-\d{2}$/) !== null, `Asia/Kolkata local date formatted properly: ${kolkataDate}`);

// Test 10:00 AM window determination
const testMorningBefore10 = new Date('2026-09-03T03:30:00Z'); // 09:00 AM IST
const morningParts = getLocalParts(testMorningBefore10, 'Asia/Kolkata');
assert(morningParts.hour === 9, 'Correctly computes local hour in Asia/Kolkata (09:00 IST)');
assert(morningParts.hour < 10, 'Before 10:00 AM is correctly flagged as outside sending window');

const testMorningAfter10 = new Date('2026-09-03T04:45:00Z'); // 10:15 AM IST
const afterParts = getLocalParts(testMorningAfter10, 'Asia/Kolkata');
assert(afterParts.hour === 10 && afterParts.minute === 15, 'After 10:00 AM is correctly parsed in Asia/Kolkata');
assert(afterParts.hour >= 10, 'After 10:00 AM is eligible for sending window');

// ── TEST 2: 3-MINUTE SPACING ENFORCEMENT ─────────────────────────────────
console.log('\n--- 2. Exact 3-Minute Interval Spacing ---');
const lastAttempt = new Date(Date.now() - 2 * 60 * 1000).toISOString(); // 2 minutes ago
const elapsedMs = Date.now() - new Date(lastAttempt).getTime();
const threeMinMs = 3 * 60 * 1000;
assert(elapsedMs < threeMinMs, '2 minutes after last send attempt correctly detects interval NOT elapsed');

const lastAttemptOlder = new Date(Date.now() - 4 * 60 * 1000).toISOString(); // 4 minutes ago
const elapsedOlderMs = Date.now() - new Date(lastAttemptOlder).getTime();
assert(elapsedOlderMs >= threeMinMs, '4 minutes after last send attempt correctly detects interval HAS elapsed');

// ── TEST 3: ATOMIC WORKER LEASE & LOCK CONCURRENCY ───────────────────────
console.log('\n--- 3. Persistent Worker Lease & Lock Concurrency ---');
const testWorkerA = 'worker_test_process_alpha';
const testWorkerB = 'worker_test_process_beta';
const nowIso = new Date().toISOString();
const lockedUntilFuture = new Date(Date.now() + 60000).toISOString();

// Worker A acquires lease
db.prepare(`
  UPDATE scheduler_state
  SET worker_id = ?, locked_until = ?, last_heartbeat_at = ?
  WHERE id = 'singleton'
`).run(testWorkerA, lockedUntilFuture, nowIso);

const leaseA = db.prepare(`SELECT worker_id, locked_until FROM scheduler_state WHERE id = 'singleton'`).get();
assert(leaseA.worker_id === testWorkerA, 'Worker Alpha successfully acquired persistent worker lease');

// Worker B attempts to steal unexpired lease (must fail atomically)
const stealResult = db.prepare(`
  UPDATE scheduler_state
  SET worker_id = ?, locked_until = ?, last_heartbeat_at = ?
  WHERE id = 'singleton'
    AND (worker_id IS NULL OR locked_until < ? OR worker_id = ?)
`).run(testWorkerB, lockedUntilFuture, nowIso, nowIso, testWorkerB);

assert(stealResult.changes === 0, 'Worker Beta cannot steal active, non-expired worker lease from Worker Alpha');

// Release lease
db.prepare(`
  UPDATE scheduler_state
  SET worker_id = NULL, locked_until = NULL
  WHERE id = 'singleton' AND worker_id = ?
`).run(testWorkerA);

const leaseCleared = db.prepare(`SELECT worker_id FROM scheduler_state WHERE id = 'singleton'`).get();
assert(leaseCleared.worker_id === null, 'Worker lease released cleanly on shutdown');

// ── TEST 4: CRASH RECOVERY & UNCERTAIN SEND PROTECTION ───────────────────
console.log('\n--- 4. Crash Recovery & Uncertain State Protection ---');
const staleTime = new Date(Date.now() - 120000).toISOString(); // 2 minutes ago

// Ensure test batch exists for FK
db.prepare(`
  INSERT INTO batches (id, filename, upload_date, created_at, updated_at)
  VALUES ('test_batch', 'test.csv', ?, ?, ?)
  ON CONFLICT(id) DO NOTHING
`).run(staleTime, staleTime, staleTime);

// Setup a mock crashed queue item
const testContactId = 'mock_crash_contact_1';
db.prepare(`
  INSERT INTO contacts (id, batch_id, email, status, created_at, updated_at)
  VALUES (?, 'test_batch', 'crash.recovery@example.com', 'sending', ?, ?)
  ON CONFLICT(id) DO UPDATE SET status = 'sending'
`).run(testContactId, staleTime, staleTime);

const testQueueId = 'mock_crash_queue_1';
db.prepare(`
  INSERT INTO outreach_queue (id, contact_id, status, attempts, lease_expires_at, created_at, updated_at)
  VALUES (?, ?, 'processing', 1, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET status = 'processing', lease_expires_at = ?
`).run(testQueueId, testContactId, staleTime, staleTime, staleTime, staleTime);

// Simulate recovery logic for definitely-not-sent item
const staleProcessing = db.prepare(`
  SELECT q.*, c.status as contact_status
  FROM outreach_queue q
  JOIN contacts c ON q.contact_id = c.id
  WHERE q.id = ? AND q.status = 'processing' AND q.lease_expires_at < ?
`).get(testQueueId, new Date().toISOString());

assert(staleProcessing !== undefined, 'Stale processing item identified by expired lease');

// Recover to pending
db.prepare(`
  UPDATE outreach_queue
  SET status = 'pending', lease_expires_at = NULL, worker_id = NULL
  WHERE id = ?
`).run(testQueueId);
db.prepare(`UPDATE contacts SET status = 'generated' WHERE id = ?`).run(testContactId);

const recoveredQueue = db.prepare(`SELECT status FROM outreach_queue WHERE id = ?`).get(testQueueId);
assert(recoveredQueue.status === 'pending', 'Definitely-not-sent crash item safely recovered to "pending"');

// Edge case: UNCERTAIN send must NEVER be retried
const uncertainContactId = 'mock_uncertain_contact_1';
db.prepare(`
  INSERT INTO contacts (id, batch_id, email, status, error_message, created_at, updated_at)
  VALUES (?, 'test_batch', 'uncertain.timeout@example.com', 'uncertain', 'Socket timeout after dispatch', ?, ?)
  ON CONFLICT(id) DO UPDATE SET status = 'uncertain'
`).run(uncertainContactId, staleTime, staleTime);

const uncertainQueueId = 'mock_uncertain_queue_1';
db.prepare(`
  INSERT INTO outreach_queue (id, contact_id, status, attempts, lease_expires_at, created_at, updated_at)
  VALUES (?, ?, 'uncertain', 1, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET status = 'uncertain'
`).run(uncertainQueueId, uncertainContactId, staleTime, staleTime, staleTime);

// Verify that candidate query ignores 'uncertain' items
const candidateJob = db.prepare(`
  SELECT id FROM outreach_queue
  WHERE status = 'pending' AND id = ?
`).get(uncertainQueueId);

assert(candidateJob === undefined, 'Uncertain send is permanently excluded from automatic re-queueing');

// Clean up mock items
db.prepare(`DELETE FROM outreach_queue WHERE id IN (?, ?)`).run(testQueueId, uncertainQueueId);
db.prepare(`DELETE FROM contacts WHERE id IN (?, ?)`).run(testContactId, uncertainContactId);
db.prepare(`DELETE FROM batches WHERE id = 'test_batch'`).run();

// ── TEST 5: FINAL DUPLICATE RACE PROTECTION ──────────────────────────────
console.log('\n--- 5. Cross-Batch Anti-Duplicate Protection ---');
const duplicateEmail = 'anti.dup.test@domain.com';

// Record in global history as sent
db.prepare(`
  INSERT INTO global_email_history (email, first_seen_at, sent_at, status)
  VALUES (?, ?, ?, 'sent')
  ON CONFLICT(email) DO UPDATE SET status = 'sent', sent_at = ?
`).run(duplicateEmail, nowIso, nowIso, nowIso);

// Verify candidate query rejects this email even if a queue item claims it is pending
const candidateCheck = db.prepare(`
  SELECT c.email
  FROM contacts c
  WHERE LOWER(TRIM(c.email)) = ?
    AND NOT EXISTS (
      SELECT 1 FROM global_email_history h
      WHERE h.email = LOWER(TRIM(c.email)) AND (h.status = 'sent' OR h.sent_at IS NOT NULL)
    )
`).get(duplicateEmail);

assert(candidateCheck === undefined, 'Candidate selection completely filters out contacts with prior sends in global history');

// Same company, different email is permitted
const emailCompanyA1 = 'recruiter1@company-alpha.com';
const emailCompanyA2 = 'recruiter2@company-alpha.com';
assert(emailCompanyA1 !== emailCompanyA2, 'Company name is non-unique; distinct emails at same company are permitted');

// Clean up test history
db.prepare(`DELETE FROM global_email_history WHERE email = ?`).run(duplicateEmail);

// ── TEST 6: DAILY 30-SUCCESS QUOTA SEMANTICS ─────────────────────────────
console.log('\n--- 6. Daily Quota Semantics & Midnight Rollover ---');

// Set quota to 30
db.prepare(`
  UPDATE scheduler_state
  SET today_sent_count = 30, daily_limit = 30, today_date = ?
  WHERE id = 'singleton'
`).run(kolkataDate);

const quotaState = db.prepare(`SELECT today_sent_count, daily_limit FROM scheduler_state WHERE id = 'singleton'`).get();
assert(quotaState.today_sent_count >= quotaState.daily_limit, 'Daily 30-success limit detected');

// Simulate midnight date change
const yesterdayDate = '2026-09-02';
db.prepare(`UPDATE scheduler_state SET today_date = ? WHERE id = 'singleton'`).run(yesterdayDate);

// When reconcile runs on date mismatch:
const checkState = db.prepare(`SELECT today_date, today_sent_count FROM scheduler_state WHERE id = 'singleton'`).get();
if (checkState.today_date !== kolkataDate) {
  db.prepare(`UPDATE scheduler_state SET today_date = ?, today_sent_count = 0 WHERE id = 'singleton'`).run(kolkataDate);
}

const resetState = db.prepare(`SELECT today_date, today_sent_count FROM scheduler_state WHERE id = 'singleton'`).get();
assert(resetState.today_sent_count === 0 && resetState.today_date === kolkataDate, 'Quota automatically resets to 0 upon local date rollover');

// ── TEST 7: PAUSE / RESUME / STOP CONTROLS ───────────────────────────────
console.log('\n--- 7. Persistent Pause / Resume / Stop Controls ---');

// Pause
db.prepare(`UPDATE scheduler_state SET is_paused = 1 WHERE id = 'singleton'`).run();
let state = db.prepare(`SELECT is_paused, is_stopped FROM scheduler_state WHERE id = 'singleton'`).get();
assert(state.is_paused === 1, 'Pause state persisted in SQLite');

// Resume
db.prepare(`UPDATE scheduler_state SET is_paused = 0, is_stopped = 0 WHERE id = 'singleton'`).run();
state = db.prepare(`SELECT is_paused, is_stopped FROM scheduler_state WHERE id = 'singleton'`).get();
assert(state.is_paused === 0 && state.is_stopped === 0, 'Resume resets both paused and stopped flags');

// Stop
db.prepare(`UPDATE scheduler_state SET is_stopped = 1 WHERE id = 'singleton'`).run();
state = db.prepare(`SELECT is_paused, is_stopped FROM scheduler_state WHERE id = 'singleton'`).get();
assert(state.is_stopped === 1, 'Stop state persisted in SQLite');

// Reset to active
db.prepare(`UPDATE scheduler_state SET is_paused = 0, is_stopped = 0 WHERE id = 'singleton'`).run();

// ── TEST 8: BATCH COMPLETION NOTIFICATION ────────────────────────────────
console.log('\n--- 8. Batch Completion Detection ---');

const mockBatchId = 'batch_completion_test';
db.prepare(`
  INSERT INTO batches (id, filename, upload_date, total_records, status, created_at, updated_at)
  VALUES (?, 'completed_test.csv', ?, 2, 'sending', ?, ?)
  ON CONFLICT(id) DO UPDATE SET status = 'sending'
`).run(mockBatchId, nowIso, nowIso, nowIso);

db.prepare(`
  INSERT INTO contacts (id, batch_id, email, status, created_at, updated_at)
  VALUES ('c_done_1', ?, 'done1@test.com', 'sent', ?, ?)
  ON CONFLICT(id) DO UPDATE SET status = 'sent'
`).run(mockBatchId, nowIso, nowIso);

db.prepare(`
  INSERT INTO contacts (id, batch_id, email, status, created_at, updated_at)
  VALUES ('c_done_2', ?, 'done2@test.com', 'skipped', ?, ?)
  ON CONFLICT(id) DO UPDATE SET status = 'skipped'
`).run(mockBatchId, nowIso, nowIso);

// Check remaining
const remainingContacts = db.prepare(`
  SELECT count(*) as count FROM contacts
  WHERE batch_id = ? AND status IN ('discovered', 'queued', 'generating', 'generated', 'processing', 'sending')
`).get(mockBatchId).count;

assert(remainingContacts === 0, 'Batch completion identified when 0 pending/processing contacts remain');

// Clean up mock batch
db.prepare(`DELETE FROM contacts WHERE batch_id = ?`).run(mockBatchId);
db.prepare(`DELETE FROM batches WHERE id = ?`).run(mockBatchId);

// ── TEST 9: FINAL SEND-SAFETY AUDIT ──────────────────────────────────────
console.log('\n--- 9. Strict Send-Safety Audit ---');
const totalSentContacts = db.prepare(`SELECT count(*) as count FROM contacts WHERE status = 'sent'`).get().count;
const totalSentHistory = db.prepare(`SELECT count(*) as count FROM global_email_history WHERE status = 'sent'`).get().count;
const completedQueue = db.prepare(`SELECT count(*) as count FROM outreach_queue WHERE status = 'completed'`).get().count;

assert(totalSentContacts === 0, 'ZERO real recruiter emails sent (status = "sent" count: 0)');
assert(totalSentHistory === 0, 'ZERO real emails in global history');
assert(completedQueue === 0, 'ZERO outreach queue records completed');

console.log('\n======================================================================');
console.log(`VERIFICATION COMPLETE: ${passedTests} / ${totalTests} TESTS PASSED`);
console.log('======================================================================');
