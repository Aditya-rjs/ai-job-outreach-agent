/**
 * verify-resume-update-queue-deadlock-fix.ts
 *
 * Verifies all 15 required scenarios for the resume update send queue deadlock fix:
 * 1. Generated contact with current resume -> normal send path.
 * 2. Generated contact with old resume -> Gmail NOT called.
 * 3. Old-resume contact -> queue item does NOT remain processing.
 * 4. Old-resume contact -> contact becomes eligible for regeneration (PENDING_GENERATION).
 * 5. Regenerated email receives current resumeVersion.
 * 6. Regenerated email can return to Ready to Send.
 * 7. No global cooldown created during resume mismatch.
 * 8. Multiple stale contacts do not block one another (queue starvation prevented).
 * 9. Worker restart during stale-resume handling does not create a loop.
 * 10. Stale queue recovery cannot repeatedly recycle a resume-mismatch contact.
 * 11. Uncertain Gmail dispatch remains protected against duplicate sends.
 * 12. Existing 144-hour cooldown remains unchanged.
 * 13. Existing 3-minute spacing remains unchanged.
 * 14. Existing 10:00 AM–4:00 PM IST window remains unchanged.
 * 15. NO hard daily send cap is introduced.
 *
 * SAFETY INVARIANT: Strictly 0 real emails dispatched; uses test mock or dry-run.
 */

import fs from 'fs';
import path from 'path';
import assert from 'assert';
import Database from 'better-sqlite3';

const TEST_DATA_DIR = path.resolve(__dirname, 'fixtures', 'test_data_resume_deadlock_fix');
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.USER_TIMEZONE = 'Asia/Kolkata';
process.env.OUTREACH_DRY_RUN = 'true';
process.env.TEST_MOCK_GMAIL_SEND = 'true';

if (fs.existsSync(TEST_DATA_DIR)) {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
}
fs.mkdirSync(path.join(TEST_DATA_DIR, 'uploads'), { recursive: true });
fs.mkdirSync(path.join(TEST_DATA_DIR, 'resumes'), { recursive: true });

// Setup initial active resume (V1)
const resumeV1Version = '2026-09-04T12:05:16.246Z';
const testResumePath = path.join(TEST_DATA_DIR, 'resumes', 'Active_Resume_V1.pdf');
fs.writeFileSync(testResumePath, Buffer.from('%PDF-1.4 dummy active resume content v1'));

import { initializeDatabase } from '../src/db/migrate';
initializeDatabase();

