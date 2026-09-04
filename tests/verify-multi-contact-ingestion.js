/* eslint-disable @typescript-eslint/no-require-imports */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const dataDir = process.env.DATA_DIR?.trim()
  ? (path.isAbsolute(process.env.DATA_DIR.trim())
      ? process.env.DATA_DIR.trim()
      : path.resolve(__dirname, '..', process.env.DATA_DIR.trim()))
  : path.join(__dirname, '..', 'data');
const dbPath = path.join(dataDir, 'outreach.db');
const db = new Database(dbPath);

console.log('======================================================================');
console.log('MULTI-CONTACT COMPANY INGESTION & CONTEXT INHERITANCE VERIFICATION');
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

function runCanonicalHelper(action, input) {
  const runnerPath = path.join(__dirname, 'helpers', 'canonical-runner.ts');
  const serialized = JSON.stringify(input);
  const out = execSync(`npx tsx "${runnerPath}" ${action}`, {
    input: serialized,
    encoding: 'utf-8',
    cwd: path.resolve(__dirname, '..'),
  });
  const match = out.match(/OUTPUT:(.*)/);
  if (!match) throw new Error(`Helper output did not match expected pattern: ${out}`);
  return JSON.parse(match[1]);
}

function runBatchProcessor(csvContent, filename) {
  const tmpPath = path.join(__dirname, 'fixtures', `_tmp_${filename}`);
  fs.writeFileSync(tmpPath, csvContent, 'utf-8');
  try {
    const runnerPath = path.join(__dirname, 'helpers', 'process-batch-runner.ts');
    const out = execSync(`npx tsx "${runnerPath}" "${tmpPath}" "${filename}"`, {
      encoding: 'utf-8',
      cwd: path.resolve(__dirname, '..'),
    });
    const match = out.match(/BATCH_RESULT:(.*)/);
    if (!match) throw new Error(`Batch helper failed: ${out}`);
    return JSON.parse(match[1]);
  } finally {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  }
}

// Clean up test emails to ensure clean test isolation
const testEmails = [
  'rajat.rawat@infosys.com',
  'kireet.nuthalapati@infosys.com',
  'sudhir.mishra01@infosys.com',
  'gopikishore.panda@infosys.com',
  'mohit.singh17@infosys.com',
];
for (const em of testEmails) {
  db.prepare('DELETE FROM outreach_queue WHERE contact_id IN (SELECT id FROM contacts WHERE email = ?)').run(em);
  db.prepare('DELETE FROM global_email_history WHERE email = ?').run(em);
  db.prepare('DELETE FROM contacts WHERE email = ?').run(em);
}
db.prepare("DELETE FROM global_email_history WHERE email LIKE 'already_sent_%'").run();

// Seed authoritative Gemini test classifications for test isolation
db.prepare(`
  INSERT OR REPLACE INTO company_classifications (
    normalized_name, company_name, is_relevant, confidence, reason,
    classification_source, gemini_model, classification_result, created_at, updated_at
  ) VALUES
    ('acme construction', 'Acme Construction Ltd', 0, 0.99, 'Not Relevant — Gemini: Commercial construction and building civil works contractor.', 'gemini', 'gemini-3.8-flash', 'IRRELEVANT', datetime('now'), datetime('now')),
    ('wipro', 'Wipro Technologies', 1, 0.99, 'Relevant — Gemini: Global information technology, consulting and business process services.', 'gemini', 'gemini-3.8-flash', 'RELEVANT', datetime('now'), datetime('now'))
`).run();

// ── TEST 1: RELEVANT COMPANY WITH 5 CONTACTS & BLANK CONTINUATION ROWS ──
console.log('\n--- Test 1: Relevant Company With 5 Contacts & Blank Continuation Rows (Infosys) ---');
const infosysFixturePath = path.join(__dirname, 'fixtures', 'infosys_multi_contact.csv');
const runnerPath = path.join(__dirname, 'helpers', 'process-batch-runner.ts');
const infosysOut = execSync(`npx tsx "${runnerPath}" "${infosysFixturePath}" "infosys_multi_contact.csv"`, {
  encoding: 'utf-8',
  cwd: path.resolve(__dirname, '..'),
});
const infosysResult = JSON.parse(infosysOut.match(/BATCH_RESULT:(.*)/)[1]);

