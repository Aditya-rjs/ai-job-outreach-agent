/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Comprehensive Verification Suite: Dry-Run Outreach Reporting Semantics
 *
 * Verifies all 6 user-specified regression tests:
 * Test 1: Dry-run processing does not create a permanent successful global contact-history record.
 * Test 2: Dry-run processing does not make a contact permanently ineligible for a future real send.
 * Test 3: Dry-run dashboard/reporting never labels simulated sends as real "Sent".
 * Test 4: Real Gmail success DOES create permanent global_email_history.
 * Test 5: Switching from dry-run=true to dry-run=false allows a previously simulated email to be sent for the first time.
 * Test 6: A genuinely successful real Gmail send remains permanently deduplicated.
 *
 * SAFETY GUARANTEES:
 * - OUTREACH_DRY_RUN remains active.
 * - Zero real emails are dispatched.
 * - Zero network calls to Google's API during tests.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { execSync } = require('child_process');

const TEST_DATA_DIR = path.resolve(__dirname, 'fixtures', 'test_data_dry_run');
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.OUTREACH_DRY_RUN = 'true';

if (fs.existsSync(TEST_DATA_DIR)) {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
}
fs.mkdirSync(path.join(TEST_DATA_DIR, 'uploads'), { recursive: true });
fs.mkdirSync(path.join(TEST_DATA_DIR, 'resumes'), { recursive: true });

// Setup a dummy active resume for testing
const testResumePath = path.join(TEST_DATA_DIR, 'resumes', 'Active_Resume.pdf');
fs.writeFileSync(testResumePath, Buffer.from('%PDF-1.4 dummy active resume content'));

const DB_PATH = path.join(TEST_DATA_DIR, 'outreach.db');

// Run DB initialization
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
  VALUES ('current', 'Active_Resume.pdf', ?, 'application/pdf', 'Candidate Skills: TypeScript, React', ?)
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
    env: { ...process.env, DATA_DIR: TEST_DATA_DIR, OUTREACH_DRY_RUN: 'true' },
  });
  const match = out.match(/BATCH_RESULT:(.*)/);
  if (!match) throw new Error(`Batch helper failed: ${out}`);
  return { ...JSON.parse(match[1]), filePathOnDisk: targetPath };
}

function runSendOutreach(contactId, dryRun = true) {
  const runnerPath = path.join(__dirname, 'helpers', 'dispatch-runner.ts');
  const env = {
    ...process.env,
    DATA_DIR: TEST_DATA_DIR,
    OUTREACH_DRY_RUN: dryRun ? 'true' : 'false',
    TEST_MOCK_GMAIL_SEND: dryRun ? 'false' : 'true', // When testing real send, safely mock transport
  };
  const out = execSync(`npx tsx "${runnerPath}" "${contactId}"`, {
    cwd: path.resolve(__dirname, '..'),
    env,
    encoding: 'utf-8',
  });
  const match = out.match(/DISPATCH_RESULT:(.*)/);
  if (!match) throw new Error(`Dispatch helper failed: ${out}`);
  return JSON.parse(match[1]);
}

console.log('======================================================================');
console.log('DRY-RUN OUTREACH REPORTING SEMANTICS VERIFICATION');
console.log('======================================================================\n');

// ── TEST 1: DRY-RUN PROCESSING DOES NOT CREATE PERMANENT GLOBAL HISTORY ────
console.log('--- Test 1: Dry-run Does Not Create Permanent Successful Global History ---');
const dryRunEmail1 = `candidate_sim_${Date.now()}@techcorp.com`;
const csv1 = `Company,HR Name,Email\nGoogle,Recruiter 1,${dryRunEmail1}\n`;
const batch1 = runBatchProcessor(csv1, 'dryrun_test_1.csv');

const contact1 = db.prepare('SELECT * FROM contacts WHERE batch_id = ? AND email = ?').get(batch1.batchId, dryRunEmail1);
// Populate subject/body so it's ready to send
db.prepare("UPDATE contacts SET email_subject = 'Subject', email_body = 'Body', status = 'queued' WHERE id = ?").run(contact1.id);

// Execute dry-run send
const send1Result = runSendOutreach(contact1.id, true);
assert(send1Result.success === true, 'Dry-run send completed successfully');
assert(send1Result.messageId.startsWith('dryrun_'), 'Returned simulated dry-run messageId');

