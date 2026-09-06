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
console.log('GEMINI-AUTHORITATIVE RELEVANCE CLASSIFICATION ARCHITECTURE VERIFICATION');
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

function runClassifierHelper(action, input) {
  const runnerPath = path.join(__dirname, 'helpers', 'classifier-runner.ts');
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

runClassifierHelper('init', {});

// Clean DB cache for test companies to ensure test isolation
db.prepare('DELETE FROM company_classifications').run();

// ── 1. HCL, Infosys, TCS, Microsoft/Google Classified by Gemini ────────
console.log('\n--- Test 1: HCL, Infosys, TCS, Microsoft, Google Classified by Gemini ---');
const techBatchMock = [
  { company: 'HCL Technologies Ltd', relevant: true, confidence: 0.98, reason: 'Global IT and engineering enterprise.' },
  { company: 'Infosys', relevant: true, confidence: 0.99, reason: 'Leading digital IT consulting services provider.' },
  { company: 'Tata Consultancy Services', relevant: true, confidence: 0.99, reason: 'Multinational IT solutions firm.' },
  { company: 'Microsoft', relevant: true, confidence: 1.0, reason: 'Global cloud and enterprise software developer.' },
  { company: 'Google', relevant: true, confidence: 1.0, reason: 'AI, cloud, and distributed software systems leader.' },
];

const res1 = runClassifierHelper('classify', {
  companies: [
    { companyName: 'HCL Technologies Ltd', normalizedName: 'hcl' },
    { companyName: 'Infosys', normalizedName: 'infosys' },
    { companyName: 'Tata Consultancy Services', normalizedName: 'tata consultancy' },
    { companyName: 'Microsoft', normalizedName: 'microsoft' },
    { companyName: 'Google', normalizedName: 'google' },
  ],
  geminiMockResponse: techBatchMock,
});

assert(res1['hcl'].relevant === true, 'HCL is classified as relevant = true');
assert(res1['hcl'].source === 'gemini', 'HCL classification source is gemini');
assert(res1['hcl'].geminiModel === 'gemini-3.8-flash', 'Model is gemini-3.8-flash');
assert(res1['hcl'].reason.startsWith('Relevant — Gemini'), 'Reason starts with Relevant — Gemini');

assert(res1['infosys'].source === 'gemini', 'Infosys source is gemini');
assert(res1['tata consultancy'].source === 'gemini', 'TCS source is gemini');
assert(res1['microsoft'].source === 'gemini', 'Microsoft source is gemini');
assert(res1['google'].source === 'gemini', 'Google source is gemini');

// ── 2. Non-Technology Companies Classified by Gemini ───────────────────
console.log('\n--- Test 2: Non-Technology Companies Classified by Gemini ---');
const nonTechMock = [
  { company: 'Sunset Bakery Co', relevant: false, confidence: 0.95, reason: 'Commercial bakery and retail pastry.' },
  { company: 'Apex Plumbing Supplies', relevant: false, confidence: 0.94, reason: 'Residential plumbing supplier.' },
];

const res2 = runClassifierHelper('classify', {
  companies: [
    { companyName: 'Sunset Bakery Co', normalizedName: 'sunset bakery' },
    { companyName: 'Apex Plumbing Supplies', normalizedName: 'apex plumbing supplies' },
  ],
  geminiMockResponse: nonTechMock,
});

assert(res2['sunset bakery'].relevant === false, 'Sunset Bakery classified as relevant = false');
assert(res2['sunset bakery'].status === 'IRRELEVANT', 'Sunset Bakery status is IRRELEVANT');
assert(res2['sunset bakery'].source === 'gemini', 'Sunset Bakery source is gemini');
assert(res2['sunset bakery'].reason.startsWith('Not Relevant — Gemini'), 'Reason starts with Not Relevant — Gemini');

// ── 3. No Keyword Heuristics Assign Relevance Automatically ───────────
console.log('\n--- Test 3: Tech/Software/Cloud Keywords Do NOT Automatically Assign Relevance ---');
// A company containing "Cloud" or "Tech" that Gemini deems irrelevant (e.g. Cloud Cleaners, Tech Hardware Scraps)
const keywordCompanyMock = [
  { company: 'Cloud Laundromat LLC', relevant: false, confidence: 0.92, reason: 'Laundromat service that uses cloud billing.' },
  { company: 'Tech Hardware Scraps', relevant: false, confidence: 0.91, reason: 'Physical e-waste metal recovery without software jobs.' },
];

const res3 = runClassifierHelper('classify', {
  companies: [
    { companyName: 'Cloud Laundromat LLC', normalizedName: 'cloud laundromat' },
    { companyName: 'Tech Hardware Scraps', normalizedName: 'tech hardware scraps' },
  ],
  geminiMockResponse: keywordCompanyMock,
});

assert(res3['cloud laundromat'].relevant === false, 'Cloud Laundromat is NOT marked relevant merely because of keyword "cloud"');
assert(res3['cloud laundromat'].status === 'IRRELEVANT', 'Cloud Laundromat status is IRRELEVANT');
assert(res3['tech hardware scraps'].relevant === false, 'Tech Hardware Scraps is NOT marked relevant merely because of keyword "tech"');
assert(res3['tech hardware scraps'].status === 'IRRELEVANT', 'Tech Hardware Scraps status is IRRELEVANT');

// ── 4. Transient Gemini 503 / 429 / Timeout / 500-504 -> RETRY_WAITING ──────
console.log('\n--- Test 4: Transient Failures Produce RETRY_WAITING for Round Drain ---');

const transientErrors = [
  { name: '503 Service Unavailable', err: '503 Service Unavailable - upstream connection failed' },
  { name: '429 Rate Limit', err: '429 RESOURCE_EXHAUSTED: Quota exceeded for model' },
  { name: 'Request Timeout', err: 'Gemini request timed out after 15000ms' },
  { name: '502 Bad Gateway', err: '502 BAD_GATEWAY: Google backend returned invalid response' },
  { name: '504 Gateway Timeout', err: '504 GATEWAY_TIMEOUT: Timed out waiting for response' },
  { name: '500 Internal Error', err: '500 INTERNAL: Internal server error occurred' },
];

for (const te of transientErrors) {
  const normName = `pending-test-${te.name.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;
  const res = runClassifierHelper('classify', {
    companies: [{ companyName: `Test ${te.name}`, normalizedName: normName }],
    geminiThrows: te.err,
  });

  const record = res[normName];
  assert(record.status === 'RETRY_WAITING', `${te.name} resulted in status RETRY_WAITING`);
  assert(record.relevant === null, `${te.name} relevance is null (not guessed)`);
  assert(record.retryCount === 1, `${te.name} retryCount is 1`);

  // Verify SQLite persistence
  const row = db.prepare('SELECT * FROM company_classifications WHERE normalized_name = ?').get(normName);
  assert(row !== undefined, `${te.name} record exists in SQLite`);
  assert(row.classification_result === 'RETRY_WAITING', `${te.name} classification_result is RETRY_WAITING in SQLite`);
  assert(row.gemini_model === 'gemini-3.8-flash', `${te.name} model is gemini-3.8-flash in SQLite`);
}

// ── 5. Permanent Configuration Errors Are Surfaced, Not Retried Indefinitely ─
console.log('\n--- Test 5: Permanent Errors (400, 401, 403, 404) Are Surfaced Accurately ---');

const permanentErrors = [
  { code: 'AUTH_REJECTED', err: '401 API_KEY_INVALID: API key not valid' },
  { code: 'PERMISSION_DENIED', err: '403 PERMISSION_DENIED: The caller does not have permission' },
  { code: 'MODEL_NOT_FOUND', err: '404 NOT_FOUND: models/nonexistent-model is not found for API version' },
  { code: 'BAD_REQUEST', err: '400 INVALID_ARGUMENT: Unsupported configuration field' },
];

for (const pe of permanentErrors) {
  const diag = runClassifierHelper('diagnose', { errorString: pe.err });
  assert(diag.code === pe.code, `Error "${pe.err.slice(0, 30)}" diagnosed as ${pe.code}`);
  assert(diag.isTransient === false, `${pe.code} is NOT transient (no endless retrying)`);

  const normName = `perm-test-${pe.code.toLowerCase()}`;
  const res = runClassifierHelper('classify', {
    companies: [{ companyName: `Test ${pe.code}`, normalizedName: normName }],
    geminiThrows: pe.err,
  });

  const record = res[normName];
  assert(record.status === 'FAILED', `${pe.code} resulted in status FAILED`);
  assert(record.nextRetryAt === null, `${pe.code} nextRetryAt is null (no retry scheduled)`);
}

// ── 6. Secret Redaction / Anti-Leak ─────────────────────────────────────
console.log('\n--- Test 6: API Keys and Secrets Are Never Leaked in Logs ---');
const secretText = 'Error connecting with key AIzaSyD9876543210ABCDEFG and Bearer ya29.a0AfH6SMD-fake-token-value';
const sanitized = runClassifierHelper('sanitize', { text: secretText });
assert(!sanitized.includes('AIzaSyD'), 'API key is redacted');
assert(!sanitized.includes('ya29.'), 'Access token is redacted');
assert(sanitized.includes('[REDACTED_API_KEY]'), 'Contains [REDACTED_API_KEY]');
assert(sanitized.includes('[REDACTED_ACCESS_TOKEN]'), 'Contains [REDACTED_ACCESS_TOKEN]');


// ── 8. Background Reconciler Resolves PENDING and Promotes to Queue ─────
console.log('\n--- Test 8: Worker Reconciler Resolves PENDING and Promotes Eligible Contacts ---');

// Insert a mock pending company and an active contact
const pendingCompany = 'nexustech innovations';
const now = new Date();
const pastRetry = new Date(now.getTime() - 10000).toISOString(); // Due for retry

db.prepare(`
  INSERT OR REPLACE INTO company_classifications (
    normalized_name, company_name, classification_source, gemini_model,
    classification_result, retry_count, next_retry_at, reason, created_at, updated_at
  ) VALUES (?, ?, 'gemini', 'gemini-3.8-flash', 'PENDING', 1, ?, 'Classification Pending', ?, ?)
`).run(pendingCompany, 'NexusTech Innovations', pastRetry, now.toISOString(), now.toISOString());

// Create a dummy batch and contact
const testBatchId = 'batch_test_reconciler_123';
db.prepare(`
  INSERT OR REPLACE INTO batches (
    id, filename, upload_date, status, created_at, updated_at
  ) VALUES (?, 'test.csv', ?, 'queued', ?, ?)
`).run(testBatchId, now.toISOString(), now.toISOString(), now.toISOString());

const testContactId = 'cont_test_reconciler_123';
db.prepare(`
  INSERT OR REPLACE INTO contacts (
    id, batch_id, company_name, email, email_valid, is_duplicate, status, created_at, updated_at
  ) VALUES (?, ?, 'NexusTech Innovations', 'dev@nexustech.io', 1, 0, 'uncertain', ?, ?)
`).run(testContactId, testBatchId, now.toISOString(), now.toISOString());

// Run reconciler with mock success
const reconcileResult = runClassifierHelper('reconcile', {
  geminiMockResponse: [
    { company: 'NexusTech Innovations', relevant: true, confidence: 0.97, reason: 'Next-generation cloud platforms developer.' }
  ]
});

assert(reconcileResult.succeeded >= 1, 'Reconciler succeeded for pending company');
assert(reconcileResult.promotedToQueue >= 1, 'Reconciler promoted eligible contact to outreach_queue');

// Check SQLite state
const resolvedCompany = db.prepare('SELECT * FROM company_classifications WHERE normalized_name = ?').get(pendingCompany);
assert(resolvedCompany.classification_result === 'RELEVANT', 'Company classification_result is now RELEVANT');
assert(resolvedCompany.is_relevant === 1, 'Company is_relevant is 1');
assert(resolvedCompany.next_retry_at === null, 'next_retry_at is cleared on success');

const resolvedContact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(testContactId);
assert(resolvedContact.status === 'queued', 'Contact status is now queued');
assert(resolvedContact.is_relevant === 1, 'Contact is_relevant is 1');

const queuedEntry = db.prepare('SELECT * FROM outreach_queue WHERE contact_id = ?').get(testContactId);
assert(queuedEntry !== undefined, 'Contact now exists in outreach_queue');
assert(queuedEntry.status === 'pending', 'outreach_queue status is pending');

// Clean up dummy test records
db.prepare('DELETE FROM batches WHERE id = ?').run(testBatchId);
db.prepare('DELETE FROM contacts WHERE id = ?').run(testContactId);
db.prepare('DELETE FROM outreach_queue WHERE contact_id = ?').run(testContactId);
db.prepare('DELETE FROM company_classifications WHERE normalized_name = ?').run(pendingCompany);

console.log('\n======================================================================');
console.log(`ALL ${passedTests}/${totalTests} GEMINI-AUTHORITATIVE TESTS PASSED!`);
console.log('======================================================================');
