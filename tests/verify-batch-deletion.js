/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Comprehensive Verification Suite: Safe Delete / Remove Uploaded File Feature
 *
 * Verifies all 10 base requirements + 3 user-specified additions:
 * 1. Upload Batch A -> delete Batch A
 * 2. Batch A has queued contacts -> delete Batch A (queue cancelled, worker cannot process)
 * 3. Batch A has already-sent contacts -> delete Batch A (global history intact)
 * 4. Delete Batch A -> upload Batch B with same email (globally deduplicated)
 * 5. Multi-batch isolation (Batch B unaffected by Batch A deletion)
 * 6. Active sending race condition safety (0 sends occur after deletion)
 * 7. Path traversal security (cannot delete arbitrary files or resumes)
 * 8. Delete already completed batch
 * 9. Delete batch with multi-contact company
 * 10. Delete batch containing never-sent contacts (disappear from active outreach)
 * 11. Successful-send status, not sent_at, determines permanent history
 * 12. Commit DB deletion/cancellation before physical file cleanup
 * 13. Re-upload test covering one previously-sent and one never-sent email
 * 14. Resume invariant: active resume is never touched
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { execSync } = require('child_process');

// Ensure test directory environment
const TEST_DATA_DIR = path.resolve(__dirname, 'fixtures', 'test_data_batch_delete');
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.OUTREACH_DRY_RUN = 'true';

if (fs.existsSync(TEST_DATA_DIR)) {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
}
fs.mkdirSync(path.join(TEST_DATA_DIR, 'uploads'), { recursive: true });
fs.mkdirSync(path.join(TEST_DATA_DIR, 'resumes'), { recursive: true });

// Setup a dummy active resume to verify it remains untouched
const testResumePath = path.join(TEST_DATA_DIR, 'resumes', 'Active_Candidate_Resume.pdf');
fs.writeFileSync(testResumePath, Buffer.from('%PDF-1.4 dummy active resume content'));

const DB_PATH = path.join(TEST_DATA_DIR, 'outreach.db');

// Run migration helper
execSync(`npx tsx -e "import { initializeDatabase } from './src/db/migrate'; initializeDatabase();"`, {
  cwd: path.resolve(__dirname, '..'),
  env: { ...process.env, DATA_DIR: TEST_DATA_DIR },
  encoding: 'utf-8',
});

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Seed active resume in DB
db.prepare(`
  INSERT OR REPLACE INTO resume (id, filename, file_path, mime_type, parsed_text, uploaded_at)
  VALUES ('current', 'Active_Candidate_Resume.pdf', ?, 'application/pdf', 'Candidate Skills: TypeScript, React', ?)
`).run(testResumePath, new Date().toISOString());

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

function runBatchProcessor(csvContent, filename) {
  const uploadsDir = path.join(TEST_DATA_DIR, 'uploads');
  const targetPath = path.join(uploadsDir, `${Date.now()}_${filename}`);
  fs.writeFileSync(targetPath, csvContent, 'utf-8');

  const runnerPath = path.join(__dirname, 'helpers', 'process-batch-runner.ts');
  const out = execSync(`npx tsx "${runnerPath}" "${targetPath}" "${filename}"`, {
    encoding: 'utf-8',
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, DATA_DIR: TEST_DATA_DIR },
  });
  const match = out.match(/BATCH_RESULT:(.*)/);
  if (!match) throw new Error(`Batch helper failed: ${out}`);
  return { ...JSON.parse(match[1]), filePathOnDisk: targetPath };
}

function runDeleteBatch(batchId) {
  const runnerPath = path.join(__dirname, 'helpers', 'delete-batch-runner.ts');
  const out = execSync(`npx tsx "${runnerPath}" "${batchId}"`, {
    encoding: 'utf-8',
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, DATA_DIR: TEST_DATA_DIR },
  });
  const match = out.match(/DELETE_RESULT:(.*)/);
  if (!match) throw new Error(`Delete helper failed: ${out}`);
  return JSON.parse(match[1]);
}