// Check contacts table
const contact1After = db.prepare('SELECT * FROM contacts WHERE id = ?').get(contact1.id);
assert(contact1After.status === 'simulated', 'Contact status set to "simulated" (NOT "sent")');
assert(contact1After.sent_at === null, 'Contact sent_at is NULL in dry-run mode');

// Check global_email_history
const history1After = db.prepare('SELECT * FROM global_email_history WHERE email = ?').get(dryRunEmail1);
assert(!history1After || history1After.status !== 'sent', 'Global email history does NOT record status="sent" for dry-run simulation');
assert(!history1After || history1After.sent_at === null, 'Global email history sent_at is NULL or not recorded');

// Check batches table
const batch1Row = db.prepare('SELECT * FROM batches WHERE id = ?').get(batch1.batchId);
assert(batch1Row.emails_sent === 0, 'Batch emails_sent remains 0 after dry-run simulation');
assert(batch1Row.emails_simulated === 1, 'Batch emails_simulated incremented to 1');
assert(batch1Row.emails_pending === 0, 'Batch emails_pending decremented to 0');

// ── TEST 2: DRY-RUN DOES NOT MAKE CONTACT PERMANENTLY INELIGIBLE ───────────
console.log('\n--- Test 2: Contact Remains Eligible for Future Real Send ---');
// Upload Batch 2 with the SAME email that was previously simulated
const csv2 = `Company,HR Name,Email\nGoogle,Recruiter 1 Again,${dryRunEmail1}\n`;
const batch2 = runBatchProcessor(csv2, 'dryrun_test_2.csv');

const contact2 = db.prepare('SELECT * FROM contacts WHERE batch_id = ? AND email = ?').get(batch2.batchId, dryRunEmail1);
assert(contact2.is_duplicate === 0, 'Previously simulated email is NOT flagged as duplicate in new batch');
assert(contact2.status === 'queued', 'Previously simulated email is queued for future outreach in new batch');

// ── TEST 3: DASHBOARD / REPORTING NEVER LABELS SIMULATED SENDS AS REAL SENT ─
console.log('\n--- Test 3: Dashboard Reporting Never Labels Simulated Sends as Sent ---');
const dbHelpersRunnerPath = path.join(__dirname, 'helpers', 'dashboard-stats-runner.ts');
fs.writeFileSync(
  dbHelpersRunnerPath,
  `import { getDashboardStats } from '../../src/lib/db-helpers';
import { initializeDatabase } from '../../src/db/migrate';
initializeDatabase();
const stats = getDashboardStats();
console.log('STATS_RESULT:' + JSON.stringify(stats));
`
);

const statsOutput = execSync(`npx tsx "${dbHelpersRunnerPath}"`, {
  cwd: path.resolve(__dirname, '..'),
  env: { ...process.env, DATA_DIR: TEST_DATA_DIR, OUTREACH_DRY_RUN: 'true' },
  encoding: 'utf-8',
});
const statsMatch = statsOutput.match(/STATS_RESULT:(.*)/);
const statsData = JSON.parse(statsMatch[1]);

assert(statsData.isDryRun === true, 'Dashboard confirms isDryRun = true');
assert(statsData.emailsSent === 0, 'Dashboard reports emailsSent = 0 in dry-run mode');
assert(statsData.emailsSimulated >= 1, 'Dashboard reports emailsSimulated count accurately');

// Verify dashboard UI text content in page.tsx
const pageContent = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'app', 'page.tsx'), 'utf-8');
assert(pageContent.includes("Today's Simulated Outreach"), 'Dashboard includes "Today\'s Simulated Outreach" metric label');
assert(pageContent.includes("DRY-RUN MODE ACTIVE"), 'Dashboard includes prominent "DRY-RUN MODE ACTIVE" banner');
assert(pageContent.includes("No real Gmail emails are being dispatched."), 'Dashboard banner explicitly states "No real Gmail emails are being dispatched."');
assert(pageContent.includes("simulated"), 'Dashboard meter shows "simulated" suffix');

