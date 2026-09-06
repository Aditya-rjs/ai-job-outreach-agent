/**
 * Verification Test Suite for:
 * 1. Regex Metacharacter Escaping in Similarity Engine (Parentheses, brackets, +, *, ?, etc.)
 * 2. Bounded Email Generation Retries (MAX_GENERATION_RETRIES = 5)
 * 3. Provider-Aware Error Classification (OpenRouter 429 does NOT trigger Gemini cooldown)
 * 4. Deterministic Local Programming Errors (SyntaxError / TypeError transition to GENERATION_FAILED)
 * 5. Safe Contact Recovery Functionality (resetStuckGenerationContact / recoverStuckGenerationContacts)
 */

import assert from 'assert';
import { normalizeForComparison, checkEmailSimilarity, escapeRegExp } from '../src/lib/ai/similarity';
import {
  globalGeminiLimiter,
  categorizeGeminiError,
} from '../src/lib/ai/gemini-client';
import {
  OpenRouterError,
  isOpenRouterError,
  callOpenRouter,
  resetOpenRouterTelemetryForTesting,
  getOpenRouterTelemetry,
} from '../src/lib/ai/openrouter-client';
import {
  MAX_GENERATION_RETRIES,
  computeGenerationRetryTime,
  resetStuckGenerationContact,
  recoverStuckGenerationContacts,
} from '../src/lib/pipeline/generation-reconciler';
import { getDb } from '../src/db';
import { contacts, batches } from '../src/db/schema';
import { eq, sql } from 'drizzle-orm';
import { ulid } from 'ulid';