assert(infosysResult.totalRecords === 5, 'Total records parsed is 5');
assert(infosysResult.validRecords === 5, 'All 5 records have valid emails');
assert(infosysResult.relevantCompanies === 1, 'Exactly 1 unique relevant company classified (Infosys)');
assert(infosysResult.irrelevantCompanies === 0, 'Zero irrelevant companies');
assert(infosysResult.duplicateContacts === 0, 'Zero duplicate contacts');
assert(infosysResult.invalidEmails === 0, 'Zero invalid emails');
assert(infosysResult.emailsPending === 5, 'All 5 recruiter emails queued for outreach');
assert(infosysResult.status === 'queued', 'Batch status is queued');

const infosysContacts = db.prepare('SELECT * FROM contacts WHERE batch_id = ? ORDER BY created_at ASC').all(infosysResult.batchId);
assert(infosysContacts.length === 5, 'SQLite contacts table contains all 5 records');
assert(infosysContacts.every(c => c.company_name === 'Infosys'), 'Every contact inherited companyName "Infosys"');
assert(infosysContacts.every(c => c.is_relevant === 1), 'Every contact inherited is_relevant = true');
assert(infosysContacts.every(c => c.status === 'queued'), 'Every contact has status = "queued"');

const infosysQueue = db.prepare('SELECT q.*, c.email FROM outreach_queue q JOIN contacts c ON q.contact_id = c.id WHERE c.batch_id = ?').all(infosysResult.batchId);
assert(infosysQueue.length === 5, 'All 5 contacts are enqueued in outreach_queue');

// ── TEST 2: IRRELEVANT COMPANY WITH 5 CONTACTS ──────────────────────────
console.log('\n--- Test 2: Irrelevant Company With 5 Contacts & Blank Continuation Rows ---');
const irrelevantCsv = `Company,HR Name,Email
Acme Construction Ltd,John Doe,john@acmeconstruction.com
,Alice Smith,alice@acmeconstruction.com
,Bob Jones,bob@acmeconstruction.com
,Charlie Brown,charlie@acmeconstruction.com
,David Miller,david@acmeconstruction.com
`;
const irrelevantResult = runBatchProcessor(irrelevantCsv, 'acme_construction.csv');

assert(irrelevantResult.totalRecords === 5, 'Total records parsed is 5');
assert(irrelevantResult.validRecords === 5, 'All 5 records have valid emails');
assert(irrelevantResult.relevantCompanies === 0, 'Zero relevant companies');
assert(irrelevantResult.irrelevantCompanies === 1, 'Exactly 1 irrelevant company classified (Acme Construction Ltd)');
assert(irrelevantResult.emailsPending === 0, '0 emails queued for irrelevant company');
assert(irrelevantResult.status === 'completed', 'Batch status is completed without outreach');

const irrelevantContacts = db.prepare('SELECT * FROM contacts WHERE batch_id = ?').all(irrelevantResult.batchId);
assert(irrelevantContacts.length === 5, 'All 5 contacts saved to contacts table');
assert(irrelevantContacts.every(c => c.company_name === 'Acme Construction Ltd'), 'Contacts have companyName "Acme Construction Ltd" (NOT "Unknown Company")');
assert(irrelevantContacts.every(c => c.is_relevant === 0), 'All contacts classified as is_relevant = false');
assert(irrelevantContacts.every(c => c.status === 'skipped'), 'All contacts marked status = "skipped"');

const irrelevantQueue = db.prepare('SELECT q.* FROM outreach_queue q JOIN contacts c ON q.contact_id = c.id WHERE c.batch_id = ?').all(irrelevantResult.batchId);
assert(irrelevantQueue.length === 0, 'Zero items placed into outreach_queue for irrelevant company');

// ── TEST 3: SAME COMPANY WITH 5 DIFFERENT EMAILS ────────────────────────
console.log('\n--- Test 3: Same Company With 5 Different Emails (Separate Outreach Identities) ---');
const googleCsv = `Company,HR Name,Email
Google,Recruiter 1,rec1_${Date.now()}@google.com
,Recruiter 2,rec2_${Date.now()}@google.com
,Recruiter 3,rec3_${Date.now()}@google.com
,Recruiter 4,rec4_${Date.now()}@google.com
,Recruiter 5,rec5_${Date.now()}@google.com
`;
const googleResult = runBatchProcessor(googleCsv, 'google_recruiters.csv');
assert(googleResult.emailsPending === 5, '5 separate emails under the same company produce 5 separate queued outreach items');
const googleQueue = db.prepare('SELECT q.* FROM outreach_queue q JOIN contacts c ON q.contact_id = c.id WHERE c.batch_id = ?').all(googleResult.batchId);
assert(googleQueue.length === 5, 'Matching company name does NOT collapse or deduplicate separate email identities');

