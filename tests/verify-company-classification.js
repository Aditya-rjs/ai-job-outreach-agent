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
console.log('COMPANY RELEVANCE CLASSIFICATION HARDENING & DIAGNOSTICS VERIFICATION');
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

// Clean DB cache for test companies to ensure test isolation
db.prepare('DELETE FROM company_classifications WHERE normalized_name IN (?, ?)').run('cloudscale systems', 'sunset bakery');

// ── TEST A: GEMINI CLASSIFIES A TECHNOLOGY COMPANY ──────────────────────
console.log('\n--- Case A: Gemini Successfully Classifies a Technology Company ---');
const geminiTechMock = [
  {
    company: 'CloudScale Systems',
    relevant: true,
    confidence: 0.96,
    reason: 'Enterprise cloud infrastructure and software solutions provider.',
  },
];
const resultA = runClassifierHelper('classify', {
  companies: [{ rawName: 'CloudScale Systems' }],
  geminiMockResponse: geminiTechMock,
});
const techCompanyResult = resultA['cloudscale systems'];
assert(techCompanyResult.relevant === true, 'CloudScale Systems classified as relevant = true');
assert(techCompanyResult.status === 'RELEVANT', 'CloudScale Systems status is RELEVANT');
assert(techCompanyResult.source === 'gemini', 'Classification source is gemini');
assert(techCompanyResult.reason.startsWith('AI classification: Technology/engineering company.'), 'Reason starts with AI classification explanation');
assert(techCompanyResult.reason.includes('Enterprise cloud infrastructure'), 'Reason includes detailed model justification');

// ── TEST B: GEMINI CLASSIFIES A NON-TECHNOLOGY COMPANY ──────────────────
console.log('\n--- Case B: Gemini Successfully Classifies a Non-Technology Company ---');
const geminiNonTechMock = [
  {
    company: 'Sunset Bakery Co',
    relevant: false,
    confidence: 0.98,
    reason: 'Commercial food production and artisanal bread baking retail.',
  },
];
const resultB = runClassifierHelper('classify', {
  companies: [{ rawName: 'Sunset Bakery Co' }],
  geminiMockResponse: geminiNonTechMock,
});
const nonTechResult = resultB['sunset bakery'];
assert(nonTechResult.relevant === false, 'Sunset Bakery classified as relevant = false');
assert(nonTechResult.status === 'IRRELEVANT', 'Sunset Bakery status is IRRELEVANT');
assert(nonTechResult.source === 'gemini', 'Classification source is gemini');
assert(nonTechResult.reason.startsWith('AI classification: Non-technology company.'), 'Reason starts with AI Non-technology explanation');

// ── TEST C: GEMINI_API_KEY IS MISSING ───────────────────────────────────
console.log('\n--- Case C: GEMINI_API_KEY Actually Missing Diagnostic ---');
const diagC = runClassifierHelper('diagnose', {
  errorString: 'GEMINI_API_KEY is not configured in the environment.',
  apiKeyEnv: '',
});
assert(diagC.code === 'API_KEY_MISSING', 'Diagnosed code is API_KEY_MISSING');
assert(diagC.explanation === 'Gemini classification unavailable: GEMINI_API_KEY is not configured.', 'Explanation explicitly states GEMINI_API_KEY is not configured');

const heuristicC = runClassifierHelper('heuristic', {
  companyName: 'Apex Horizon Ventures',
  normalizedName: 'apex horizon ventures',
  geminiError: 'GEMINI_API_KEY is not configured in the environment.',
  apiKeyEnv: '',
});
assert(heuristicC.status === 'UNVERIFIED', 'Unknown company is marked UNVERIFIED');
assert(heuristicC.relevant === null, 'relevant is null (not false)');
assert(heuristicC.reason === 'Gemini classification unavailable: GEMINI_API_KEY is not configured.', 'Correctly attributes failure to missing API key');

// ── TEST D: GEMINI_API_KEY EXISTS BUT AUTHENTICATION FAILS ──────────────
console.log('\n--- Case D: Gemini Authentication Failure (Never Claims Key Missing) ---');
const authErrorStr = '[GoogleGenAI Error] 400 API_KEY_INVALID: API key not valid. Please pass a valid API key.';
const diagD = runClassifierHelper('diagnose', {
  errorString: authErrorStr,
  apiKeyEnv: 'present-but-invalid-key-xyz123',
});
assert(diagD.code === 'AUTH_REJECTED', 'Diagnosed code is AUTH_REJECTED');
assert(diagD.explanation === 'Gemini classification unavailable: API key rejected or unauthorized.', 'Explanation indicates API key rejected or unauthorized');
assert(!diagD.explanation.includes('not configured'), 'Does NOT claim GEMINI_API_KEY is not configured when key exists');

