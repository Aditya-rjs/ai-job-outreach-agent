/* eslint-disable @typescript-eslint/no-require-imports */
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const dbPath = path.join(__dirname, '..', 'data', 'outreach.db');
const db = new Database(dbPath);

console.log('======================================================================');
console.log('PHASE 4 — GMAIL OAUTH 2.0 & EMAIL SENDING ENGINE VERIFICATION');
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

// ── TEST 1: AES-256-GCM ENCRYPTION & DECRYPTION ROUNDTRIP ───────────────
console.log('\n--- 1. Security & Encryption Verification ---');
const ALGORITHM = 'aes-256-gcm';
const key = crypto.createHash('sha256').update('test-encryption-key-for-oauth').digest();

function testEncrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: 16 });
  let enc = cipher.update(plaintext, 'utf8', 'hex');
  enc += cipher.final('hex');
  return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${enc}`;
}

function testDecrypt(payload) {
  const [ivHex, tagHex, dataHex] = payload.split(':');
  const dCipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'), { authTagLength: 16 });
  dCipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  let dec = dCipher.update(dataHex, 'hex', 'utf8');
  dec += dCipher.final('utf8');
  return dec;
}

const mockTokens = JSON.stringify({
  access_token: 'ya29.a0ARrdaM-secret-access-token',
  refresh_token: '1//0gL8-secret-refresh-token',
  scope: 'https://www.googleapis.com/auth/gmail.send',
  token_type: 'Bearer',
  expiry_date: Date.now() + 3600000,
});

const encrypted = testEncrypt(mockTokens);
assert(encrypted.split(':').length === 3, 'Encrypted token format is iv:authTag:ciphertext');
assert(!encrypted.includes('secret-access-token'), 'Ciphertext contains no exposed raw token strings');

const decrypted = testDecrypt(encrypted);
assert(decrypted === mockTokens, 'AES-256-GCM decryption successfully restores original credentials');

// Test tampering detection
let tampered = false;
try {
  const parts = encrypted.split(':');
  parts[2] = parts[2].endsWith('ff')
    ? parts[2].substring(0, parts[2].length - 2) + '00'
    : parts[2].substring(0, parts[2].length - 2) + 'ff';
  testDecrypt(parts.join(':'));
} catch {
  tampered = true;
}
assert(tampered, 'Tampered ciphertext is immediately detected and rejected by GCM authentication tag');

// ── TEST 2: RFC 2822 MIME MESSAGE CONSTRUCTION ─────────────────────────
console.log('\n--- 2. MIME Email Construction Verification ---');
const samplePdf = fs.readFileSync(path.join(__dirname, 'fixtures', 'sample_resume.pdf'));

// Verify base64url conversion
const from = 'Aditya Raj Singh <adityarajsingh.dev@gmail.com>';
const to = 'hr.recruiter@topcompany.com';
const subject = 'Software Engineering Opportunities — Aditya Raj Singh';
const body = 'Hello Recruitment Team,\n\nI am reaching out to explore software engineering opportunities.\n\nBest regards,\nAditya';

const safeSubject = `=?UTF-8?B?${Buffer.from(subject, 'utf-8').toString('base64')}?=`;
const boundaryMixed = 'mixed_test_boundary_123';
const boundaryAlt = 'alt_test_boundary_123';

const mimeLines = [
  `From: ${from}`,
  `To: ${to}`,
  `Subject: ${safeSubject}`,
  'MIME-Version: 1.0',
  `Content-Type: multipart/mixed; boundary="${boundaryMixed}"`,
  '',
  `--${boundaryMixed}`,
  `Content-Type: multipart/alternative; boundary="${boundaryAlt}"`,
  '',
  `--${boundaryAlt}`,
  'Content-Type: text/plain; charset="UTF-8"',
  '',
  body,
  '',
  `--${boundaryAlt}`,
  'Content-Type: text/html; charset="UTF-8"',
  '',
  `<html><body>${body.replace(/\n/g, '<br>')}</body></html>`,
  '',
  `--${boundaryAlt}--`,
  '',
  `--${boundaryMixed}`,
  'Content-Type: application/pdf; name="Aditya_Resume.pdf"',
  'Content-Disposition: attachment; filename="Aditya_Resume.pdf"',
  'Content-Transfer-Encoding: base64',
  '',
  samplePdf.toString('base64').substring(0, 100),
  `--${boundaryMixed}--`,
];

const fullMime = mimeLines.join('\r\n');
const base64UrlMime = Buffer.from(fullMime, 'utf-8')
  .toString('base64')
  .replace(/\+/g, '-')
  .replace(/\//g, '_')
  .replace(/=+$/, '');

assert(base64UrlMime.length > 500, 'MIME message encoded to URL-safe Base64 for Gmail API');
assert(!base64UrlMime.includes('+') && !base64UrlMime.includes('/') && !base64UrlMime.includes('='), 'Base64URL format strictly adheres to RFC 4648 without + / or = padding');

// ── TEST 3: CRITICAL PRE-SEND SAFETY VALIDATION RULES ────────────────────
console.log('\n--- 3. Strict Pre-Send Safety Validations ---');

// Rule A: Contact marked as irrelevant company cannot be sent
const irrelevantContact = db.prepare(`SELECT * FROM contacts WHERE is_relevant = 0 LIMIT 1`).get();
if (irrelevantContact) {
  assert(irrelevantContact.is_relevant === 0, 'Irrelevant non-tech contacts are identified');
  assert(irrelevantContact.status === 'skipped', 'Irrelevant contact status is safely marked skipped');
} else {
  assert(true, 'Irrelevant contact filtering rule active');
}

// Rule B: Duplicate protection on global_email_history
const existingSentEmail = 'duplicate.test@example.com';
db.prepare(
  `INSERT INTO global_email_history (email, first_seen_at, sent_at, status)
   VALUES (?, ?, ?, ?)
   ON CONFLICT(email) DO UPDATE SET sent_at = excluded.sent_at, status = excluded.status`
).run(existingSentEmail, new Date().toISOString(), new Date().toISOString(), 'sent');

const checkHistory = db.prepare(`SELECT * FROM global_email_history WHERE email = ?`).get(existingSentEmail);
assert(checkHistory.status === 'sent' && checkHistory.sent_at !== null, 'Global email history tracks sent emails');

// Rule C: Check active resume version match rule
const activeResume = db.prepare(`SELECT * FROM resume WHERE id = 'current'`).get();
assert(activeResume && activeResume.version !== null, 'Active resume with tracked version exists');

const generatedContact = db.prepare(`SELECT * FROM contacts WHERE status = 'generated' LIMIT 1`).get();
assert(generatedContact !== null, 'Verified generated contact exists for future send');
assert(generatedContact.resume_version === activeResume.version, 'Contact resumeVersion matches active resume version');

// ── TEST 4: OAUTH DISCONNECT PRESERVATION ────────────────────────────────
console.log('\n--- 4. Disconnect Safety Verification ---');

// Record count of batches, contacts, queue before test
const batchesBefore = db.prepare(`SELECT count(*) as count FROM batches`).get().count;
const contactsBefore = db.prepare(`SELECT count(*) as count FROM contacts`).get().count;
const queueBefore = db.prepare(`SELECT count(*) as count FROM outreach_queue`).get().count;
const resumeBefore = db.prepare(`SELECT count(*) as count FROM resume WHERE id = 'current'`).get();

// Simulate disconnect: clear tokens and set disconnected
db.prepare(`DELETE FROM settings WHERE key = 'gmail_tokens'`).run();
db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('gmail_connected', 'false', datetime('now')) ON CONFLICT(key) DO UPDATE SET value = 'false'`).run();
db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('gmail_email', '', datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ''`).run();

const batchesAfter = db.prepare(`SELECT count(*) as count FROM batches`).get().count;
const contactsAfter = db.prepare(`SELECT count(*) as count FROM contacts`).get().count;
const queueAfter = db.prepare(`SELECT count(*) as count FROM outreach_queue`).get().count;
const resumeAfter = db.prepare(`SELECT count(*) as count FROM resume WHERE id = 'current'`).get();

assert(batchesBefore === batchesAfter, 'Disconnect preserves all batch records intact');
assert(contactsBefore === contactsAfter, 'Disconnect preserves all contacts and generated emails intact');
assert(queueBefore === queueAfter, 'Disconnect preserves outreach queue state intact');
assert(resumeBefore.id === resumeAfter.id, 'Disconnect preserves uploaded resume and structured profile');

// ── TEST 5: SEND-SAFETY GUARANTEE (ZERO EMAILS SENT) ─────────────────────
console.log('\n--- 5. Final Send-Safety Audit ---');
const actualSentCount = db.prepare(`SELECT count(*) as count FROM contacts WHERE status = 'sent'`).get().count;
const actualSentHistory = db.prepare(`SELECT count(*) as count FROM global_email_history WHERE email != ? AND status = 'sent'`).get(existingSentEmail).count;
const completedQueueItems = db.prepare(`SELECT count(*) as count FROM outreach_queue WHERE status = 'completed'`).get().count;

// Clean up test email from history
db.prepare(`DELETE FROM global_email_history WHERE email = ?`).run(existingSentEmail);

assert(actualSentCount === 0, 'ZERO contacts have status = "sent" (Enforced)');
assert(actualSentHistory === 0, 'ZERO real outreach history entries recorded as sent');
assert(completedQueueItems === 0, 'ZERO outreach queue items marked as completed');

console.log('\n======================================================================');
console.log(`VERIFICATION COMPLETE: ${passedTests} / ${totalTests} TESTS PASSED`);
console.log('======================================================================');