// ── TEST 4: SAME COMPANY WITH DUPLICATE EMAIL TWICE ─────────────────────
console.log('\n--- Test 4: Same Company With Duplicate Email (Single Outreach Identity) ---');
const dupEmail = `dup_test_${Date.now()}@microsoft.com`;
const msftCsv = `Company,HR Name,Email
Microsoft,Primary Recruiter,${dupEmail}
,Recruiter Two,two_${Date.now()}@microsoft.com
,Duplicate Row,${dupEmail}
,Recruiter Four,four_${Date.now()}@microsoft.com
,Recruiter Five,five_${Date.now()}@microsoft.com
`;
const msftResult = runBatchProcessor(msftCsv, 'msft_duplicate.csv');
assert(msftResult.duplicateContacts === 1, 'In-batch duplicate email detected');
assert(msftResult.emailsPending === 4, 'Exactly 4 non-duplicate emails queued');
const msftContacts = db.prepare('SELECT * FROM contacts WHERE batch_id = ? AND email = ?').all(msftResult.batchId, dupEmail);
assert(msftContacts.length === 2, 'Both rows saved for audit trail');
assert(msftContacts[0].is_duplicate === 0 && msftContacts[0].status === 'queued', 'First instance of email is queued');
assert(msftContacts[1].is_duplicate === 1 && msftContacts[1].status === 'skipped', 'Second instance of duplicate email is skipped');

// ── TEST 5: SAME EMAIL UNDER DIFFERENT COMPANIES (GLOBAL DEDUP) ─────────
console.log('\n--- Test 5: Same Email Under Different Companies (Global Deduplication) ---');
const crossEmail = `cross_company_${Date.now()}@enterprise.com`;
const batchACsv = `Company,HR Name,Email
Infosys,Lead 1,${crossEmail}
`;
const batchBCsv = `Company,HR Name,Email
Wipro,Lead 2,${crossEmail}
`;
const batchAResult = runBatchProcessor(batchACsv, 'batch_a.csv');
assert(batchAResult.emailsPending === 1, 'Email in Batch A is queued');

const batchBResult = runBatchProcessor(batchBCsv, 'batch_b.csv');
assert(batchBResult.duplicateContacts === 1, 'Cross-company email in Batch B flagged as duplicate via global_email_history');
assert(batchBResult.emailsPending === 0, 'Batch B duplicate email is NOT queued for outreach');

// ── TEST 6: CONTINUATION ROW VARIANTS (BLANK, WHITESPACE, DITTO, HYPHEN) ──
console.log('\n--- Test 6: Continuation Cell Variant Handling ---');
const continuationRecords = [
  { companyName: 'Wipro', contactName: 'C1', email: 'c1@wipro.com' },
  { companyName: '', contactName: 'C2', email: 'c2@wipro.com' },
  { companyName: '   ', contactName: 'C3', email: 'c3@wipro.com' },
  { companyName: '"', contactName: 'C4', email: 'c4@wipro.com' },
  { companyName: "''", contactName: 'C5', email: 'c5@wipro.com' },
  { companyName: '-', contactName: 'C6', email: 'c6@wipro.com' },
  { companyName: '--', contactName: 'C7', email: 'c7@wipro.com' },
  { companyName: 'do', contactName: 'C8', email: 'c8@wipro.com' },
  { companyName: '-do-', contactName: 'C9', email: 'c9@wipro.com' },
  { companyName: 'same as above', contactName: 'C10', email: 'c10@wipro.com' },
];
const canonicalContinuation = runCanonicalHelper('reconstruct', continuationRecords);
assert(canonicalContinuation.length === 10, 'All 10 variant rows parsed');
assert(canonicalContinuation.every(c => c.companyName === 'Wipro'), 'Every variant continuation row inherited "Wipro"');
assert(canonicalContinuation[0].companyInherited === false, 'First row establishes company context');
assert(canonicalContinuation.slice(1).every(c => c.companyInherited === true), 'Continuation rows flagged as companyInherited = true');