const heuristicD = runClassifierHelper('heuristic', {
  companyName: 'Apex Horizon Ventures',
  normalizedName: 'apex horizon ventures',
  geminiError: authErrorStr,
});
assert(heuristicD.status === 'UNVERIFIED', 'Status is UNVERIFIED for unknown company');
assert(heuristicD.reason.includes('API key rejected or unauthorized'), 'Reason correctly cites API key rejection');
assert(!heuristicD.reason.includes('not configured'), 'Reason does NOT say API key is not configured');

// ── TEST E: GEMINI RATE LIMIT / QUOTA EXCEEDED ──────────────────────────
console.log('\n--- Case E: Gemini Rate Limit / Quota Exceeded ---');
const rateLimitErrStr = '[GoogleGenAI Error] 429 RESOURCE_EXHAUSTED: Quota exceeded for quota metric generate_content';
const diagE = runClassifierHelper('diagnose', {
  errorString: rateLimitErrStr,
  apiKeyEnv: 'valid-key',
});
assert(diagE.code === 'RATE_LIMIT_EXCEEDED', 'Diagnosed code is RATE_LIMIT_EXCEEDED');
assert(diagE.explanation === 'Gemini classification unavailable: Rate limit or quota exceeded.', 'Explanation indicates rate limit / quota exceeded');
assert(!diagE.explanation.includes('not configured'), 'Does NOT claim API key is not configured upon rate limit');

const heuristicE = runClassifierHelper('heuristic', {
  companyName: 'Apex Horizon Ventures',
  normalizedName: 'apex horizon ventures',
  geminiError: rateLimitErrStr,
});
assert(heuristicE.status === 'UNVERIFIED', 'Status is UNVERIFIED');
assert(heuristicE.reason.includes('Rate limit or quota exceeded'), 'Reason cites Rate limit or quota exceeded');
assert(!heuristicE.reason.includes('not configured'), 'Reason does NOT say API key is not configured');

// ── TEST F: GEMINI TIMEOUT / NETWORK CONNECTION FAILURE ─────────────────
console.log('\n--- Case F: Gemini Timeout Diagnostic ---');
const timeoutErrStr = 'Gemini request timed out after 15000ms';
const diagF = runClassifierHelper('diagnose', {
  errorString: timeoutErrStr,
  apiKeyEnv: 'valid-key',
});
assert(diagF.code === 'TIMEOUT', 'Diagnosed code is TIMEOUT');
assert(diagF.explanation === 'Gemini classification unavailable: Network connection timed out.', 'Explanation indicates network timeout');
assert(!diagF.explanation.includes('not configured'), 'Does NOT claim API key is not configured upon timeout');

const heuristicF = runClassifierHelper('heuristic', {
  companyName: 'Apex Horizon Ventures',
  normalizedName: 'apex horizon ventures',
  geminiError: timeoutErrStr,
});
assert(heuristicF.reason.includes('Network connection timed out'), 'Reason cites Network connection timed out');
assert(!heuristicF.reason.includes('not configured'), 'Reason does NOT say API key is not configured');

// ── TEST G: GEMINI RETURNS INVALID OUTPUT ───────────────────────────────
console.log('\n--- Case G: Gemini Invalid / Unparseable Output ---');
const invalidErrStr = 'Gemini response is not an array: unexpected text returned';
const diagG = runClassifierHelper('diagnose', {
  errorString: invalidErrStr,
  apiKeyEnv: 'valid-key',
});
assert(diagG.code === 'INVALID_OUTPUT', 'Diagnosed code is INVALID_OUTPUT');
assert(diagG.explanation === 'Gemini classification unavailable: Invalid response format received from model.', 'Explanation indicates invalid response format');

const heuristicG = runClassifierHelper('heuristic', {
  companyName: 'Apex Horizon Ventures',
  normalizedName: 'apex horizon ventures',
  geminiError: invalidErrStr,
});
assert(heuristicG.reason.includes('Invalid response format received from model'), 'Reason cites Invalid response format');
assert(!heuristicG.reason.includes('not configured'), 'Reason does NOT say API key is not configured');

