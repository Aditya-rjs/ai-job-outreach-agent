/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * verify-reupload-duplicate-rules.js
 *
 * Comprehensive regression tests verifying re-upload and deduplication behavior:
 * 1. Real Sent -> Re-upload remains blocked (permanent history preserved across batch deletion).
 * 2. Dry-Run Only -> Re-upload is eligible (simulated sends never block future outreach).
 * 3. Deleted Queued Contact -> Re-upload is eligible (queued contacts in deleted batches never block re-upload).
 * 4. Active Queued Contact -> Correctly deduplicated (cannot queue same email twice across active batches).
 * 5. Same Company + Different Emails -> Both allowed (Infosys recruiter 1 and recruiter 2 both eligible).
 * 6. Same Email Globally -> Blocked (deduplication based on normalized email address).
 * 7. Self-Healing Reconciliation -> Phantom/stale sent records purged on initialization.
 *
 * SAFETY GUARANTEES:
 * - OUTREACH_DRY_RUN remains active.
 * - Zero real emails are dispatched.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const Database = require('better-sqlite3');

const TEST_DATA_DIR = path.join(__dirname, 'fixtures', 'test_data_reupload_dup');
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.USER_TIMEZONE = 'Asia/Kolkata';
process.env.OUTREACH_DRY_RUN = 'true';

if (fs.existsSync(TEST_DATA_DIR)) {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
}
fs.mkdirSync(path.join(TEST_DATA_DIR, 'uploads'), { recursive: true });
fs.mkdirSync(path.join(TEST_DATA_DIR, 'resumes'), { recursive: true });

// Register TypeScript loader
require('tsx/cjs');

const { initializeDatabase } = require('../src/db/migrate.ts');
initializeDatabase();