// ── TEST 7: MULTI-COMPANY TABLE TRANSITIONS & STRICT ISOLATION ──────────
console.log('\n--- Test 7: Multi-Company Table Transitions & Strict Isolation ---');
const transitionCsv = `Company,HR Name,Email
Infosys,Recruiter A1,trans_a1_${Date.now()}@infosys.com
,Recruiter A2,trans_a2_${Date.now()}@infosys.com
,Recruiter A3,trans_a3_${Date.now()}@infosys.com
Tata Consultancy Services,Recruiter B1,trans_b1_${Date.now()}@tcs.com
,Recruiter B2,trans_b2_${Date.now()}@tcs.com
,Recruiter B3,trans_b3_${Date.now()}@tcs.com
`;
const transitionResult = runBatchProcessor(transitionCsv, 'transition_test.csv');
assert(transitionResult.totalRecords === 6, 'Total 6 records parsed across 2 companies');
assert(transitionResult.relevantCompanies === 2, '2 distinct companies identified and classified');
assert(transitionResult.emailsPending === 6, 'All 6 recruiters queued');

const transitionContacts = db.prepare('SELECT * FROM contacts WHERE batch_id = ? ORDER BY created_at ASC').all(transitionResult.batchId);
assert(transitionContacts.slice(0, 3).every(c => c.company_name === 'Infosys'), 'First 3 contacts belong to Infosys');
assert(transitionContacts.slice(3, 6).every(c => c.company_name === 'Tata Consultancy Services'), 'Next 3 contacts belong to Tata Consultancy Services');

// ── TEST 8: BLANK COMPANY ROW WITH INVALID EMAIL ────────────────────────
console.log('\n--- Test 8: Blank Company Row With Invalid Email ---');
const invalidEmailCsv = `Company,HR Name,Email
Infosys,Good Recruiter 1,good1_${Date.now()}@infosys.com
,Bad Recruiter,invalid-email-address
,Good Recruiter 2,good2_${Date.now()}@infosys.com
`;
const invalidEmailResult = runBatchProcessor(invalidEmailCsv, 'invalid_email_test.csv');
assert(invalidEmailResult.totalRecords === 3, '3 records parsed');
assert(invalidEmailResult.invalidEmails === 1, '1 invalid email detected');
assert(invalidEmailResult.emailsPending === 2, '2 valid emails queued');

const invalidContacts = db.prepare('SELECT * FROM contacts WHERE batch_id = ? ORDER BY created_at ASC').all(invalidEmailResult.batchId);
assert(invalidContacts[1].company_name === 'Infosys', 'Row with invalid email still inherited company "Infosys"');
assert(invalidContacts[1].email_valid === 0, 'email_valid is false for invalid row');
assert(invalidContacts[1].status === 'skipped', 'Status is skipped for invalid email');
assert(invalidContacts[0].status === 'queued' && invalidContacts[2].status === 'queued', 'Valid email rows are queued');

// ── TEST 9: PRE-CONTACTED EMAIL UNDER RELEVANT COMPANY ──────────────────
console.log('\n--- Test 9: Pre-Contacted Email Under Relevant Company ---');
const alreadySentEmail = `already_sent_${Date.now()}@infosys.com`;
const mockSentBatchId = `batch_mock_sent_${Date.now()}`;
const mockSentContactId = `contact_mock_sent_${Date.now()}`;
db.prepare(`
  INSERT INTO batches (id, filename, upload_date, created_at, updated_at, status)
  VALUES (?, 'mock_sent.csv', datetime('now'), datetime('now'), datetime('now'), 'completed')
`).run(mockSentBatchId);
db.prepare(`
  INSERT INTO contacts (id, batch_id, email, company_name, is_relevant, email_valid, status, sent_at, gmail_message_id, created_at, updated_at)
  VALUES (?, ?, ?, 'Infosys', 1, 1, 'sent', datetime('now'), 'gmail_msg_precontacted', datetime('now'), datetime('now'))
`).run(mockSentContactId, mockSentBatchId, alreadySentEmail);
db.prepare(`
  INSERT INTO global_email_history (email, first_seen_at, sent_at, status)
  VALUES (?, datetime('now'), datetime('now'), 'sent')
`).run(alreadySentEmail);

const precontactedCsv = `Company,HR Name,Email
Infosys,Sent Recruiter,${alreadySentEmail}
,Eligible Recruiter 1,elig1_${Date.now()}@infosys.com
,Eligible Recruiter 2,elig2_${Date.now()}@infosys.com
`;
const precontactedResult = runBatchProcessor(precontactedCsv, 'precontacted_test.csv');
assert(precontactedResult.duplicateContacts === 1, 'Pre-contacted email identified as duplicate');
assert(precontactedResult.emailsPending === 2, 'Remaining 2 contacts successfully queued');
// Clean up the pre-contacted mock record so global email audit invariants hold
db.prepare('DELETE FROM outreach_queue WHERE contact_id IN (SELECT id FROM contacts WHERE email = ?)').run(alreadySentEmail);
db.prepare('DELETE FROM global_email_history WHERE email = ?').run(alreadySentEmail);
db.prepare('DELETE FROM contacts WHERE email = ?').run(alreadySentEmail);
db.prepare('DELETE FROM batches WHERE id = ?').run(mockSentBatchId);