// ── TEST H: GEMINI UNAVAILABLE + KNOWN TECH-COMPANY HEURISTIC ───────────
console.log('\n--- Case H: Gemini Unavailable + Known Tech Heuristic ---');
// 1. Infosys
const infosysHeuristic = runClassifierHelper('heuristic', {
  companyName: 'Infosys',
  normalizedName: 'infosys',
  geminiError: rateLimitErrStr,
});
assert(infosysHeuristic.relevant === true, 'Infosys is relevant via heuristic fallback');
assert(infosysHeuristic.status === 'RELEVANT', 'Infosys status is RELEVANT');
assert(infosysHeuristic.source === 'heuristic', 'Infosys source is heuristic');
assert(infosysHeuristic.reason.includes('Heuristic match: recognized technology/engineering company'), 'Reason cites Heuristic match for technology company');

// 2. Sabre Global Capability Center
const sabreHeuristic = runClassifierHelper('heuristic', {
  companyName: 'Sabre Global Capability Center',
  normalizedName: 'sabre global capability center',
  geminiError: timeoutErrStr,
});
assert(sabreHeuristic.relevant === true, 'Sabre GCC is relevant via heuristic fallback');
assert(sabreHeuristic.status === 'RELEVANT', 'Sabre GCC status is RELEVANT');
assert(sabreHeuristic.source === 'heuristic', 'Sabre GCC source is heuristic');
assert(sabreHeuristic.reason.includes('Heuristic match: recognized technology/engineering company'), 'Reason cites Heuristic match for Sabre GCC');

// ── TEST I: GEMINI UNAVAILABLE + UNKNOWN COMPANY (UNVERIFIED, NOT IRRELEVANT) ──
console.log('\n--- Case I: Gemini Unavailable + Unknown Company (Unverified, NOT Irrelevant) ---');
const unknownHeuristic = runClassifierHelper('heuristic', {
  companyName: 'Apex Horizon Ventures',
  normalizedName: 'apex horizon ventures',
  geminiError: timeoutErrStr,
});
assert(unknownHeuristic.relevant === null, 'Unknown company relevant is null (NOT false)');
assert(unknownHeuristic.status === 'UNVERIFIED', 'Unknown company status is UNVERIFIED (NOT IRRELEVANT)');
assert(unknownHeuristic.source === 'unverified', 'Unknown company source is unverified');
assert(unknownHeuristic.reason.startsWith('Unable to verify CS/IT relevance: Network connection timed out'), 'Reason clearly states Unable to verify CS/IT relevance with timeout detail');

// ── TEST J: MULTIPLE CONTACTS FOR SAME COMPANY RECEIVE SAME CACHED RESULT ─
console.log('\n--- Case J: Multiple Contacts For Same Company Receive Same Classification ---');
const multiContactCsv = `Company,HR Name,Email
Sabre Global Capability Center,Recruiter 1,sabre_rec1_${Date.now()}@sabre.com
,Recruiter 2,sabre_rec2_${Date.now()}@sabre.com
,Recruiter 3,sabre_rec3_${Date.now()}@sabre.com
`;
const multiContactResult = runBatchProcessor(multiContactCsv, 'sabre_gcc_test.csv');
assert(multiContactResult.totalRecords === 3, 'All 3 contacts parsed');
assert(multiContactResult.relevantCompanies === 1, 'Exactly 1 company classified');
assert(multiContactResult.emailsPending === 3, 'All 3 contacts queued for outreach');

const multiContactRows = db.prepare('SELECT * FROM contacts WHERE batch_id = ? ORDER BY created_at ASC').all(multiContactResult.batchId);
assert(multiContactRows.length === 3, '3 contacts saved in database');
assert(multiContactRows.every(c => c.company_name === 'Sabre Global Capability Center'), 'All contacts inherited Sabre Global Capability Center');
assert(multiContactRows.every(c => c.is_relevant === 1), 'All contacts have is_relevant = true');
assert(multiContactRows.every(c => c.relevance_reason === multiContactRows[0].relevance_reason), 'All contacts share identical classification reason');

// ── TEST K: BLANK CONTINUATION ROWS INHERIT COMPANY BEFORE CLASSIFICATION ─
console.log('\n--- Case K: Blank Continuation Rows Inherit Company Before Classification ---');
const mixedCsv = `Company,HR Name,Email
Infosys,Lead A,infosys_a_${Date.now()}@infosys.com
,Lead B,infosys_b_${Date.now()}@infosys.com
City Plumbing Solutions,Lead C,plumb_c_${Date.now()}@plumbing.com
,Lead D,plumb_d_${Date.now()}@plumbing.com
`;
const mixedResult = runBatchProcessor(mixedCsv, 'mixed_continuation.csv');
assert(mixedResult.totalRecords === 4, '4 records parsed');
assert(mixedResult.relevantCompanies === 1, '1 relevant tech company (Infosys)');
assert(mixedResult.irrelevantCompanies === 1, '1 irrelevant non-tech company (City Plumbing Solutions)');
assert(mixedResult.emailsPending === 2, 'Exactly 2 Infosys contacts queued; 2 plumbing contacts skipped');