const dbPath = path.join(TEST_DATA_DIR, 'outreach.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Seed authoritative Gemini company classifications for test companies
db.prepare(`
  INSERT OR REPLACE INTO company_classifications (
    normalized_name, company_name, is_relevant, confidence, reason,
    classification_source, gemini_model, classification_result, created_at, updated_at
  ) VALUES
    ('infosys', 'Infosys', 1, 0.99, 'Relevant — Gemini: Leading digital IT consulting services provider.', 'gemini', 'gemini-3.8-flash', 'RELEVANT', datetime('now'), datetime('now')),
    ('microsoft', 'Microsoft', 1, 1.0, 'Relevant — Gemini: Global cloud and enterprise software developer.', 'gemini', 'gemini-3.8-flash', 'RELEVANT', datetime('now'), datetime('now')),
    ('google', 'Google', 1, 1.0, 'Relevant — Gemini: AI, cloud, and distributed software systems leader.', 'gemini', 'gemini-3.8-flash', 'RELEVANT', datetime('now'), datetime('now')),
    ('wipro', 'Wipro', 1, 0.99, 'Relevant — Gemini: Global information technology services.', 'gemini', 'gemini-3.8-flash', 'RELEVANT', datetime('now'), datetime('now')),
    ('amazon', 'Amazon', 1, 1.0, 'Relevant — Gemini: Global cloud computing (AWS) and software engineering.', 'gemini', 'gemini-3.8-flash', 'RELEVANT', datetime('now'), datetime('now')),
    ('oracle', 'Oracle', 1, 0.99, 'Relevant — Gemini: Enterprise cloud database solutions.', 'gemini', 'gemini-3.8-flash', 'RELEVANT', datetime('now'), datetime('now')),
    ('oracle cloud', 'Oracle Cloud Systems', 1, 0.99, 'Relevant — Gemini: Enterprise cloud database solutions.', 'gemini', 'gemini-3.8-flash', 'RELEVANT', datetime('now'), datetime('now'))
`).run();

const { processBatchFile } = require('../src/lib/pipeline/batch-processor.ts');
const { deleteBatch } = require('../src/lib/pipeline/batch-manager.ts');

console.log('======================================================================');
console.log('RE-UPLOAD AND DEDUPLICATION RULES VERIFICATION');
console.log('======================================================================\n');

async function runTests() {
  let passedAssertions = 0;

  function pass(msg) {
    console.log(`✓ [PASS] ${msg}`);
    passedAssertions++;
  }

  // --- Test 1: Real Sent -> Re-upload Remains Blocked ---
  console.log('--- Test 1: Real Sent -> Re-upload Remains Blocked ---');
  {
    const csvContent = Buffer.from(
      'Company,HR Name,Email\nInfosys,Real Sent Recruiter,realsent.hr@infosys.com\n'
    );
    const batch1 = await processBatchFile(csvContent, 'batch_real_sent.csv');
    assert.strictEqual(batch1.totalRecords, 1);

    // Simulate genuine real send in database
    const contact = db.prepare('SELECT * FROM contacts WHERE batch_id = ?').get(batch1.batchId);
    db.prepare(`
      UPDATE contacts
      SET status = 'sent', sent_at = datetime('now'), gmail_message_id = 'real_gmail_msg_12345'
      WHERE id = ?
    `).run(contact.id);

    db.prepare(`
      INSERT INTO global_email_history (email, first_contact_id, first_batch_id, first_seen_at, sent_at, status)
      VALUES ('realsent.hr@infosys.com', ?, ?, datetime('now'), datetime('now'), 'sent')
      ON CONFLICT(email) DO UPDATE SET status = 'sent', sent_at = datetime('now')
    `).run(contact.id, batch1.batchId);

    // Now delete the batch
    const delResult = deleteBatch(batch1.batchId);
    assert.strictEqual(delResult.success, true);
    assert.strictEqual(delResult.sentContactsPreserved, 1);

    // Verify global_email_history preserved the real send
    const hist = db.prepare('SELECT * FROM global_email_history WHERE email = ?').get('realsent.hr@infosys.com');
    assert(hist, 'Real sent email MUST remain in global_email_history after batch deletion');
    assert.strictEqual(hist.status, 'sent', 'Status must remain sent');
    pass('Real sent email permanently preserved in global_email_history across batch deletion');

    // Re-upload the exact same CSV
    const batch2 = await processBatchFile(csvContent, 'batch_real_sent_reupload.csv');
    const contact2 = db.prepare('SELECT * FROM contacts WHERE batch_id = ?').get(batch2.batchId);
    assert.strictEqual(contact2.is_duplicate, 1, 'Re-uploaded real sent contact must be marked is_duplicate = 1');
    assert.strictEqual(contact2.status, 'skipped', 'Re-uploaded real sent contact must be skipped');
    assert(contact2.relevance_reason.includes('Duplicate: email in active 6-day cooldown or currently queued.'));
    assert.strictEqual(batch2.emailsPending, 0, 'No outreach pending for real sent contact');
    pass('Re-upload of genuinely sent contact remains strictly blocked globally under 6-day cooldown');
  }

  // --- Test 2: Dry-Run Only -> Re-upload Eligible ---
  console.log('\n--- Test 2: Dry-Run Only -> Re-upload Eligible ---');
  {
    const csvContent = Buffer.from(
      'Company,HR Name,Email\nGoogle,Simulated Recruiter,dryrun.sim@google.com\n'
    );
    const batch1 = await processBatchFile(csvContent, 'batch_dryrun_sim.csv');
    assert.strictEqual(batch1.totalRecords, 1);

    // Simulate dry-run processing (status = simulated, NO real sent_at, gmail_message_id starts with dryrun_)
    const contact1 = db.prepare('SELECT * FROM contacts WHERE batch_id = ?').get(batch1.batchId);
    db.prepare(`
      UPDATE contacts
      SET status = 'simulated', sent_at = NULL, gmail_message_id = 'dryrun_178854_msg'
      WHERE id = ?
    `).run(contact1.id);

    // Delete the batch
    const delResult = deleteBatch(batch1.batchId);
    assert.strictEqual(delResult.success, true);

    // Verify it is NOT preserved as sent in global_email_history
    const hist = db.prepare('SELECT * FROM global_email_history WHERE email = ?').get('dryrun.sim@google.com');
    assert(!hist || hist.status !== 'sent', 'Simulated dry-run must NOT be left as sent in global_email_history');
    pass('Dry-run simulated email cleaned from global history upon batch delete');

    // Re-upload the exact same CSV
    const batch2 = await processBatchFile(csvContent, 'batch_dryrun_sim_reupload.csv');
    const contact2 = db.prepare('SELECT * FROM contacts WHERE batch_id = ?').get(batch2.batchId);
    assert.strictEqual(contact2.is_duplicate, 0, 'Previously simulated email MUST NOT be flagged duplicate on re-upload');
    assert.strictEqual(contact2.status, 'queued', 'Previously simulated email must be queued for outreach');
    assert.strictEqual(batch2.emailsPending, 1, 'Email is eligible and pending');
    pass('Re-upload of dry-run simulated contact is fully eligible');
  }

  // --- Test 3: Deleted Queued Contact -> Re-upload Eligible ---
  console.log('\n--- Test 3: Deleted Queued Contact -> Re-upload Eligible ---');
  {
    const csvContent = Buffer.from(
      'Company,HR Name,Email\nMicrosoft,Unsent Recruiter,queued.unsent@microsoft.com\n'
    );
    const batch1 = await processBatchFile(csvContent, 'batch_queued_unsent.csv');
    assert.strictEqual(batch1.totalRecords, 1);
    assert.strictEqual(batch1.emailsPending, 1);

    // Delete batch while contact was merely queued
    const delResult = deleteBatch(batch1.batchId);
    assert.strictEqual(delResult.success, true);
    assert.strictEqual(delResult.queuedContactsCancelled, 1);

    // Re-upload the exact same CSV
    const batch2 = await processBatchFile(csvContent, 'batch_queued_unsent_reupload.csv');
    const contact2 = db.prepare('SELECT * FROM contacts WHERE batch_id = ?').get(batch2.batchId);
    assert.strictEqual(contact2.is_duplicate, 0, 'Unsent contact from deleted batch MUST NOT be flagged duplicate');
    assert.strictEqual(contact2.status, 'queued', 'Unsent contact from deleted batch must be queued');
    assert.strictEqual(batch2.emailsPending, 1, 'Email is eligible and pending');
    pass('Re-upload of contact from deleted batch is fully eligible');
  }

  // --- Test 4: Active Queued Contact -> Correctly Deduplicated ---
  console.log('\n--- Test 4: Active Queued Contact -> Correctly Deduplicated ---');
  {
    const csvA = Buffer.from(
      'Company,HR Name,Email\nAmazon,Active Recruiter,active.recruiter@amazon.com\n'
    );
    const batchA = await processBatchFile(csvA, 'batch_active_A.csv');
    assert.strictEqual(batchA.emailsPending, 1);

    // Upload Batch B while Batch A is still active and queued
    const csvB = Buffer.from(
      'Company,HR Name,Email\nAmazon,Active Recruiter,active.recruiter@amazon.com\n'
    );
    const batchB = await processBatchFile(csvB, 'batch_active_B.csv');
    const contactB = db.prepare('SELECT * FROM contacts WHERE batch_id = ?').get(batchB.batchId);
    assert.strictEqual(contactB.is_duplicate, 1, 'Duplicate contact in active batch must be flagged');
    assert.strictEqual(contactB.status, 'skipped', 'Duplicate contact in active batch must be skipped');
    assert.strictEqual(batchB.emailsPending, 0, 'No pending emails in Batch B for active queued contact');
    pass('Contact currently queued in an active batch is correctly deduplicated');
  }

  // --- Test 5: Same Company + Different Emails -> Both Allowed ---
  console.log('\n--- Test 5: Same Company + Different Emails -> Both Allowed ---');
  {
    const multiContactCsv = Buffer.from(
      'Company,HR Name,Email\n' +
      'Infosys,Recruiter One,recruiter.one@infosys.com\n' +
      'Infosys,Recruiter Two,recruiter.two@infosys.com\n' +
      'Infosys,Recruiter Three,recruiter.three@infosys.com\n'
    );
    const batch = await processBatchFile(multiContactCsv, 'infosys_diff_emails.csv');
    assert.strictEqual(batch.totalRecords, 3);
    assert.strictEqual(batch.duplicateContacts, 0, 'Different emails at same company MUST NOT be flagged duplicate');
    assert.strictEqual(batch.emailsPending, 3, 'All 3 different recruiter emails must be pending');

    const contactsList = db.prepare('SELECT email, is_duplicate, status FROM contacts WHERE batch_id = ?').all(batch.batchId);
    for (const c of contactsList) {
      assert.strictEqual(c.is_duplicate, 0);
      assert.strictEqual(c.status, 'queued');
    }
    pass('Different recruiter emails for same company are all eligible and queued');
  }

  // --- Test 6: Same Email Globally -> Blocked ---
  console.log('\n--- Test 6: Same Email Globally -> Blocked ---');
  {
    // Upload same email with different casing/whitespace and company variations
    const emailToTest = 'global.dedup.test@oracle.com';
    const csv1 = Buffer.from(`Company,HR Name,Email\nOracle,Test HR,${emailToTest}\n`);
    const b1 = await processBatchFile(csv1, 'b1.csv');

    // Simulate real send
    const c1 = db.prepare('SELECT * FROM contacts WHERE batch_id = ?').get(b1.batchId);
    db.prepare(`UPDATE contacts SET status = 'sent', sent_at = datetime('now'), gmail_message_id = 'real_msg_oracle' WHERE id = ?`).run(c1.id);
    db.prepare(`
      INSERT INTO global_email_history (email, first_contact_id, first_batch_id, first_seen_at, sent_at, status)
      VALUES (?, ?, ?, datetime('now'), datetime('now'), 'sent')
      ON CONFLICT(email) DO UPDATE SET status = 'sent', sent_at = datetime('now')
    `).run(emailToTest, c1.id, b1.batchId);

    // Second batch with uppercase and whitespace under different company name
    const csv2 = Buffer.from(`Company,HR Name,Email\nOracle Cloud Systems,Test HR,  ${emailToTest.toUpperCase()}  \n`);
    const b2 = await processBatchFile(csv2, 'b2.csv');
    const c2 = db.prepare('SELECT * FROM contacts WHERE batch_id = ?').get(b2.batchId);
    assert.strictEqual(c2.is_duplicate, 1, 'Normalized email match must block across companies/casing');
    assert.strictEqual(c2.status, 'skipped');
    pass('Normalized email globally deduplicates across different companies and casing');
  }

  // --- Test 7: Startup Self-Healing Migration Reconciliation ---
  console.log('\n--- Test 7: Startup Self-Healing Migration Reconciliation ---');
  {
    // Insert bogus "sent" record in global_email_history that was never actually sent in contacts
    db.prepare(`
      INSERT INTO global_email_history (email, first_seen_at, sent_at, status)
      VALUES ('phantom.sent@example.com', datetime('now'), datetime('now'), 'sent')
    `).run();

    // Insert orphaned "queued" record from a deleted batch
    db.prepare(`
      INSERT INTO global_email_history (email, first_seen_at, status)
      VALUES ('orphaned.queued@example.com', datetime('now'), 'queued')
    `).run();

    // Verify they exist before migration
    assert(db.prepare('SELECT * FROM global_email_history WHERE email = ?').get('phantom.sent@example.com'));
    assert(db.prepare('SELECT * FROM global_email_history WHERE email = ?').get('orphaned.queued@example.com'));

    // Re-run initializeDatabase()
    initializeDatabase();

    // Verify phantom sent record was purged
    const phantom = db.prepare('SELECT * FROM global_email_history WHERE email = ?').get('phantom.sent@example.com');
    assert.strictEqual(phantom, undefined, 'Phantom sent record must be purged by self-healing migration');

    // Verify orphaned queued record was purged
    const orphaned = db.prepare('SELECT * FROM global_email_history WHERE email = ?').get('orphaned.queued@example.com');
    assert.strictEqual(orphaned, undefined, 'Orphaned queued record must be purged by self-healing migration');
    pass('Self-healing startup migration purges phantom and orphaned global_email_history records');

    // Test 8: Reconciles contacts falsely marked duplicate of previous outreach in active batches
    const testBatchId = 'batch_reconcile_test';
    db.prepare(`
      INSERT INTO batches (id, filename, upload_date, total_records, valid_records, relevant_companies, duplicate_contacts, emails_pending, status, created_at, updated_at)
      VALUES (?, 'test_reconcile.csv', datetime('now'), 2, 2, 2, 2, 0, 'queued', datetime('now'), datetime('now'))
    `).run(testBatchId);

    // Contact 1: falsely marked duplicate of previous outreach (Category D phantom)
    const cPhantomId = 'contact_phantom_1';
    db.prepare(`
      INSERT INTO contacts (id, batch_id, email, company_name, is_relevant, email_valid, is_duplicate, status, relevance_reason, created_at, updated_at)
      VALUES (?, ?, 'reconciled.candidate@example.com', 'Tech Corp', NULL, 1, 1, 'skipped', 'Duplicate: email already queued or contacted in previous outreach.', datetime('now'), datetime('now'))
    `).run(cPhantomId, testBatchId);

    // Contact 2: legitimate in-file duplicate (Category E)
    const cInfileId = 'contact_infile_2';
    db.prepare(`
      INSERT INTO contacts (id, batch_id, email, company_name, is_relevant, email_valid, is_duplicate, status, relevance_reason, created_at, updated_at)
      VALUES (?, ?, 'infile.dup@example.com', 'Tech Corp', 1, 1, 1, 'skipped', 'Duplicate: email already appears in this file.', datetime('now'), datetime('now'))
    `).run(cInfileId, testBatchId);

    // Run migration
    initializeDatabase();

    // Verify Contact 1 was reconciled to queued and duplicate = 0
    const recContact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(cPhantomId);
    assert.strictEqual(recContact.status, 'queued', 'Falsely marked contact must be restored to queued');
    assert.strictEqual(recContact.is_duplicate, 0, 'Falsely marked contact must have is_duplicate = 0');

    // Verify pending queue item created
    const queueItem = db.prepare('SELECT * FROM outreach_queue WHERE contact_id = ?').get(cPhantomId);
    assert(queueItem, 'Queue item must be created for reconciled contact');
    assert.strictEqual(queueItem.status, 'pending', 'Reconciled queue item must be in pending status');

    // Verify Contact 2 (in-file duplicate) was NOT touched
    const infileContact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(cInfileId);
    assert.strictEqual(infileContact.status, 'skipped', 'Legitimate in-file duplicate must remain skipped');
    assert.strictEqual(infileContact.is_duplicate, 1, 'Legitimate in-file duplicate must remain is_duplicate = 1');

    // Verify batch counts updated
    const updatedBatch = db.prepare('SELECT * FROM batches WHERE id = ?').get(testBatchId);
    assert.strictEqual(updatedBatch.duplicate_contacts, 1, 'Batch duplicate_contacts must now only count the 1 in-file duplicate');
    assert.strictEqual(updatedBatch.emails_pending, 1, 'Batch emails_pending must now be 1');
    pass('Self-healing migration successfully reconciles falsely marked contacts and creates pending queue items');
  }

  console.log('\n======================================================================');
  console.log(`ALL RE-UPLOAD & DEDUPLICATION TESTS PASSED: ${passedAssertions}/${passedAssertions}`);
  console.log('REAL RECRUITER EMAILS DISPATCHED: 0');
  console.log('======================================================================');
}

runTests().catch((err) => {
  console.error('\n❌ Test Suite Failed:', err);
  process.exit(1);
});