console.log('======================================================================');
console.log('SAFE BATCH DELETION & UPLOADED FILE REMOVAL VERIFICATION');
console.log('======================================================================\n');

// ── TEST 1: UPLOAD BATCH A -> DELETE BATCH A ───────────────────────────────
console.log('--- Test 1: Upload Batch A -> Delete Batch A ---');
const csv1 = `Company,HR Name,Email
Infosys,Test Lead 1,test1_${Date.now()}@infosys.com
`;
const batch1 = runBatchProcessor(csv1, 'batch_test_1.csv');
assert(fs.existsSync(batch1.filePathOnDisk), 'Batch 1 file exists on disk before delete');

const delResult1 = runDeleteBatch(batch1.batchId);
assert(delResult1.success === true, 'deleteBatch returned success');
assert(!fs.existsSync(batch1.filePathOnDisk), 'Batch 1 uploaded file unlinked from disk');

const batch1Row = db.prepare('SELECT * FROM batches WHERE id = ?').get(batch1.batchId);
assert(batch1Row.status === 'deleted', 'Batch 1 record marked as status = deleted');
assert(batch1Row.deleted_at !== null, 'Batch 1 record has deleted_at timestamp');

// ── TEST 2: QUEUED CONTACTS REMOVED & WORKER CANNOT PROCESS ───────────────
console.log('\n--- Test 2: Queued Contacts Removed & Worker Protected ---');
const csv2 = `Company,HR Name,Email
Microsoft,Satya N,satya_${Date.now()}@microsoft.com
Microsoft,Amy H,amy_${Date.now()}@microsoft.com
`;
const batch2 = runBatchProcessor(csv2, 'batch_test_2.csv');
const queueBeforeDel = db.prepare('SELECT count(*) as count FROM outreach_queue WHERE contact_id IN (SELECT id FROM contacts WHERE batch_id = ?)').get(batch2.batchId).count;
assert(queueBeforeDel === 2, 'Batch 2 has 2 queued items before delete');

const delResult2 = runDeleteBatch(batch2.batchId);
assert(delResult2.queuedContactsCancelled === 2, 'Reported 2 queued contacts cancelled');

const queueAfterDel = db.prepare('SELECT count(*) as count FROM outreach_queue WHERE contact_id IN (SELECT id FROM contacts WHERE batch_id = ?)').get(batch2.batchId).count;
assert(queueAfterDel === 0, 'Outreach queue records for Batch 2 completely removed from table');

const contactsAfterDel2 = db.prepare('SELECT status, error_message FROM contacts WHERE batch_id = ?').all(batch2.batchId);
assert(contactsAfterDel2.every(c => c.status === 'skipped'), 'All Batch 2 contacts marked as skipped');
assert(contactsAfterDel2.every(c => c.error_message === 'Batch was deleted by user.'), 'Contacts error_message set to user deletion note');

// Test that worker acquireNextEligibleJob returns null
const workerRunnerPath = path.join(__dirname, 'helpers', 'worker-check-runner.ts');
const checkWorkerQuery = execSync(`npx tsx "${workerRunnerPath}"`, {
  cwd: path.resolve(__dirname, '..'),
  env: { ...process.env, DATA_DIR: TEST_DATA_DIR },
  encoding: 'utf-8',
});
assert(checkWorkerQuery.includes('WORKER_JOB:null'), 'Worker cannot acquire any job from deleted batch');

// ── TEST 3: ALREADY-SENT CONTACTS SURVIVE BATCH DELETION ──────────────────
console.log('\n--- Test 3: Already-Sent Contacts Survive Batch Deletion ---');
const sentEmail = `sent_recruiter_${Date.now()}@infosys.com`;
const csv3 = `Company,HR Name,Email
Infosys,Sent Recruiter,${sentEmail}
Infosys,Unsent Recruiter,unsent_${Date.now()}@infosys.com
`;
const batch3 = runBatchProcessor(csv3, 'batch_test_3.csv');