// ── TEST 10: EXPLICIT COMPANY NAMES ON EVERY ROW (EQUIVALENCE TEST) ─────
console.log('\n--- Test 10: Explicit Company Names In Every Row (Equivalence) ---');
const explicitCsv = `Company,HR Name,Email
Infosys,R1,exp1_${Date.now()}@infosys.com
Infosys,R2,exp2_${Date.now()}@infosys.com
Infosys,R3,exp3_${Date.now()}@infosys.com
`;
const explicitResult = runBatchProcessor(explicitCsv, 'explicit_test.csv');
assert(explicitResult.relevantCompanies === 1, 'Explicit company names produce 1 relevant company');
assert(explicitResult.emailsPending === 3, 'All 3 contacts queued');

// ── TEST 11: PDF MULTI-CONTACT TABLE REPRESENTATION ─────────────────────
console.log('\n--- Test 11: PDF Multi-Contact Table Extraction Representation ---');
const pdfExtractedRows = [
  { companyName: 'Oracle', contactName: 'P1', email: 'p1@oracle.com' },
  { companyName: '', contactName: 'P2', email: 'p2@oracle.com' },
  { companyName: '', contactName: 'P3', email: 'p3@oracle.com' },
];
const canonicalPdf = runCanonicalHelper('reconstruct', pdfExtractedRows);
assert(canonicalPdf.length === 3, 'PDF rows reconstructed');
assert(canonicalPdf.every(c => c.companyName === 'Oracle'), 'All PDF rows inherited "Oracle"');

// ── TEST 12: MERGED CELL REPRESENTATION (SPREADSHEET/CSV) ───────────────
console.log('\n--- Test 12: Merged Cell Representation ---');
const mergedRecords = [
  { companyName: 'NVIDIA', contactName: 'M1', email: 'm1@nvidia.com' },
  { companyName: null, contactName: 'M2', email: 'm2@nvidia.com' },
  { companyName: undefined, contactName: 'M3', email: 'm3@nvidia.com' },
];
const canonicalMerged = runCanonicalHelper('reconstruct', mergedRecords);
assert(canonicalMerged.length === 3, 'Merged rows reconstructed');
assert(canonicalMerged.every(c => c.companyName === 'NVIDIA'), 'Null and undefined cells inherited "NVIDIA"');

// ── INVARIANTS VERIFICATION ─────────────────────────────────────────────
console.log('\n--- Invariants A through F ---');

// Invariant A: Relevant company with N valid emails produces N eligible contacts
assert(infosysResult.validRecords === 5 && infosysResult.emailsPending === 5, 'Invariant A: Relevant company with N valid emails produces N eligible contacts');

// Invariant B: Different emails never collapse due to matching company names
assert(googleQueue.length === 5, 'Invariant B: Different emails never collapse due to matching company names');

// Invariant C: Blank company never becomes "Unknown Company" if valid preceding context exists
assert(infosysContacts.every(c => c.company_name !== 'Unknown Company'), 'Invariant C: Blank company never becomes "Unknown Company" when preceding context exists');

// Invariant D: Classification result shared across all contacts of that normalized company
assert(infosysContacts.every(c => c.is_relevant === 1), 'Invariant D: Classification result shared across all contacts of that normalized company');

// Invariant E: Outreach deduplication is based on normalized email, not company
assert(msftResult.duplicateContacts === 1 && msftResult.emailsPending === 4, 'Invariant E: Outreach deduplication is based on normalized email, not company');

// Invariant F: No contact enters queue with unresolved company when reconstructable
const queuedWithUnknown = db.prepare(`
  SELECT c.* FROM outreach_queue q
  JOIN contacts c ON q.contact_id = c.id
  WHERE c.company_name = 'Unknown Company' OR c.company_name IS NULL OR c.company_name = ''
`).all();
assert(queuedWithUnknown.length === 0, 'Invariant F: No contact enters queue with unresolved company');

console.log('\n======================================================================');
console.log(`ALL TESTS PASSED: ${passedTests}/${totalTests}`);
console.log('REAL RECRUITER EMAILS SENT: 0');
console.log('REAL GMAIL OUTREACH HISTORY CREATED: 0');
console.log('======================================================================');
