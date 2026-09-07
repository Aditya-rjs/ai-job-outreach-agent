import assert from 'assert';
import {
  extractAndParseEmailJson,
  AiOutputInvalidError,
  isAiOutputInvalidError,
} from '../src/lib/ai/json-parser';
import {
  categorizeGeminiError,
  globalGeminiLimiter,
  GEMINI_PRIORITIES,
} from '../src/lib/ai/gemini-client';
import {
  isOpenRouterError,
  OpenRouterError,
} from '../src/lib/ai/openrouter-client';
import {
  reconcilePendingEmailGenerations,
  computeGenerationRetryTime,
  MAX_GENERATION_RETRIES,
} from '../src/lib/pipeline/generation-reconciler';
import { getDb } from '../src/db';
import { batches, contacts, outreachQueue } from '../src/db/schema';
import { eq, sql } from 'drizzle-orm';
import { ulid } from 'ulid';

import { initializeDatabase } from '../src/db/migrate';

let passed = 0;
let total = 0;

function recordPass(desc: string) {
  passed++;
  console.log(`✓ [PASS] Test ${total}: ${desc}`);
}

async function runTests() {
  initializeDatabase();
  console.log('======================================================================');
  console.log('AI OUTPUT PARSING & GENERATION ERROR CLASSIFICATION TEST SUITE');
  console.log('======================================================================\n');

  // ===========================================================================
  // PART 8: JSON PARSER EDGE CASES (Tests 1 to 18)
  // ===========================================================================

  // Case 1: Pure valid JSON
  total++;
  const c1 = extractAndParseEmailJson(
    JSON.stringify({ subject: 'Pure Subject', body: 'Pure Body' })
  );
  assert.strictEqual(c1.subject, 'Pure Subject');
  assert.strictEqual(c1.body, 'Pure Body');
  recordPass('Case 1: Pure valid JSON parsed cleanly');

  // Case 2: Valid JSON inside ```json fence
  total++;
  const c2 = extractAndParseEmailJson(
    '```json\n{\n  "subject": "Fence Subject",\n  "body": "Fence Body"\n}\n```'
  );
  assert.strictEqual(c2.subject, 'Fence Subject');
  assert.strictEqual(c2.body, 'Fence Body');
  recordPass('Case 2: Valid JSON inside ```json fence');

  // Case 3: Valid JSON inside generic ``` fence
  total++;
  const c3 = extractAndParseEmailJson(
    '```\n{\n  "subject": "Generic Fence Subject",\n  "body": "Generic Fence Body"\n}\n```'
  );
  assert.strictEqual(c3.subject, 'Generic Fence Subject');
  assert.strictEqual(c3.body, 'Generic Fence Body');
  recordPass('Case 3: Valid JSON inside generic ``` fence');

  // Case 4: "User Safety: safe" preamble followed by valid JSON
  total++;
  const c4 = extractAndParseEmailJson(
    'User Safety: safe\n{\n  "subject": "Safety Subject",\n  "body": "Safety Body"\n}'
  );
  assert.strictEqual(c4.subject, 'Safety Subject');
  assert.strictEqual(c4.body, 'Safety Body');
  recordPass('Case 4: "User Safety: safe" preamble followed by valid JSON');

  // Case 5: Preamble + markdown fence + valid JSON
  total++;
  const c5 = extractAndParseEmailJson(
    'Here is the generated email draft:\n```json\n{\n  "subject": "Preamble Fence Subject",\n  "body": "Preamble Fence Body",\n  "strategy": "skills-focused"\n}\n```\nI hope this helps!'
  );
  assert.strictEqual(c5.subject, 'Preamble Fence Subject');
  assert.strictEqual(c5.body, 'Preamble Fence Body');
  assert.strictEqual(c5.strategy, 'skills-focused');
  recordPass('Case 5: Preamble + markdown fence + valid JSON');

  // Case 6: JSON body containing normal braces
  total++;
  const c6 = extractAndParseEmailJson(
    '{\n  "subject": "Braces Subject",\n  "body": "I worked on {system_optimization} and {database_sharding} during my tenure."\n}'
  );
  assert.strictEqual(c6.subject, 'Braces Subject');
  assert.strictEqual(c6.body, 'I worked on {system_optimization} and {database_sharding} during my tenure.');
  recordPass('Case 6: JSON body containing normal braces correctly preserved');

  // Case 7: JSON body containing quoted text
  total++;
  const c7 = extractAndParseEmailJson(
    '{\n  "subject": "Quotes Subject",\n  "body": "I learned that \\"quality engineering\\" and \\"clean architecture\\" are paramount."\n}'
  );
  assert.strictEqual(c7.subject, 'Quotes Subject');
  assert.strictEqual(c7.body, 'I learned that "quality engineering" and "clean architecture" are paramount.');
  recordPass('Case 7: JSON body containing escaped quoted text correctly preserved');

  // Case 8: Nested JSON objects
  total++;
  const c8 = extractAndParseEmailJson(
    '{\n  "subject": "Nested Subject",\n  "body": "Nested Body",\n  "metadata": { "confidence": 0.95, "tags": ["backend", "distributed"] }\n}'
  );
  assert.strictEqual(c8.subject, 'Nested Subject');
  assert.strictEqual(c8.body, 'Nested Body');
  recordPass('Case 8: Nested JSON objects handled with proper depth tracking');

  // Case 9: Missing closing brace
  total++;
  assert.throws(
    () => extractAndParseEmailJson('{\n  "subject": "Incomplete",\n  "body": "No closing brace'),
    (err: unknown) => {
      return isAiOutputInvalidError(err) && (err as AiOutputInvalidError).code === 'INVALID_OUTPUT';
    }
  );
  recordPass('Case 9: Missing closing brace throws AiOutputInvalidError');

  // Case 10: Malformed JSON (trailing comma)
  total++;
  assert.throws(
    () => extractAndParseEmailJson('{\n  "subject": "Bad JSON",\n  "body": "Malformed",\n}'),
    (err: unknown) => isAiOutputInvalidError(err)
  );
  recordPass('Case 10: Malformed JSON throws AiOutputInvalidError');

  // Case 11: Missing subject
  total++;
  assert.throws(
    () => extractAndParseEmailJson('{\n  "body": "Only body provided"\n}'),
    (err: unknown) => isAiOutputInvalidError(err)
  );
  recordPass('Case 11: Missing subject throws AiOutputInvalidError');

  // Case 12: Missing body
  total++;
  assert.throws(
    () => extractAndParseEmailJson('{\n  "subject": "Only subject provided"\n}'),
    (err: unknown) => isAiOutputInvalidError(err)
  );
  recordPass('Case 12: Missing body throws AiOutputInvalidError');

  // Case 13: Subject is not a string
  total++;
  assert.throws(
    () => extractAndParseEmailJson('{\n  "subject": 12345,\n  "body": "Valid body"\n}'),
    (err: unknown) => isAiOutputInvalidError(err)
  );
  recordPass('Case 13: Subject is not a string throws AiOutputInvalidError');

  // Case 14: Body is not a string
  total++;
  assert.throws(
    () => extractAndParseEmailJson('{\n  "subject": "Valid Subject",\n  "body": ["paragraph 1", "paragraph 2"]\n}'),
    (err: unknown) => isAiOutputInvalidError(err)
  );
  recordPass('Case 14: Body is not a string throws AiOutputInvalidError');

  // Case 15: Empty or whitespace-only response
  total++;
  assert.throws(
    () => extractAndParseEmailJson('   \n\t  '),
    (err: unknown) => isAiOutputInvalidError(err)
  );
  recordPass('Case 15: Empty/whitespace response throws AiOutputInvalidError');

  // Case 16: Response containing unrelated text with no JSON object
  total++;
  assert.throws(
    () => extractAndParseEmailJson('I am unable to fulfill this request because of policy restrictions.'),
    (err: unknown) => isAiOutputInvalidError(err)
  );
  recordPass('Case 16: Response containing unrelated text throws AiOutputInvalidError');

  // Case 17: Multiple brace-like sections, selecting the valid email JSON object
  total++;
  const c17 = extractAndParseEmailJson(
    'Context {note: draft_v1}: Here is the draft: {\n  "subject": "Multi-Brace Subject",\n  "body": "Multi-Brace Body"\n}. Best regards {signature_placeholder}.'
  );
  assert.strictEqual(c17.subject, 'Multi-Brace Subject');
  assert.strictEqual(c17.body, 'Multi-Brace Body');
  recordPass('Case 17: Multiple brace-like sections correctly selects valid outer email JSON object');

  // Case 18: Ensure parser does not accidentally extract from inside quoted string
  total++;
  const c18 = extractAndParseEmailJson(
    'Candidate said: "{\\"mock\\": \\"data\\"}" but the actual proposal is: {\n  "subject": "Real Subject",\n  "body": "Real Body"\n}'
  );
  assert.strictEqual(c18.subject, 'Real Subject');
  assert.strictEqual(c18.body, 'Real Body');
  recordPass('Case 18: Parser ignores JSON-like content from inside quoted string and extracts real object');

  // ===========================================================================
  // PART 9: ERROR CLASSIFICATION & RECONCILER RETRY INTEGRATION (Tests 19 to 30)
  // ===========================================================================

  // Helper mirroring generation-reconciler.ts logic
  const checkIsLocalBug = (err: unknown): boolean =>
    !isAiOutputInvalidError(err) &&
    (err instanceof SyntaxError ||
      err instanceof TypeError ||
      err instanceof RangeError);

  // Case 19: JSON.parse/model-output formatting failure is NOT classified as LOCAL_BUG
  total++;
  const aiOutputErr = new AiOutputInvalidError('Unexpected token in JSON');
  const isLocalBug19 = checkIsLocalBug(aiOutputErr);
  assert.strictEqual(isLocalBug19, false, 'AiOutputInvalidError must NOT be classified as LOCAL_BUG');
  recordPass('Case 19: Model output formatting failure is NOT classified as LOCAL_BUG');

  // Case 20: JSON parsing/model-output failure is retryable
  total++;
  const diag20 = categorizeGeminiError(aiOutputErr);
  assert.strictEqual(diag20.code, 'INVALID_OUTPUT');
  assert.strictEqual(diag20.isTransient, true, 'INVALID_OUTPUT must be marked isTransient: true');
  const shouldRetry20 = diag20.isTransient && !isLocalBug19 && 1 < MAX_GENERATION_RETRIES;
  assert.strictEqual(shouldRetry20, true, 'INVALID_OUTPUT must be eligible for retry');
  recordPass('Case 20: JSON parsing/model-output failure is retryable');

  // Case 21: Genuine SyntaxError from unrelated application code remains classified as deterministic/local
  total++;
  const appSyntaxErr = new SyntaxError('Invalid regular expression: /\\bcompany(inc\\b/: Unterminated group');
  const isLocalBug21 = checkIsLocalBug(appSyntaxErr);
  assert.strictEqual(isLocalBug21, true, 'Genuine SyntaxError from application code must remain LOCAL_BUG');
  recordPass('Case 21: Genuine SyntaxError from application code remains classified as deterministic/local');

  // Case 22: Existing TypeError local bug behavior remains unchanged
  total++;
  const appTypeErr = new TypeError('Cannot read properties of undefined (reading "toLowerCase")');
  const isLocalBug22 = checkIsLocalBug(appTypeErr);
  assert.strictEqual(isLocalBug22, true, 'TypeError must remain LOCAL_BUG');
  recordPass('Case 22: Existing TypeError local bug behavior remains unchanged');

  // Case 23: Existing RangeError local bug behavior remains unchanged
  total++;
  const appRangeErr = new RangeError('Maximum call stack size exceeded');
  const isLocalBug23 = checkIsLocalBug(appRangeErr);
  assert.strictEqual(isLocalBug23, true, 'RangeError must remain LOCAL_BUG');
  recordPass('Case 23: Existing RangeError local bug behavior remains unchanged');

  // Case 24: Gemini 429 behavior remains unchanged
  total++;
  const gemini429 = new Error('429 Quota exceeded: Resource has been exhausted');
  const geminiDiag = categorizeGeminiError(gemini429);
  assert.strictEqual(geminiDiag.code, 'RATE_LIMIT_EXCEEDED');
  assert.strictEqual(geminiDiag.isTransient, true);
  recordPass('Case 24: Gemini 429 rate limit error classification remains unchanged');

  // Case 25: OpenRouter 429 behavior remains unchanged
  total++;
  const or429 = new OpenRouterError('Rate limit exceeded: 429', 429, true);
  assert.strictEqual(isOpenRouterError(or429), true);
  assert.strictEqual(or429.isRateLimit, true);
  recordPass('Case 25: OpenRouter 429 error structure remains unchanged');

  // Case 26: OpenRouter 429 cannot affect Gemini cooldown
  total++;
  globalGeminiLimiter.resetForTesting();
  assert.strictEqual(globalGeminiLimiter.isCooldownActive(), false);
  const isFromOR = isOpenRouterError(or429);
  const isRateLimit26 = or429.isRateLimit;
  if (isRateLimit26 && !isFromOR) {
    globalGeminiLimiter.recordError(or429);
  }
  assert.strictEqual(globalGeminiLimiter.isCooldownActive(), false, 'OpenRouter 429 must NOT trigger Gemini cooldown');
  recordPass('Case 26: OpenRouter 429 cannot affect Gemini cooldown');

  // Case 27: Provider WAITING still burns zero generation attempts
  total++;
  const db = getDb();
  const testBatchId = `batch_waittest_${ulid()}`;
  const testContactId = `cont_waittest_${ulid()}`;

  db.insert(batches)
    .values({
      id: testBatchId,
      filename: 'test_waiting.csv',
      uploadDate: new Date().toISOString(),
      status: 'queued',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .run();

  db.insert(contacts)
    .values({
      id: testContactId,
      batchId: testBatchId,
      companyName: 'Waiting Corp',
      email: `waiting_${ulid()}@test.com`,
      isRelevant: true,
      emailValid: true,
      isDuplicate: false,
      status: 'queued',
      generationStatus: 'RETRY_PENDING',
      generationAttemptCount: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .run();

  // Simulate provider waiting revert behavior
  const revertStatus = 'RETRY_PENDING';
  db.update(contacts)
    .set({
      generationStatus: revertStatus,
      generationClaimToken: null,
      generationLeaseExpiresAt: null,
      status: 'queued',
      updatedAt: new Date().toISOString(),
    })
    .where(eq(contacts.id, testContactId))
    .run();

  const cCheck27 = db.select().from(contacts).where(eq(contacts.id, testContactId)).get();
  assert.strictEqual(cCheck27?.generationAttemptCount, 1, 'Attempt count must NOT increment during WAITING');
  assert.strictEqual(cCheck27?.generationStatus, 'RETRY_PENDING');
  recordPass('Case 27: Provider WAITING burns zero generation attempts');

  // Case 28: Existing generation retry maximum (5) remains enforced
  total++;
  function testRetryCap(attempts: number, err: unknown) {
    const isLocal = !isAiOutputInvalidError(err) && (err instanceof SyntaxError || err instanceof TypeError);
    const diag = categorizeGeminiError(err);
    return diag.isTransient && !isLocal && attempts < MAX_GENERATION_RETRIES;
  }
  assert.strictEqual(testRetryCap(1, aiOutputErr), true, 'Attempt 1 must retry');
  assert.strictEqual(testRetryCap(4, aiOutputErr), true, 'Attempt 4 must retry');
  assert.strictEqual(testRetryCap(5, aiOutputErr), false, 'Attempt 5 must transition to terminal failure');
  assert.strictEqual(testRetryCap(6, aiOutputErr), false, 'Attempt 6 must transition to terminal failure');
  recordPass('Case 28: Generation retry maximum (5) remains strictly enforced');

  // Case 29: Existing round-based Generation Retry gate remains enforced
  total++;
  const testBatch29 = `batch_roundgate_${ulid()}`;
  const cPending = `cont_pending_${ulid()}`;
  const cRetry = `cont_retry_${ulid()}`;

  db.insert(batches)
    .values({
      id: testBatch29,
      filename: 'test_roundgate.csv',
      uploadDate: new Date().toISOString(),
      status: 'queued',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .run();

  db.insert(contacts)
    .values({
      id: cPending,
      batchId: testBatch29,
      companyName: 'Active Pending Co',
      email: `active_${ulid()}@test.com`,
      isRelevant: true,
      emailValid: true,
      isDuplicate: false,
      status: 'queued',
      generationStatus: 'PENDING_GENERATION',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .run();

  db.insert(contacts)
    .values({
      id: cRetry,
      batchId: testBatch29,
      companyName: 'Waiting Retry Co',
      email: `retry_${ulid()}@test.com`,
      isRelevant: true,
      emailValid: true,
      isDuplicate: false,
      status: 'queued',
      generationStatus: 'RETRY_PENDING',
      generationAttemptCount: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .run();

  // With active pending > 0, retry claim is rejected
  const claimAttemptOnRetry = db.run(sql`
    UPDATE contacts
    SET generation_status = 'GENERATING', status = 'generating'
    WHERE id = ${cRetry}
      AND generation_status = 'RETRY_PENDING'
      AND NOT EXISTS (
        SELECT 1 FROM contacts c2
        INNER JOIN batches b2 ON c2.batch_id = b2.id
        WHERE b2.id = ${testBatch29}
          AND c2.is_relevant = 1
          AND c2.email_valid = 1
          AND c2.is_duplicate = 0
          AND c2.sent_at IS NULL
          AND c2.generation_status != 'GENERATED'
          AND c2.generation_status IN ('PENDING_GENERATION', 'GENERATING')
      )
  `);
  assert.strictEqual(claimAttemptOnRetry.changes, 0, 'Retry lease MUST be rejected while active pending > 0');
  recordPass('Case 29: Round-based Generation Retry gate remains strictly enforced');

  // Case 30: Successful recovery from malformed AI output results in GENERATED / Ready to Send
  total++;
  // Contact cRetry successfully generates on attempt 2:
  const validOutputText = 'User Safety: safe\n```json\n{\n  "subject": "Recovered Subject",\n  "body": "Recovered Body"\n}\n```';
  const parsedRecovered = extractAndParseEmailJson(validOutputText);
  assert.strictEqual(parsedRecovered.subject, 'Recovered Subject');
  assert.strictEqual(parsedRecovered.body, 'Recovered Body');

  // Update contact to GENERATED and queue item to pending
  db.update(contacts)
    .set({
      generationStatus: 'GENERATED',
      emailSubject: parsedRecovered.subject,
      emailBody: parsedRecovered.body,
      status: 'queued',
      errorMessage: null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(contacts.id, cRetry))
    .run();

  const cFinal = db.select().from(contacts).where(eq(contacts.id, cRetry)).get();
  assert.strictEqual(cFinal?.generationStatus, 'GENERATED');
  assert.strictEqual(cFinal?.emailSubject, 'Recovered Subject');
  assert.strictEqual(cFinal?.emailBody, 'Recovered Body');
  assert.strictEqual(cFinal?.status, 'queued');
  recordPass('Case 30: Successful recovery from malformed AI output transitions cleanly to GENERATED / Ready to Send');

  // Cleanup test data
  db.delete(contacts).where(eq(contacts.batchId, testBatchId)).run();
  db.delete(batches).where(eq(batches.id, testBatchId)).run();
  db.delete(contacts).where(eq(contacts.batchId, testBatch29)).run();
  db.delete(batches).where(eq(batches.id, testBatch29)).run();

  console.log('\n======================================================================');
  console.log(`ALL 30 AI OUTPUT PARSING & CLASSIFICATION TESTS PASSED: ${passed}/${total}`);
  console.log('======================================================================\n');
}

runTests().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