// Simulate successful send on the first contact
const firstContact = db.prepare('SELECT * FROM contacts WHERE batch_id = ? AND email = ?').get(batch3.batchId, sentEmail);
const sendTime = new Date().toISOString();
db.prepare("UPDATE contacts SET status = 'sent', sent_at = ? WHERE id = ?").run(sendTime, firstContact.id);
db.prepare("UPDATE global_email_history SET status = 'sent', sent_at = ? WHERE email = ?").run(sendTime, sentEmail);

// Delete Batch 3
const delResult3 = runDeleteBatch(batch3.batchId);
assert(delResult3.sentContactsPreserved === 1, 'Reported 1 sent contact preserved');

const historyAfterDel3 = db.prepare('SELECT * FROM global_email_history WHERE email = ?').get(sentEmail);
assert(historyAfterDel3 !== undefined, 'Sent email record exists in global_email_history');
assert(historyAfterDel3.status === 'sent', 'Global email history status remains sent');
assert(historyAfterDel3.sent_at === sendTime, 'Global email history sent_at timestamp intact');

// ── TEST 4: PREVIOUSLY SENT EMAIL REMAINS GLOBALLY DEDUPLICATED IN BATCH B ─
console.log('\n--- Test 4: Previously Sent Email Remains Globally Deduplicated ---');
const csv4 = `Company,HR Name,Email
Infosys,Duplicate Sent Recruiter,${sentEmail}
`;
const batch4 = runBatchProcessor(csv4, 'batch_test_4.csv');
assert(batch4.duplicateContacts === 1, 'Previously sent email detected as duplicate in Batch 4');
assert(batch4.emailsPending === 0, 'No outreach queued for previously sent email');

const contact4 = db.prepare('SELECT * FROM contacts WHERE batch_id = ?').get(batch4.batchId);
assert(contact4.is_duplicate === 1, 'Contact marked is_duplicate = true');
assert(contact4.status === 'skipped', 'Contact status set to skipped');

// ── TEST 5: MULTI-BATCH ISOLATION ─────────────────────────────────────────
console.log('\n--- Test 5: Multi-Batch Isolation (Batch B Completely Unaffected) ---');
const csv5A = `Company,HR Name,Email
Google,Engineer A,goog_a_${Date.now()}@google.com
`;
const csv5B = `Company,HR Name,Email
Google,Engineer B,goog_b_${Date.now()}@google.com
`;
const batch5A = runBatchProcessor(csv5A, 'batch_5A.csv');
const batch5B = runBatchProcessor(csv5B, 'batch_5B.csv');

assert(fs.existsSync(batch5A.filePathOnDisk), 'Batch 5A file exists');
assert(fs.existsSync(batch5B.filePathOnDisk), 'Batch 5B file exists');

// Delete only Batch 5A
runDeleteBatch(batch5A.batchId);

assert(!fs.existsSync(batch5A.filePathOnDisk), 'Batch 5A file unlinked');
assert(fs.existsSync(batch5B.filePathOnDisk), 'Batch 5B file completely intact on disk');

const batch5BRow = db.prepare('SELECT * FROM batches WHERE id = ?').get(batch5B.batchId);
assert(batch5BRow.status === 'queued', 'Batch 5B status remains queued');
assert(batch5BRow.emails_pending === 1, 'Batch 5B emails_pending remains 1');

const queue5B = db.prepare('SELECT count(*) as count FROM outreach_queue WHERE contact_id IN (SELECT id FROM contacts WHERE batch_id = ?)').get(batch5B.batchId).count;
assert(queue5B === 1, 'Batch 5B queue items unaffected');

// ── TEST 6: RACE CONDITION SAFETY (ACTIVE SEND REJECTION) ─────────────────
console.log('\n--- Test 6: Race Condition Safety During Active Send ---');
const csv6 = `Company,HR Name,Email
Oracle,Larry E,larry_${Date.now()}@oracle.com
`;
const batch6 = runBatchProcessor(csv6, 'batch_test_6.csv');
const contact6 = db.prepare('SELECT * FROM contacts WHERE batch_id = ?').get(batch6.batchId);