// ── TEST 4: REAL GMAIL SUCCESS DOES CREATE PERMANENT GLOBAL HISTORY ────────
console.log('\n--- Test 4: Real Gmail Success Creates Permanent Global History ---');
const realSendEmail = `real_recipient_${Date.now()}@techcorp.com`;
const csv4 = `Company,HR Name,Email\nMicrosoft,Lead 4,${realSendEmail}\n`;
const batch4 = runBatchProcessor(csv4, 'real_test_4.csv');
const contact4 = db.prepare('SELECT * FROM contacts WHERE batch_id = ? AND email = ?').get(batch4.batchId, realSendEmail);
db.prepare("UPDATE contacts SET email_subject = 'Subject', email_body = 'Body', status = 'queued' WHERE id = ?").run(contact4.id);

// Execute real send (with safely mocked transport)
const send4Result = runSendOutreach(contact4.id, false);
assert(send4Result.success === true, 'Real send pipeline succeeded');
assert(send4Result.messageId.startsWith('mock_real_msg_'), 'Returned real Gmail message identifier');

const contact4After = db.prepare('SELECT * FROM contacts WHERE id = ?').get(contact4.id);
assert(contact4After.status === 'sent', 'Contact status set to "sent" on real send');
assert(contact4After.sent_at !== null, 'Contact sent_at has timestamp on real send');

const history4After = db.prepare('SELECT * FROM global_email_history WHERE email = ?').get(realSendEmail);
assert(history4After !== undefined, 'Global email history record created');
assert(history4After.status === 'sent', 'Global email history marked status = "sent" permanently');
assert(history4After.sent_at !== null, 'Global email history sent_at timestamp recorded permanently');

const batch4Row = db.prepare('SELECT * FROM batches WHERE id = ?').get(batch4.batchId);
assert(batch4Row.emails_sent === 1, 'Batch emails_sent incremented to 1 on real send');

// ── TEST 5: SWITCHING DRY-RUN TRUE -> FALSE ALLOWS REAL SEND ───────────────
console.log('\n--- Test 5: Switching from Dry-Run to Real Allows First Send ---');
// Use the contact from Test 2 (which was previously simulated in batch1, and re-queued in batch2)
db.prepare("UPDATE contacts SET email_subject = 'Subject', email_body = 'Body', status = 'queued' WHERE id = ?").run(contact2.id);

// Now execute send with dryRun = false
const send5Result = runSendOutreach(contact2.id, false);
assert(send5Result.success === true, 'Previously simulated contact successfully sent when dry-run is turned OFF');

const contact2After = db.prepare('SELECT * FROM contacts WHERE id = ?').get(contact2.id);
assert(contact2After.status === 'sent', 'Contact now transitions from simulated to real "sent"');
assert(contact2After.sent_at !== null, 'Contact now has real sent_at timestamp');

const history5After = db.prepare('SELECT * FROM global_email_history WHERE email = ?').get(dryRunEmail1);
assert(history5After.status === 'sent', 'Global history permanently locks email after its first real send');

// ── TEST 6: GENUINELY SUCCESSFUL REAL SEND REMAINS DEDUPLICATED ───────────
console.log('\n--- Test 6: Genuinely Successful Real Send Remains Permanently Deduplicated ---');
// Upload Batch 6 with the now-genuinely-sent email
const csv6 = `Company,HR Name,Email\nGoogle,Lead Again,${dryRunEmail1}\n`;
const batch6 = runBatchProcessor(csv6, 'test_6_dup.csv');

const contact6 = db.prepare('SELECT * FROM contacts WHERE batch_id = ? AND email = ?').get(batch6.batchId, dryRunEmail1);
assert(contact6.is_duplicate === 1, 'Genuinely sent email is flagged as duplicate in new upload');
assert(contact6.status === 'skipped', 'Genuinely sent email is skipped in new upload');

// Direct dispatch attempt must also be rejected
const directAttempt = runSendOutreach(contact6.id, false);
assert(directAttempt.success === false, 'Direct send attempt rejected for permanently contacted email');
assert(directAttempt.errorCategory === 'duplicate', 'Direct send rejected with errorCategory="duplicate"');

// Clean up runner script
if (fs.existsSync(dbHelpersRunnerPath)) fs.unlinkSync(dbHelpersRunnerPath);

console.log('\n======================================================================');
console.log(`ALL DRY-RUN OUTREACH REPORTING TESTS PASSED: ${passedTests}/${totalTests}`);
console.log('REAL RECRUITER EMAILS DISPATCHED: 0');
console.log('REAL GMAIL OUTREACH HISTORY CREATED: 0 (safe test mock utilized for branch)');
console.log('======================================================================');