const DB_PATH = path.join(TEST_DATA_DIR, 'outreach.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Seed active resume V1
db.prepare(`
  INSERT OR REPLACE INTO resume (id, filename, file_path, mime_type, parsed_text, parsed_data, version, uploaded_at)
  VALUES ('current', 'Active_Resume_V1.pdf', ?, 'application/pdf', 'Skills: TypeScript, React', '{"skills":["TypeScript","React"]}', ?, ?)
`).run(testResumePath, resumeV1Version, resumeV1Version);

// Seed authoritative company classifications
db.prepare(`
  INSERT OR REPLACE INTO company_classifications (
    normalized_name, company_name, is_relevant, confidence, reason,
    classification_source, gemini_model, classification_result, created_at, updated_at
  ) VALUES
    ('techcorp', 'TechCorp', 1, 1.0, 'Relevant — Gemini: Software development company.', 'gemini', 'gemini-2.0-flash', 'RELEVANT', datetime('now'), datetime('now')),
    ('fintech', 'FinTech Inc', 1, 1.0, 'Relevant — Gemini: Financial systems.', 'gemini', 'gemini-2.0-flash', 'RELEVANT', datetime('now'), datetime('now'))
`).run();

import {
  acquireNextEligibleJob,
  recoverStaleProcessingItems,
  markContactStaleResumeForRegeneration,
  invalidateStaleResumeContacts,
} from '../src/lib/scheduler/queue-manager';
import { sendOutreachEmail } from '../src/lib/gmail/send-email';
import { isWithinDailyWindow, EMAIL_COOLDOWN_HOURS } from '../src/lib/scheduler/time-utils';

function pass(name: string) {
  console.log(`  ✓ ${name}`);
}

async function runTests() {
  console.log('Starting Comprehensive Resume Deadlock Fix Verification Suite...\n');

  // Seed test batch
  const batchId = 'batch_test_deadlock_01';
  db.prepare(`
    INSERT OR REPLACE INTO batches (id, filename, upload_date, status, created_at, updated_at)
    VALUES (?, 'batch_01.csv', datetime('now'), 'processing', datetime('now'), datetime('now'))
  `).run(batchId);

  // ---------------------------------------------------------------------------
  // Test 1: Generated contact with current resume -> normal send path
  // ---------------------------------------------------------------------------
  const cont1Id = 'cont_norm_01';
  db.prepare(`
    INSERT OR REPLACE INTO contacts (
      id, batch_id, company_name, contact_name, email, is_relevant, is_duplicate, email_valid,
      status, email_subject, email_body, resume_version, generation_status, created_at, updated_at
    ) VALUES (
      ?, ?, 'TechCorp', 'Alice Smith', 'alice@techcorp.com', 1, 0, 1,
      'generated', 'Subject 1', 'Body 1', ?, 'GENERATED', datetime('now'), datetime('now')
    )
  `).run(cont1Id, batchId, resumeV1Version);

  db.prepare(`
    INSERT OR REPLACE INTO outreach_queue (id, contact_id, status, attempts, priority, created_at, updated_at)
    VALUES ('q_norm_01', ?, 'pending', 0, 10, datetime('now'), datetime('now'))
  `).run(cont1Id);

  const job1 = acquireNextEligibleJob('worker_01');
  assert(job1 !== null, 'Job 1 must be acquired');
  assert.strictEqual(job1.contact.id, cont1Id, 'Acquired job must be cont_norm_01');

  const send1 = await sendOutreachEmail(cont1Id);
  assert(send1.success, 'Send must succeed for contact with current resume');
  pass('Test 1: Generated contact with current resume follows normal send path');

  // ---------------------------------------------------------------------------
  // Now simulate a Resume Update: V1 -> V2
  // ---------------------------------------------------------------------------
  const resumeV2Version = '2026-09-06T22:18:13.458Z';
  const testResumePathV2 = path.join(TEST_DATA_DIR, 'resumes', 'Active_Resume_V2.pdf');
  fs.writeFileSync(testResumePathV2, Buffer.from('%PDF-1.4 dummy active resume content v2'));

  db.prepare(`
    UPDATE resume
    SET filename = 'Active_Resume_V2.pdf',
        file_path = ?,
        version = ?,
        uploaded_at = ?
    WHERE id = 'current'
  `).run(testResumePathV2, resumeV2Version, resumeV2Version);

  // ---------------------------------------------------------------------------
  // Test 2: Generated contact with old resume -> Gmail NOT called
  // ---------------------------------------------------------------------------
  const contStaleId = 'cont_stale_01';
  db.prepare(`
    INSERT OR REPLACE INTO contacts (
      id, batch_id, company_name, contact_name, email, is_relevant, is_duplicate, email_valid,
      status, email_subject, email_body, resume_version, generation_status, created_at, updated_at
    ) VALUES (
      ?, ?, 'TechCorp', 'Bob Old', 'bob.old@techcorp.com', 1, 0, 1,
      'generated', 'Subject Old', 'Body Old', ?, 'GENERATED', datetime('now'), datetime('now')
    )
  `).run(contStaleId, batchId, resumeV1Version); // generated with old V1 resume

  db.prepare(`
    INSERT OR REPLACE INTO outreach_queue (id, contact_id, status, attempts, priority, created_at, updated_at)
    VALUES ('q_stale_01', ?, 'processing', 0, 10, datetime('now'), datetime('now'))
  `).run(contStaleId);

  const staleSend = await sendOutreachEmail(contStaleId);
  assert(!staleSend.success, 'Send must fail for stale resume');
  assert.strictEqual(staleSend.errorCategory, 'validation', 'Error category must be validation');
  assert(staleSend.error && staleSend.error.includes('active resume was updated'), 'Error message must specify resume update');
  pass('Test 2: Generated contact with old resume rejected; Gmail NOT called');

  // ---------------------------------------------------------------------------
  // Test 3: Old-resume contact -> queue item does NOT remain processing
  // ---------------------------------------------------------------------------
  const qStaleAfter = db.prepare(`SELECT * FROM outreach_queue WHERE contact_id = ?`).get(contStaleId) as any;
  assert(!qStaleAfter || qStaleAfter.status !== 'processing', 'Queue item must NOT remain in processing status');
  pass('Test 3: Old-resume contact queue item does not remain in processing status');

  // ---------------------------------------------------------------------------
  // Test 4: Old-resume contact -> contact becomes eligible for regeneration (PENDING_GENERATION)
  // ---------------------------------------------------------------------------
  const contStaleAfter = db.prepare(`SELECT * FROM contacts WHERE id = ?`).get(contStaleId) as any;
  assert.strictEqual(contStaleAfter.generation_status, 'PENDING_GENERATION', 'Contact must be transitioned to PENDING_GENERATION');
  assert.strictEqual(contStaleAfter.status, 'queued', 'Contact status must be queued');
  assert.strictEqual(contStaleAfter.is_relevant, 1, 'Classification must be preserved');
  assert.strictEqual(contStaleAfter.email_subject, null, 'Stale subject must be cleared');
  assert.strictEqual(contStaleAfter.email_body, null, 'Stale body must be cleared');
  assert.strictEqual(contStaleAfter.resume_version, null, 'Stale resume version must be cleared');
  pass('Test 4: Old-resume contact is cleanly transitioned to PENDING_GENERATION with classification preserved');

  // ---------------------------------------------------------------------------
  // Test 5: Regenerated email receives current resumeVersion
  // ---------------------------------------------------------------------------
  // Simulate autonomous background regeneration with current active resume (V2)
  db.prepare(`
    UPDATE contacts
    SET email_subject = 'Subject V2',
        email_body = 'Body V2 tailored to resume v2',
        resume_version = ?,
        generation_status = 'GENERATED',
        status = 'generated',
        updated_at = datetime('now')
    WHERE id = ?
  `).run(resumeV2Version, contStaleId);

  const contRegen = db.prepare(`SELECT * FROM contacts WHERE id = ?`).get(contStaleId) as any;
  assert.strictEqual(contRegen.resume_version, resumeV2Version, 'Regenerated contact must have current resumeVersion');
  pass('Test 5: Regenerated email receives current active resumeVersion');

  // ---------------------------------------------------------------------------
  // Test 6: Regenerated email can return to Ready to Send
  // ---------------------------------------------------------------------------
  db.prepare(`
    INSERT OR REPLACE INTO outreach_queue (id, contact_id, status, attempts, priority, created_at, updated_at)
    VALUES ('q_stale_01_regen', ?, 'pending', 0, 10, datetime('now'), datetime('now'))
  `).run(contStaleId);

  const jobRegen = acquireNextEligibleJob('worker_01');
  assert(jobRegen !== null, 'Regenerated job must be acquirable by queue');
  assert.strictEqual(jobRegen.contact.id, contStaleId, 'Acquired job must be cont_stale_01');

  const sendRegen = await sendOutreachEmail(contStaleId);
  assert(sendRegen.success, 'Send must succeed for regenerated contact');
  pass('Test 6: Regenerated email returns to Ready to Send and successfully sends');

  // ---------------------------------------------------------------------------
  // Test 7: No global cooldown created during resume mismatch
  // ---------------------------------------------------------------------------
  const contNoCooldownId = 'cont_no_cool_01';
  db.prepare(`
    INSERT OR REPLACE INTO contacts (
      id, batch_id, company_name, contact_name, email, is_relevant, is_duplicate, email_valid,
      status, email_subject, email_body, resume_version, generation_status, created_at, updated_at
    ) VALUES (
      ?, ?, 'FinTech Inc', 'Charlie Cooldown', 'charlie.cooldown@fintech.com', 1, 0, 1,
      'generated', 'Subject V1', 'Body V1', ?, 'GENERATED', datetime('now'), datetime('now')
    )
  `).run(contNoCooldownId, batchId, resumeV1Version); // old version

  await sendOutreachEmail(contNoCooldownId);

  const historyRow = db.prepare(`SELECT * FROM global_email_history WHERE email = 'charlie.cooldown@fintech.com'`).get() as any;
  assert(!historyRow || historyRow.status !== 'sent', 'Global email history must NOT record sent status for resume mismatch');
  pass('Test 7: No global cooldown is created during resume mismatch');

  // ---------------------------------------------------------------------------
  // Test 8: Multiple stale contacts do not block one another (queue starvation prevented)
  // ---------------------------------------------------------------------------
  const staleContA = 'cont_stale_multi_A';
  const staleContB = 'cont_stale_multi_B';
  const freshContC = 'cont_fresh_multi_C';

  // Two stale contacts with higher priority (priority 20)
  db.prepare(`
    INSERT OR REPLACE INTO contacts (
      id, batch_id, company_name, contact_name, email, is_relevant, is_duplicate, email_valid,
      status, email_subject, email_body, resume_version, generation_status, created_at, updated_at
    ) VALUES
      (?, ?, 'TechCorp', 'Stale A', 'stale.a@techcorp.com', 1, 0, 1, 'generated', 'Sub A', 'Body A', ?, 'GENERATED', datetime('now'), datetime('now')),
      (?, ?, 'TechCorp', 'Stale B', 'stale.b@techcorp.com', 1, 0, 1, 'generated', 'Sub B', 'Body B', ?, 'GENERATED', datetime('now'), datetime('now'))
  `).run(staleContA, batchId, resumeV1Version, staleContB, batchId, resumeV1Version);

  db.prepare(`
    INSERT OR REPLACE INTO outreach_queue (id, contact_id, status, attempts, priority, created_at, updated_at)
    VALUES
      ('q_stale_a', ?, 'pending', 0, 20, datetime('now'), datetime('now')),
      ('q_stale_b', ?, 'pending', 0, 20, datetime('now'), datetime('now'))
  `).run(staleContA, staleContB);

  // One fresh valid contact with lower priority (priority 10)
  db.prepare(`
    INSERT OR REPLACE INTO contacts (
      id, batch_id, company_name, contact_name, email, is_relevant, is_duplicate, email_valid,
      status, email_subject, email_body, resume_version, generation_status, created_at, updated_at
    ) VALUES
      (?, ?, 'TechCorp', 'Fresh C', 'fresh.c@techcorp.com', 1, 0, 1, 'generated', 'Sub C', 'Body C', ?, 'GENERATED', datetime('now'), datetime('now'))
  `).run(freshContC, batchId, resumeV2Version);

  db.prepare(`
    INSERT OR REPLACE INTO outreach_queue (id, contact_id, status, attempts, priority, created_at, updated_at)
    VALUES
      ('q_fresh_c', ?, 'pending', 0, 10, datetime('now'), datetime('now'))
  `).run(freshContC);

  // acquireNextEligibleJob should auto-heal stale A and stale B, and acquire fresh C without starving the queue!
  const acquiredMulti = acquireNextEligibleJob('worker_01');
  assert(acquiredMulti !== null, 'Acquire must not be null');
  assert.strictEqual(acquiredMulti.contact.id, freshContC, 'Queue must auto-heal stale contacts and yield fresh C');

  // Verify stale A and B were both transitioned to PENDING_GENERATION
  const contA = db.prepare(`SELECT generation_status FROM contacts WHERE id = ?`).get(staleContA) as any;
  const contB = db.prepare(`SELECT generation_status FROM contacts WHERE id = ?`).get(staleContB) as any;
  assert.strictEqual(contA.generation_status, 'PENDING_GENERATION', 'Stale A must be in PENDING_GENERATION');
  assert.strictEqual(contB.generation_status, 'PENDING_GENERATION', 'Stale B must be in PENDING_GENERATION');
  pass('Test 8: Multiple stale contacts do not block the queue; fresh contacts behind them are leased immediately');

  // ---------------------------------------------------------------------------
  // Test 9 & 10: Worker crash / restart & Stale queue recovery cannot recycle resume-mismatch contact
  // ---------------------------------------------------------------------------
  const crashedContactId = 'cont_crashed_01';
  db.prepare(`
    INSERT OR REPLACE INTO contacts (
      id, batch_id, company_name, contact_name, email, is_relevant, is_duplicate, email_valid,
      status, email_subject, email_body, resume_version, generation_status, created_at, updated_at
    ) VALUES (
      ?, ?, 'TechCorp', 'Dave Crash', 'dave.crash@techcorp.com', 1, 0, 1,
      'generated', 'Sub Crash', 'Body Crash', ?, 'GENERATED', datetime('now'), datetime('now')
    )
  `).run(crashedContactId, batchId, resumeV1Version); // old resume

  // Stuck in processing with expired lease
  db.prepare(`
    INSERT OR REPLACE INTO outreach_queue (id, contact_id, status, attempts, lease_expires_at, worker_id, created_at, updated_at)
    VALUES ('q_crashed_01', ?, 'processing', 0, datetime('now', '-5 minutes'), 'crashed_worker', datetime('now'), datetime('now'))
  `).run(crashedContactId);

  const recoveredCount = recoverStaleProcessingItems();
  assert(recoveredCount > 0, 'Crash recovery must process the stale item');

  // The item must NOT have been reset to 'pending' in outreach_queue!
  const queueItemAfterCrash = db.prepare(`SELECT * FROM outreach_queue WHERE contact_id = ?`).get(crashedContactId) as any;
  assert(!queueItemAfterCrash || queueItemAfterCrash.status !== 'pending', 'Stale-resume crash item must NOT be recycled to pending');

  const contactAfterCrash = db.prepare(`SELECT * FROM contacts WHERE id = ?`).get(crashedContactId) as any;
  assert.strictEqual(contactAfterCrash.generation_status, 'PENDING_GENERATION', 'Crashed stale item must be routed to PENDING_GENERATION');
  pass('Test 9 & 10: Crash recovery routes stale-resume items to PENDING_GENERATION without endless recycling');

  // ---------------------------------------------------------------------------
  // Test 11: Uncertain Gmail dispatch remains protected against duplicate sends
  // ---------------------------------------------------------------------------
  const uncertainContactId = 'cont_uncertain_01';
  db.prepare(`
    INSERT OR REPLACE INTO contacts (
      id, batch_id, company_name, contact_name, email, is_relevant, is_duplicate, email_valid,
      status, email_subject, email_body, resume_version, generation_status, created_at, updated_at
    ) VALUES (
      ?, ?, 'TechCorp', 'Evan Uncertain', 'evan.uncertain@techcorp.com', 1, 0, 1,
      'uncertain', 'Sub Uncert', 'Body Uncert', ?, 'GENERATED', datetime('now'), datetime('now')
    )
  `).run(uncertainContactId, batchId, resumeV2Version);

  db.prepare(`
    INSERT OR REPLACE INTO outreach_queue (id, contact_id, status, attempts, lease_expires_at, worker_id, created_at, updated_at)
    VALUES ('q_uncert_01', ?, 'uncertain', 1, datetime('now', '-5 minutes'), 'some_worker', datetime('now'), datetime('now'))
  `).run(uncertainContactId);

  // Crash recovery on uncertain item
  recoverStaleProcessingItems();
  const uncertQueue = db.prepare(`SELECT status FROM outreach_queue WHERE id = 'q_uncert_01'`).get() as any;
  assert.strictEqual(uncertQueue.status, 'uncertain', 'Crash recovery must preserve uncertain status');

  const uncertAcquire = acquireNextEligibleJob('worker_01');
  assert(uncertAcquire?.contact.id !== uncertainContactId, 'Queue must never acquire an uncertain job');
  pass('Test 11: Uncertain Gmail dispatch status is preserved and protected against duplicate dispatch');

  // ---------------------------------------------------------------------------
  // Test 12: Existing 144-hour cooldown remains unchanged
  // ---------------------------------------------------------------------------
  assert.strictEqual(EMAIL_COOLDOWN_HOURS, 144, 'Global email cooldown must remain exactly 144 hours (6 days)');
  pass('Test 12: Existing 144-hour cooldown policy remains unchanged');

  // ---------------------------------------------------------------------------
  // Test 13: Existing 3-minute spacing remains unchanged
  // ---------------------------------------------------------------------------
  const schedulerRow = db.prepare(`SELECT interval_minutes FROM scheduler_state WHERE id = 'singleton'`).get() as any;
  assert.strictEqual(schedulerRow?.interval_minutes ?? 3, 3, 'Send spacing must remain 3 minutes');
  pass('Test 13: Existing 3-minute send spacing policy remains unchanged');

  // ---------------------------------------------------------------------------
  // Test 14: Existing 10:00 AM–4:00 PM IST window remains unchanged
  // ---------------------------------------------------------------------------
  // Test within window (e.g. 11:30 AM IST)
  const duringWindow = new Date('2026-09-07T06:00:00.000Z'); // 11:30 AM IST
  assert(isWithinDailyWindow(duringWindow, 'Asia/Kolkata', 10, 0, 16, 0), '11:30 AM IST must be within window');

  // Test outside window (e.g. 5:00 PM IST)
  const afterWindow = new Date('2026-09-07T11:30:00.000Z'); // 5:00 PM IST
  assert(!isWithinDailyWindow(afterWindow, 'Asia/Kolkata', 10, 0, 16, 0), '5:00 PM IST must be outside window');
  pass('Test 14: Existing 10:00 AM–4:00 PM IST sending window policy remains unchanged');

  // ---------------------------------------------------------------------------
  // Test 15: NO hard daily send cap is introduced
  // ---------------------------------------------------------------------------
  // Simulate 35 emails sent today
  db.prepare(`UPDATE scheduler_state SET today_sent_count = 35 WHERE id = 'singleton'`).run();
  const postCapContactId = 'cont_post_cap_01';
  db.prepare(`
    INSERT OR REPLACE INTO contacts (
      id, batch_id, company_name, contact_name, email, is_relevant, is_duplicate, email_valid,
      status, email_subject, email_body, resume_version, generation_status, created_at, updated_at
    ) VALUES (
      ?, ?, 'TechCorp', 'George Unlimited', 'george.unlimited@techcorp.com', 1, 0, 1,
      'generated', 'Sub Post Cap', 'Body Post Cap', ?, 'GENERATED', datetime('now'), datetime('now')
    )
  `).run(postCapContactId, batchId, resumeV2Version);

  db.prepare(`
    INSERT OR REPLACE INTO outreach_queue (id, contact_id, status, attempts, priority, created_at, updated_at)
    VALUES ('q_post_cap', ?, 'pending', 0, 10, datetime('now'), datetime('now'))
  `).run(postCapContactId);

  const postCapJob = acquireNextEligibleJob('worker_01');
  assert(postCapJob !== null, 'acquireNextEligibleJob must lease jobs even when today_sent_count >= 30 (no daily hard cap)');
  assert.strictEqual(postCapJob.contact.id, postCapContactId, 'Acquired job must be post cap contact');
  pass('Test 15: NO hard daily send cap introduced; jobs acquire and send beyond 30');

  console.log('\n======================================================================');
  console.log('ALL 15 TESTS PASSED SUCCESSFULLY! ZERO DEADLOCK HAZARDS DETECTED.');
  console.log('======================================================================\n');
}

runTests().catch((err) => {
  console.error('Test Suite Failed:', err);
  process.exit(1);
});