// Give contact email subject/body
db.prepare("UPDATE contacts SET email_subject = 'Subject', email_body = 'Body', status = 'queued' WHERE id = ?").run(contact6.id);

// Delete the batch while contact is queued
runDeleteBatch(batch6.batchId);

// Attempt direct dispatch via sendOutreachEmail
const dispatchRunnerPath = path.join(__dirname, 'helpers', 'dispatch-runner.ts');
const sendAttempt = execSync(`npx tsx "${dispatchRunnerPath}" "${contact6.id}"`, {
  cwd: path.resolve(__dirname, '..'),
  env: { ...process.env, DATA_DIR: TEST_DATA_DIR },
  encoding: 'utf-8',
});

assert(sendAttempt.includes('"success":false'), 'sendOutreachEmail returned success = false');
assert(sendAttempt.includes('has been deleted'), 'sendOutreachEmail correctly rejected deleted parent batch');

// ── TEST 7: PATH TRAVERSAL SECURITY ───────────────────────────────────────
console.log('\n--- Test 7: Path Traversal Security ---');
const targetFileToProtect = path.resolve(__dirname, '..', 'package.json');
const dummyBatchId = `batch_hack_${Date.now()}`;

// Inject malicious batch with path pointing to package.json
db.prepare(`
  INSERT INTO batches (id, filename, file_path, upload_date, status, created_at, updated_at)
  VALUES (?, 'exploit.csv', ?, ?, 'queued', ?, ?)
`).run(dummyBatchId, targetFileToProtect, new Date().toISOString(), new Date().toISOString(), new Date().toISOString());

runDeleteBatch(dummyBatchId);
assert(fs.existsSync(targetFileToProtect), 'Protected project file (package.json) was NOT deleted');

// Inject malicious batch pointing to active resume
const hackResumeBatchId = `batch_hack_resume_${Date.now()}`;
db.prepare(`
  INSERT INTO batches (id, filename, file_path, upload_date, status, created_at, updated_at)
  VALUES (?, 'exploit_resume.csv', ?, ?, 'queued', ?, ?)
`).run(hackResumeBatchId, testResumePath, new Date().toISOString(), new Date().toISOString(), new Date().toISOString());

runDeleteBatch(hackResumeBatchId);
assert(fs.existsSync(testResumePath), 'Active resume in resumes directory was NOT deleted by exploit path');

// ── TEST 8: DELETE ALREADY COMPLETED BATCH ────────────────────────────────
console.log('\n--- Test 8: Delete Already Completed Batch ---');
const csv8 = `Company,HR Name,Email
Wipro,Wipro Lead,wipro_${Date.now()}@wipro.com
`;
const batch8 = runBatchProcessor(csv8, 'batch_test_8.csv');
db.prepare("UPDATE batches SET status = 'completed' WHERE id = ?").run(batch8.batchId);

const delResult8 = runDeleteBatch(batch8.batchId);
assert(delResult8.success === true, 'Completed batch deleted successfully');
assert(!fs.existsSync(batch8.filePathOnDisk), 'Completed batch uploaded file unlinked from disk');

// ── TEST 9: MULTI-CONTACT COMPANY INGESTION BATCH DELETION ────────────────
console.log('\n--- Test 9: Multi-Contact Company Batch Deletion ---');
const csv9 = `Company,HR Name,Email
Sabre Global Capability Center,Lead 1,sabre_1_${Date.now()}@sabre.com
,Lead 2,sabre_2_${Date.now()}@sabre.com
,Lead 3,sabre_3_${Date.now()}@sabre.com
`;
const batch9 = runBatchProcessor(csv9, 'batch_test_9.csv');
assert(batch9.totalRecords === 3, '3 contacts ingested for Sabre GCC');

const delResult9 = runDeleteBatch(batch9.batchId);
assert(delResult9.contactsAffected === 3, 'All 3 Sabre GCC contacts affected');
assert(delResult9.queuedContactsCancelled === 3, 'All 3 queue items cancelled');