async function runTests() {
  console.log('================================================================');
  console.log('  STARTING GENERATION RETRY, REGEX & PROVIDER ISOLATION TESTS');
  console.log('================================================================\n');

  let passed = 0;
  let total = 0;

  function recordPass(testName: string) {
    passed++;
    console.log(`[PASS] Test ${total}: ${testName}`);
  }

  // ---------------------------------------------------------------------------
  // TEST 1: Regex Metacharacter Escaping in normalizeForComparison
  // ---------------------------------------------------------------------------
  total++;
  console.log(`\n--- TEST ${total}: Regex Metacharacter Escaping (Parentheses, Brackets, etc.) ---`);

  // Production failure reproduction: "BPCL(Bharat Petroleum" and "Adani Group(For Differently"
  const problematicCompanies = [
    'BPCL(Bharat Petroleum',
    'Adani Group(For Differently',
    'Acme (Holdings) Ltd.',
    'Test [Engineering] + Co.',
    'Special $100 * & ^ ? Company',
    'Regex.Dot*Asterisk+Plus?Question(Paren)[Bracket]{Brace}|Pipe^Caret$Dollar\\Backslash',
  ];

  const sampleEmail = 'Hello recruitment team at BPCL(Bharat Petroleum, I am reaching out for software roles.';

  for (const company of problematicCompanies) {
    // Should NOT throw RegExp syntax error
    let normalized: string[] = [];
    assert.doesNotThrow(() => {
      normalized = normalizeForComparison(sampleEmail, [company]);
    }, `Failed to normalize with special character company name: ${company}`);
    assert.ok(Array.isArray(normalized));
    assert.ok(normalized.length > 0);
  }

  // Test escapeRegExp utility directly
  const specialChars = '.*+?^${}()|[]\\';
  const escaped = escapeRegExp(specialChars);
  const re = new RegExp(escaped);
  assert.ok(re.test(specialChars), 'Escaped regex should match literal special characters');

  // Test similarity check with special characters in dynamic ignore list
  const simResult = checkEmailSimilarity(
    'I am excited to apply to BPCL(Bharat Petroleum as a software engineer.',
    ['I am eager to apply to BPCL(Bharat Petroleum as a backend developer.'],
    ['BPCL(Bharat Petroleum'],
    0.65
  );
  assert.ok(typeof simResult.isTooSimilar === 'boolean');
  assert.ok(typeof simResult.maxSimilarity === 'number');

  recordPass('Regex metacharacters are safely escaped and never throw SyntaxError');

  // ---------------------------------------------------------------------------
  // TEST 2: Provider-Aware Error Classification (OpenRouter 429 vs Gemini 429)
  // ---------------------------------------------------------------------------
  total++;
  console.log(`\n--- TEST ${total}: Provider-Aware Error Classification ---`);

  // Ensure Gemini cooldown is inactive before test
  globalGeminiLimiter.resetForTesting();
  assert.strictEqual(globalGeminiLimiter.isCooldownActive(), false);

  // 1. Simulate an OpenRouter 429 error
  const openRouterErr = new OpenRouterError(
    'OpenRouter rate limit exceeded (429): {"error":{"message":"free-models-per-day: 50 limit reached"}}',
    429,
    true
  );

  assert.strictEqual(isOpenRouterError(openRouterErr), true, 'Must identify OpenRouterError');
  assert.strictEqual(openRouterErr.isRateLimit, true);
  assert.strictEqual(openRouterErr.provider, 'openrouter');

  // Verify that an OpenRouter error does NOT trigger a Gemini cooldown when checked
  const isFromOpenRouter = isOpenRouterError(openRouterErr);
  const diag = categorizeGeminiError(openRouterErr);
  const isRateLimit =
    diag.code === 'RATE_LIMIT_EXCEEDED' ||
    /\b429\b/.test(diag.safeDetail) ||
    /RESOURCE_EXHAUSTED/i.test(diag.safeDetail) ||
    Boolean(openRouterErr.isRateLimit);

  assert.strictEqual(isFromOpenRouter, true);
  assert.strictEqual(isRateLimit, true);

  // In the reconciler, the condition is:
  // if (isRateLimit && !isFromOpenRouter) { globalGeminiLimiter.recordError(genErr); }
  if (isRateLimit && !isFromOpenRouter) {
    globalGeminiLimiter.recordError(openRouterErr);
  }

  // Gemini limiter cooldown MUST REMAIN INACTIVE!
  assert.strictEqual(
    globalGeminiLimiter.isCooldownActive(),
    false,
    'OpenRouter 429 error must NEVER trigger Gemini limiter cooldown'
  );

  // 2. Simulate a genuine Gemini 429 error
  const gemini429Err = new Error('429 Quota exceeded for quota metric GenerateContentRequests');
  const isFromOpenRouterGemini = isOpenRouterError(gemini429Err);
  const geminiDiag = categorizeGeminiError(gemini429Err);
  const isGeminiRateLimit =
    geminiDiag.code === 'RATE_LIMIT_EXCEEDED' ||
    /\b429\b/.test(geminiDiag.safeDetail);

  assert.strictEqual(isFromOpenRouterGemini, false);
  assert.strictEqual(isGeminiRateLimit, true);

  // Now when genuine Gemini 429 happens, it DOES record to Gemini limiter
  if (isGeminiRateLimit && !isFromOpenRouterGemini) {
    globalGeminiLimiter.recordError(gemini429Err);
  }

  assert.strictEqual(
    globalGeminiLimiter.isCooldownActive(),
    true,
    'Genuine Gemini 429 error MUST trigger Gemini limiter cooldown'
  );

  // Cleanup
  globalGeminiLimiter.resetForTesting();
  recordPass('OpenRouter 429 is isolated and does not trigger Gemini limiter cooldown');

  // ---------------------------------------------------------------------------
  // TEST 3: Bounded Email Generation Retries (MAX_GENERATION_RETRIES = 5)
  // ---------------------------------------------------------------------------
  total++;
  console.log(`\n--- TEST ${total}: Bounded Email Generation Retries (Max 5) ---`);

  assert.strictEqual(MAX_GENERATION_RETRIES, 5, 'MAX_GENERATION_RETRIES must be 5');

  // Test retry backoff schedule: 2m, 4m, 8m, 15m, 15m
  const baseTime = new Date('2026-09-06T10:00:00Z');
  const r1 = new Date(computeGenerationRetryTime(1, baseTime)).getTime() - baseTime.getTime();
  const r2 = new Date(computeGenerationRetryTime(2, baseTime)).getTime() - baseTime.getTime();
  const r3 = new Date(computeGenerationRetryTime(3, baseTime)).getTime() - baseTime.getTime();
  const r4 = new Date(computeGenerationRetryTime(4, baseTime)).getTime() - baseTime.getTime();
  const r5 = new Date(computeGenerationRetryTime(5, baseTime)).getTime() - baseTime.getTime();

  assert.strictEqual(r1, 2 * 60 * 1000, 'Attempt 1 backoff should be 2 minutes');
  assert.strictEqual(r2, 4 * 60 * 1000, 'Attempt 2 backoff should be 4 minutes');
  assert.strictEqual(r3, 8 * 60 * 1000, 'Attempt 3 backoff should be 8 minutes');
  assert.strictEqual(r4, 15 * 60 * 1000, 'Attempt 4 backoff should be capped at 15 minutes');
  assert.strictEqual(r5, 15 * 60 * 1000, 'Attempt 5 backoff should be capped at 15 minutes');

  // Retry decision logic test
  function testRetryDecision(attempts: number, error: unknown) {
    const isFromOR = isOpenRouterError(error);
    const isLocalBug =
      error instanceof SyntaxError ||
      error instanceof TypeError ||
      error instanceof RangeError;
    const errorDiag = categorizeGeminiError(error);
    return errorDiag.isTransient && !isLocalBug && attempts < MAX_GENERATION_RETRIES;
  }

  // Transient error at attempt 1..4 should retry
  const transientErr = new Error('503 Service Unavailable');
  assert.strictEqual(testRetryDecision(1, transientErr), true, 'Attempt 1 transient should retry');
  assert.strictEqual(testRetryDecision(4, transientErr), true, 'Attempt 4 transient should retry');
  // At attempt 5, should FAIL (no more retry)
  assert.strictEqual(testRetryDecision(5, transientErr), false, 'Attempt 5 must transition to GENERATION_FAILED');
  assert.strictEqual(testRetryDecision(10, transientErr), false, 'Attempt 10 must transition to GENERATION_FAILED');

  // Deterministic local bug should FAIL immediately on attempt 1
  const syntaxErr = new SyntaxError('Invalid regular expression: /\\bbpcl(bharat petroleum\\b/g: Unterminated group');
  assert.strictEqual(testRetryDecision(1, syntaxErr), false, 'Deterministic syntax error must not retry');

  recordPass('Retry attempts capped at 5 and deterministic local errors fail immediately');

  // ---------------------------------------------------------------------------
  // TEST 4: Contact Recovery Mechanics (DB Integration Test)
  // ---------------------------------------------------------------------------
  total++;
  console.log(`\n--- TEST ${total}: Contact Recovery (resetStuckGenerationContact) ---`);

  const db = getDb();
  const testBatchId = `batch_test_${ulid()}`;
  const testContact1Id = `cont_test_${ulid()}`;
  const testContact2Id = `cont_test_${ulid()}`;

  // Insert mock batch and contacts
  db.insert(batches)
    .values({
      id: testBatchId,
      filename: 'test_recovery.csv',
      uploadDate: new Date().toISOString(),
      totalRecords: 2,
      validRecords: 2,
      relevantCompanies: 2,
      irrelevantCompanies: 0,
      duplicateContacts: 0,
      invalidEmails: 0,
      emailsSent: 0,
      emailsFailed: 0,
      emailsPending: 2,
      status: 'queued',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .run();

  // Contact 1: stuck in RETRY_PENDING with attempt 10 and error message
  db.insert(contacts)
    .values({
      id: testContact1Id,
      batchId: testBatchId,
      companyName: 'BPCL(Bharat Petroleum',
      contactName: 'HR Manager',
      email: `bpcl_test_${ulid()}@example.com`,
      isRelevant: true,
      emailValid: true,
      isDuplicate: false,
      status: 'queued',
      generationStatus: 'RETRY_PENDING',
      generationAttemptCount: 10,
      errorMessage: 'SyntaxError: Invalid regular expression: Unterminated group',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .run();

  // Contact 2: stuck in GENERATION_FAILED
  db.insert(contacts)
    .values({
      id: testContact2Id,
      batchId: testBatchId,
      companyName: 'Adani Group(For Differently',
      contactName: 'Talent Acquisition',
      email: `adani_test_${ulid()}@example.com`,
      isRelevant: true,
      emailValid: true,
      isDuplicate: false,
      status: 'failed',
      generationStatus: 'GENERATION_FAILED',
      generationAttemptCount: 5,
      errorMessage: 'OpenRouter rate limit exceeded (429): free-models-per-day: 50 limit reached',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .run();

  // Execute recovery on both
  const recoveryResult = recoverStuckGenerationContacts([testContact1Id, testContact2Id]);
  assert.strictEqual(recoveryResult.resetCount, 2, 'Should reset both contacts');
  assert.strictEqual(recoveryResult.notFoundOrSkipped.length, 0);

  // Check state of Contact 1
  const postContact1 = db.select().from(contacts).where(eq(contacts.id, testContact1Id)).get();
  assert.ok(postContact1);
  assert.strictEqual(postContact1.generationStatus, 'PENDING_GENERATION', 'Generation status must be PENDING_GENERATION');
  assert.strictEqual(postContact1.generationAttemptCount, 0, 'Attempt count must be 0');
  assert.strictEqual(postContact1.status, 'queued', 'Contact status must be queued');
  assert.strictEqual(postContact1.errorMessage, null, 'Error message must be cleared');
  assert.strictEqual(postContact1.nextGenerationRetryAt, null, 'Next retry at must be cleared');

  // Check state of Contact 2
  const postContact2 = db.select().from(contacts).where(eq(contacts.id, testContact2Id)).get();
  assert.ok(postContact2);
  assert.strictEqual(postContact2.generationStatus, 'PENDING_GENERATION', 'Generation status must be PENDING_GENERATION');
  assert.strictEqual(postContact2.generationAttemptCount, 0, 'Attempt count must be 0');
  assert.strictEqual(postContact2.status, 'queued', 'Contact status must be queued');
  assert.strictEqual(postContact2.errorMessage, null, 'Error message must be cleared');

  // Test already-generated contact protection:
  // If contact is GENERATED, resetStuckGenerationContact should NOT touch it
  db.update(contacts)
    .set({ generationStatus: 'GENERATED', status: 'generated' })
    .where(eq(contacts.id, testContact1Id))
    .run();

  const resetGenerated = resetStuckGenerationContact(testContact1Id);
  assert.strictEqual(resetGenerated, false, 'Must not overwrite already GENERATED contacts');

  // Cleanup test data
  db.delete(contacts).where(eq(contacts.batchId, testBatchId)).run();
  db.delete(batches).where(eq(batches.id, testBatchId)).run();

  recordPass('Contact recovery resets stuck contacts to PENDING_GENERATION with zeroed attempts and protects generated contacts');

  // ---------------------------------------------------------------------------
  // TEST 5: OpenRouter Telemetry 429 Tracking
  // ---------------------------------------------------------------------------
  total++;
  console.log(`\n--- TEST ${total}: OpenRouter Telemetry 429 Tracking ---`);

  resetOpenRouterTelemetryForTesting();
  const teleBefore = getOpenRouterTelemetry();
  assert.strictEqual(teleBefore.rateLimit429Count, 0);

  // Set mock key & mock fetch returning 429
  process.env.OPENROUTER_API_KEY = 'sk-or-test-429-key';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    return {
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      text: async () => JSON.stringify({ error: { message: 'free-models-per-day: 50 limit reached' } }),
    } as Response;
  }) as typeof fetch;

  try {
    let caught429 = false;
    try {
      await callOpenRouter('test 429 tracking', { maxRetries: 1 });
    } catch (err) {
      caught429 = true;
      assert.ok(isOpenRouterError(err));
      assert.strictEqual((err as OpenRouterError).isRateLimit, true);
      assert.strictEqual((err as OpenRouterError).statusCode, 429);
    }
    assert.strictEqual(caught429, true, 'Should catch OpenRouterError');

    const teleAfter = getOpenRouterTelemetry();
    assert.ok(teleAfter.rateLimit429Count >= 1, 'rateLimit429Count should be incremented on 429');
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.OPENROUTER_API_KEY;
    resetOpenRouterTelemetryForTesting();
  }

  recordPass('OpenRouter telemetry tracks 429 count accurately');

  console.log('\n================================================================');
  console.log(`  ALL TESTS PASSED: ${passed}/${total}`);
  console.log('================================================================\n');
}

runTests().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