const mixedContacts = db.prepare('SELECT * FROM contacts WHERE batch_id = ? ORDER BY created_at ASC').all(mixedResult.batchId);
assert(mixedContacts[0].company_name === 'Infosys' && mixedContacts[0].is_relevant === 1 && mixedContacts[0].status === 'queued', 'Infosys Row 1 is queued');
assert(mixedContacts[1].company_name === 'Infosys' && mixedContacts[1].is_relevant === 1 && mixedContacts[1].status === 'queued', 'Infosys Row 2 inherited company and is queued');
assert(mixedContacts[2].company_name === 'City Plumbing Solutions' && mixedContacts[2].is_relevant === 0 && mixedContacts[2].status === 'skipped', 'Plumbing Row 3 is filtered');
assert(mixedContacts[3].company_name === 'City Plumbing Solutions' && mixedContacts[3].is_relevant === 0 && mixedContacts[3].status === 'skipped', 'Plumbing Row 4 inherited company and is filtered');

// ── TEST L: REQUIRED COMPANIES TEST MATRIX ──────────────────────────────
console.log('\n--- Case L: Required Companies Specific Test Matrix ---');
const matrixCases = [
  { name: 'Infosys', expectedStatus: 'RELEVANT' },
  { name: 'Sabre Global Capability Center', expectedStatus: 'RELEVANT' },
  { name: 'Google LLC', expectedStatus: 'RELEVANT' },
  { name: 'Microsoft Corporation', expectedStatus: 'RELEVANT' },
  { name: 'Oracle India', expectedStatus: 'RELEVANT' },
  { name: 'Wipro Technologies', expectedStatus: 'RELEVANT' },
  { name: 'Tata Consultancy Services', expectedStatus: 'RELEVANT' },
  { name: 'Acme Construction Ltd', expectedStatus: 'IRRELEVANT' },
  { name: 'City Plumbing Solutions', expectedStatus: 'IRRELEVANT' },
  { name: 'Sunrise Bakery', expectedStatus: 'IRRELEVANT' },
  { name: 'Apex Horizon Ventures', expectedStatus: 'UNVERIFIED' },
];

for (const mc of matrixCases) {
  const norm = mc.name.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  const res = runClassifierHelper('heuristic', {
    companyName: mc.name,
    normalizedName: norm,
    geminiError: 'GEMINI_API_KEY is not configured in the environment.',
  });
  assert(res.status === mc.expectedStatus, `${mc.name} heuristic classification matches expected status: ${mc.expectedStatus}`);
}

// ── TEST M: SAFE DIAGNOSTIC LOGGING AUDIT (SECRET REDACTION) ────────────
console.log('\n--- Case M: Safe Diagnostic Logging Audit (Credentials Redacted) ---');
const leakSample = 'Error calling Gemini with AIzaSyD9876543210SecretKey and token ya29.a0ARrdaMSecretAccessToken and Bearer my_secret_token_123';
const sanitizedOutput = runClassifierHelper('sanitize', { text: leakSample });
assert(!sanitizedOutput.includes('AIzaSyD9876543210SecretKey'), 'API key string was completely redacted');
assert(!sanitizedOutput.includes('ya29.a0ARrdaMSecretAccessToken'), 'Access token was completely redacted');
assert(!sanitizedOutput.includes('my_secret_token_123'), 'Bearer token was completely redacted');
assert(sanitizedOutput.includes('[REDACTED_API_KEY]'), 'Replaced with [REDACTED_API_KEY] placeholder');
assert(sanitizedOutput.includes('[REDACTED_ACCESS_TOKEN]'), 'Replaced with [REDACTED_ACCESS_TOKEN] placeholder');

console.log('\n======================================================================');
console.log(`ALL CLASSIFICATION TESTS PASSED: ${passedTests}/${totalTests}`);
console.log('REAL RECRUITER EMAILS SENT: 0');
console.log('REAL GMAIL OUTREACH HISTORY CREATED: 0');
console.log('======================================================================');