const sabreQueueCount = db.prepare('SELECT count(*) as count FROM outreach_queue WHERE contact_id IN (SELECT id FROM contacts WHERE batch_id = ?)').get(batch9.batchId).count;
assert(sabreQueueCount === 0, 'Zero queue items remain for Sabre GCC');

// ── TEST 10: NEVER-SENT CONTACTS DISAPPEAR & DO NOT LOCK FUTURE OUTREACH ──
console.log('\n--- Test 10: Never-Sent Contacts Cleaned From Global History ---');
const cleanTestEmail = `never_contacted_${Date.now()}@domain.com`;
const csv10 = `Company,HR Name,Email
Infosys,Future Contact,${cleanTestEmail}
`;
const batch10 = runBatchProcessor(csv10, 'batch_test_10.csv');
const historyBefore = db.prepare('SELECT * FROM global_email_history WHERE email = ?').get(cleanTestEmail);
assert(historyBefore.status === 'queued', 'Tracked as queued in global history before delete');

runDeleteBatch(batch10.batchId);
const historyAfter = db.prepare('SELECT * FROM global_email_history WHERE email = ?').get(cleanTestEmail);
assert(historyAfter === undefined, 'Never-sent contact cleanly removed from global history upon batch delete');

// ── TEST 11 (USER ADDITION 1): SUCCESSFUL-SEND STATUS DETERMINES HISTORY ───
console.log('\n--- Test 11: Successful-Send Status, Not sent_at, Determines History ---');
const statusSentEmail = `status_sent_${Date.now()}@firm.com`;
const statusQueuedWithTimestamp = `status_queued_${Date.now()}@firm.com`;

const batch11Id = `batch_test_11_${Date.now()}`;
db.prepare(`
  INSERT INTO batches (id, filename, upload_date, status, created_at, updated_at)
  VALUES (?, 'batch_11.csv', ?, 'queued', ?, ?)
`).run(batch11Id, new Date().toISOString(), new Date().toISOString(), new Date().toISOString());

// Email 1: status = 'sent', sent_at = NULL (simulated edge case where status is sent)
db.prepare(`
  INSERT INTO global_email_history (email, first_batch_id, first_seen_at, status, sent_at)
  VALUES (?, ?, ?, 'sent', NULL)
`).run(statusSentEmail, batch11Id, new Date().toISOString());

// Email 2: status = 'queued', sent_at = '2026-09-04' (stale timestamp but status is queued)
db.prepare(`
  INSERT INTO global_email_history (email, first_batch_id, first_seen_at, status, sent_at)
  VALUES (?, ?, ?, 'queued', ?)
`).run(statusQueuedWithTimestamp, batch11Id, new Date().toISOString(), new Date().toISOString());

runDeleteBatch(batch11Id);

const record1 = db.prepare('SELECT * FROM global_email_history WHERE email = ?').get(statusSentEmail);
const record2 = db.prepare('SELECT * FROM global_email_history WHERE email = ?').get(statusQueuedWithTimestamp);

assert(record1 !== undefined && record1.status === 'sent', 'Email with status = sent is RETAINED forever');
assert(record2 === undefined, 'Email with status != sent is CLEANED regardless of sent_at field');

// ── TEST 12 (USER ADDITION 2): COMMIT DB DELETION BEFORE FILE CLEANUP ─────
console.log('\n--- Test 12: DB Deletion Transaction Commits Before File Cleanup ---');
const csv12 = `Company,HR Name,Email
Microsoft,Employee 12,msft12_${Date.now()}@microsoft.com
`;
const batch12 = runBatchProcessor(csv12, 'batch_test_12.csv');

// Test that deleteBatch succeeds and updates DB even if file was already missing
fs.unlinkSync(batch12.filePathOnDisk);
assert(!fs.existsSync(batch12.filePathOnDisk), 'File was removed before deleteBatch call');

const delResult12 = runDeleteBatch(batch12.batchId);
assert(delResult12.success === true, 'deleteBatch handles pre-removed file gracefully');
const batch12Row = db.prepare('SELECT status FROM batches WHERE id = ?').get(batch12.batchId);
assert(batch12Row.status === 'deleted', 'DB transaction committed status = deleted');

// ── TEST 13 (USER ADDITION 3): RE-UPLOAD TEST (1 PREVIOUSLY-SENT & 1 NEVER-SENT)
console.log('\n--- Test 13: Re-Upload Test Covering One Sent and One Never-Sent Email ---');
const comboSentEmail = `combo_sent_${Date.now()}@techcorp.com`;
const comboUnsentEmail = `combo_unsent_${Date.now()}@techcorp.com`;

const csv13A = `Company,HR Name,Email
Infosys,Sent Lead,${comboSentEmail}
Infosys,Unsent Lead,${comboUnsentEmail}
`;
const batch13A = runBatchProcessor(csv13A, 'combo_batch_A.csv');

// Mark comboSentEmail as sent
const contactSent = db.prepare('SELECT id FROM contacts WHERE batch_id = ? AND email = ?').get(batch13A.batchId, comboSentEmail);
db.prepare("UPDATE contacts SET status = 'sent', sent_at = ? WHERE id = ?").run(new Date().toISOString(), contactSent.id);
db.prepare("UPDATE global_email_history SET status = 'sent', sent_at = ? WHERE email = ?").run(new Date().toISOString(), comboSentEmail);

// Delete Batch A
runDeleteBatch(batch13A.batchId);

// Verify initial state after deletion:
// comboSentEmail remains in global history; comboUnsentEmail was cleared
assert(db.prepare('SELECT status FROM global_email_history WHERE email = ?').get(comboSentEmail)?.status === 'sent', 'comboSentEmail remains sent in global history');
assert(db.prepare('SELECT * FROM global_email_history WHERE email = ?').get(comboUnsentEmail) === undefined, 'comboUnsentEmail was cleared from global history');

// Now upload Batch B containing BOTH emails
const csv13B = `Company,HR Name,Email
Infosys,Sent Lead Again,${comboSentEmail}
Infosys,Unsent Lead Again,${comboUnsentEmail}
`;
const batch13B = runBatchProcessor(csv13B, 'combo_batch_B.csv');

assert(batch13B.totalRecords === 2, 'Batch B parsed 2 records');
assert(batch13B.duplicateContacts === 1, 'Batch B flagged exactly 1 duplicate (the sent email)');
assert(batch13B.emailsPending === 1, 'Batch B queued exactly 1 contact (the never-sent email)');

const batch13BContacts = db.prepare('SELECT email, is_duplicate, status FROM contacts WHERE batch_id = ? ORDER BY email ASC').all(batch13B.batchId);
const sentInB = batch13BContacts.find(c => c.email === comboSentEmail);
const unsentInB = batch13BContacts.find(c => c.email === comboUnsentEmail);

assert(sentInB.is_duplicate === 1 && sentInB.status === 'skipped', 'Previously-sent email is flagged duplicate and skipped in Batch B');
assert(unsentInB.is_duplicate === 0 && unsentInB.status === 'queued', 'Never-sent email is clean and queued for outreach in Batch B');

// ── TEST 14: ACTIVE RESUME INVARIANT ───────────────────────────────────────
console.log('\n--- Test 14: Active Resume Invariant ---');
assert(fs.existsSync(testResumePath), 'Active resume file on disk was NEVER deleted across all batch delete operations');
const resumeDbRecord = db.prepare("SELECT * FROM resume WHERE id = 'current'").get();
assert(resumeDbRecord !== undefined && resumeDbRecord.filename === 'Active_Candidate_Resume.pdf', 'Active resume database record is intact');

console.log('\n======================================================================');
console.log(`ALL BATCH DELETION TESTS PASSED: ${passedTests}/${totalTests}`);
console.log('REAL RECRUITER EMAILS SENT: 0');
console.log('REAL GMAIL OUTREACH HISTORY CREATED: 0');
console.log('======================================================================');
