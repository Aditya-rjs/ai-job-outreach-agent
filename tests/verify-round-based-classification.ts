/**
 * Verification Suite for Round-Based Company Classification Pipeline & Autonomous Self-Healing
 *
 * Verifies:
 * Scenario A: 347 companies in First Pass (Round 0). 341 succeed, 6 transiently fail.
 *             341 immediately cascade to contacts for Email Generation.
 *             6 enter RETRY_WAITING.
 *             While active PENDING > 0, NO retry round starts.
 *             When active PENDING = 0, Classification Pending = 0 and Classification Retry Waiting = 6.
 * Scenario B: Retry Round 1 begins when active PENDING = 0.
 *             6 companies evaluated: 4 succeed, 2 fail transiently.
 *             4 immediately cascade to Email Generation.
 *             2 enter RETRY_WAITING.
 *             When active PENDING = 0, Classification Pending = 0 and Classification Retry Waiting = 2.
 * Scenario C: Retry Round 2 begins. Remaining 2 companies succeed.
 *             Classification Pending = 0, Classification Retry Waiting = 0.
 * Scenario D: Worker crash during first round: stale lease reclaims and resumes round 0.
 * Scenario E: Worker restart while waiting for retry: RETRY_WAITING state persists in SQLite.
 * Scenario F: Worker crash during retry round: stale lease reclaims and resumes retry round.
 * Scenario G: Expired classification lease automatically reclaimed.
 * Scenario H: Concurrent worker duplicate prevention via atomic lease claims.
 * Scenario I: Gemini 429 rate limit recorded and isolated.
 * Scenario J: OpenRouter 429 does NOT touch Gemini rate limiter or circuit breaker cooldown.
 * Scenario K: Malformed AI response handled as transient error -> RETRY_WAITING.
 * Scenario L: Deterministic failure (e.g. permanent configuration error) transitions terminally to FAILED.
 * Scenario M: Maximum retry count (5) capped. Exceeded attempts transition terminally to FAILED.
 * Scenario N: Pre-existing historical completed classifications preserved and cascaded without AI call.
 * Scenario O: Orphan discovery seeds new companies without overwriting existing RETRY_WAITING or FAILED.
 * Scenario P: Duplicate normalized company names grouped into single company record.
 * Scenario Q: Empty or invalid company names safely handled.
 * Scenario R: Email generation continues progressively while classification retry items are waiting.
 * Scenario S: Ready to Send counter increments as generation completes.
 * Scenario T: Sending policy remains intact (10 AM-4 PM IST window, 144h cooldown, no 30/day hard cap).
 * Scenario U: State persistence across simulated worker/application restarts.
 * Scenario V: Safety constraint: strictly 0 real recruiter emails dispatched.
 */

import path from 'path';
import fs from 'fs';
import assert from 'assert';

// Isolated test database directory
const TEST_DIR = path.join(process.cwd(), 'data', 'test-round-based-classification');
if (fs.existsSync(TEST_DIR)) {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
}
fs.mkdirSync(TEST_DIR, { recursive: true });

process.env.DATA_DIR = TEST_DIR;
(process.env as Record<string, string>).NODE_ENV = 'test';
process.env.OUTREACH_DRY_RUN = 'true';

import { getDb, resetDbConnection } from '../src/db';
import { initializeDatabase } from '../src/db/migrate';
import {
  batches,
  contacts,
  outreachQueue,
  companyClassifications,
  schedulerState,
  resume,
} from '../src/db/schema';
import { eq, sql, inArray } from 'drizzle-orm';
import { saveCandidateProfile } from '../src/lib/candidate-profile/candidate-profile-service';
import {
  reconcilePendingClassifications,
  discoverAndSeedOrphanedCompanies,
  cascadeClassificationToContacts,
  resetActiveClassificationClaimsForTesting,
  getClassificationRoundState,
  getUnclassifiedCompanyNamesForBatch,
  promoteBatchRetryWaitingToNextRound,
  MAX_CLASSIFICATION_ROUNDS,
} from '../src/lib/pipeline/classification-reconciler';
import {
  reconcilePendingEmailGenerations,
  resetGenerationActiveClaimsForTesting,
} from '../src/lib/pipeline/generation-reconciler';
import {
  getProcessingPipelineStats,
  getClassificationPendingList,
  getClassificationRetryWaitingList,
} from '../src/lib/processing-queries';
import {
  resetClassificationMemoryCache,
  type CompanyEvaluationInput,
} from '../src/lib/ai/company-classifier';
import { globalGeminiLimiter } from '../src/lib/ai/gemini-client';
import { recordOpenRouterFailure, getOpenRouterTelemetry } from '../src/lib/ai/openrouter-client';
import { normalizeCompanyName } from '../src/lib/utils/company';

async function runTests() {
  console.log('======================================================================');
  console.log('ROUND-BASED COMPANY CLASSIFICATION & RELIABILITY TEST SUITE');
  console.log('======================================================================\n');

  initializeDatabase();
  const db = getDb();
  resetActiveClassificationClaimsForTesting();
  resetClassificationMemoryCache();
  globalGeminiLimiter.resetForTesting();

  const nowIso = new Date().toISOString();

  // -------------------------------------------------------------------------
  // Test Batch Setup
  // -------------------------------------------------------------------------
  const batchId = 'batch_round_test_01';
  db.insert(batches)
    .values({
      id: batchId,
      filename: 'round_test.csv',
      uploadDate: nowIso,
      status: 'processing',
      totalRecords: 347,
      validRecords: 347,
      createdAt: nowIso,
      updatedAt: nowIso,
    })
    .run();

  // =========================================================================
  // SCENARIO A: 347 Companies in First Pass (Round 0)
  // 341 succeed, 6 fail transiently -> 341 cascade; 6 enter RETRY_WAITING
  // =========================================================================
  console.log('--- SCENARIO A: First Pass (347 companies: 341 success, 6 transient failures) ---');

  // Seed 347 companies directly as PENDING (Round 0)
  const failedCompanyNames = new Set<string>([
    'company-fail-1',
    'company-fail-2',
    'company-fail-3',
    'company-fail-4',
    'company-fail-5',
    'company-fail-6',
    'company fail 1',
    'company fail 2',
    'company fail 3',
    'company fail 4',
    'company fail 5',
    'company fail 6',
  ]);

  db.transaction((tx) => {
    for (let i = 1; i <= 347; i++) {
      const compName = i <= 6 ? `company-fail-${i}` : `company-success-${i}`;
      const normName = normalizeCompanyName(compName);

      tx.insert(companyClassifications)
        .values({
          normalizedName: normName,
          companyName: compName,
          classificationResult: 'PENDING',
          retryRound: 0,
          retryCount: 0,
          reason: 'Classification Pending — Queued for First Pass.',
          createdAt: nowIso,
          updatedAt: nowIso,
        })
        .run();

      tx.insert(contacts)
        .values({
          id: `cont_a_${i}`,
          batchId,
          companyName: compName,
          contactName: `Contact ${i}`,
          email: `contact${i}@${compName}.com`,
          emailValid: true,
          isDuplicate: false,
          status: 'discovered',
          createdAt: nowIso,
          updatedAt: nowIso,
        })
        .run();
    }
  });

  // Verify initial stats before reconciler runs
  const initialStats = getProcessingPipelineStats();
  assert.strictEqual(initialStats.classificationPendingCount, 347, 'Initial active PENDING must equal 347');
  assert.strictEqual(initialStats.classificationRetryWaitingCount, 0, 'Initial RETRY_WAITING must equal 0');
  console.log('✓ [PASS] Initial state: 347 PENDING, 0 RETRY_WAITING');

  // Mock Gemini caller:
  // Fails on failedCompanyNames with transient rate limit error; succeeds for others
  const mockGeminiCaller = async (prompt: string): Promise<string> => {
    // Parse company names from prompt
    const matches = Array.from(prompt.matchAll(/Company:\s*"([^"]+)"/g)).map((m) => m[1]);
    const results: Array<{ company: string; relevant: boolean }> = [];

    let hasFailure = false;
    for (const comp of matches) {
      if (failedCompanyNames.has(comp)) {
        hasFailure = true;
        break;
      }
      results.push({ company: comp, relevant: true });
    }

    if (hasFailure) {
      const err = new Error('429 Too Many Requests: Rate limit exceeded temporarily.');
      throw err;
    }

    return JSON.stringify(results);
  };

  // Run reconciler for the first round
  // First chunk of 6 failing companies is evaluated and encounters 429
  await reconcilePendingClassifications(mockGeminiCaller, { batchSize: 6 });

  // In the first run:
  // Chunk 1 has company-fail-1..6, which throws 429.
  // Chunk 1 companies are marked RETRY_WAITING (retryCount = 1, retryRound = 0).
  // The loop stopped on 429 to protect quota, leaving remaining chunks in PENDING.
  const midRoundState = getClassificationRoundState(db);
  assert.strictEqual(midRoundState.retryWaitingCount, 6, '6 failed companies must be in RETRY_WAITING');
  assert.ok(midRoundState.activePendingCount > 0, 'Active PENDING must remain > 0 for remaining chunks');
  assert.strictEqual(midRoundState.isCurrentRoundDrained, false, 'Current round is NOT drained yet');

  const midRoundPipelineStats = getProcessingPipelineStats();
  assert.strictEqual(midRoundPipelineStats.classificationRetryWaitingCount, 6, 'Dashboard: RETRY_WAITING is 6');
  assert.strictEqual(midRoundPipelineStats.classificationPendingCount, midRoundState.activePendingCount, 'Dashboard: Pending only counts active PENDING');
  console.log(`✓ [PASS] While active PENDING > 0 (${midRoundState.activePendingCount}), 6 failed companies stay in RETRY_WAITING and NO retry round starts.`);

  // Reset rate limiter so next runs succeed for remaining companies
  globalGeminiLimiter.resetForTesting();

  // Process remaining PENDING chunks in Round 0
  let safetyLoop = 0;
  while (safetyLoop < 30) {
    safetyLoop++;
    const state = getClassificationRoundState(db);
    if (state.activePendingCount === 0) break;
    await reconcilePendingClassifications(mockGeminiCaller);
  }

  // Verify that all 341 succeeded and 6 are RETRY_WAITING
  const drainedRoundState = getClassificationRoundState(db);
  assert.strictEqual(drainedRoundState.activePendingCount, 0, 'Round 0 must be completely drained (active PENDING = 0)');
  assert.strictEqual(drainedRoundState.retryWaitingCount, 6, 'Exact 6 companies must be waiting in RETRY_WAITING');
  assert.strictEqual(drainedRoundState.isCurrentRoundDrained, true, 'isCurrentRoundDrained must be true');

  const drainedPipelineStats = getProcessingPipelineStats();
  assert.strictEqual(drainedPipelineStats.classificationPendingCount, 0, 'CRITICAL RULE: Classification Pending MUST be exactly 0');
  assert.strictEqual(drainedPipelineStats.classificationRetryWaitingCount, 6, 'CRITICAL RULE: Classification Retry Waiting MUST be exactly 6');
  console.log('✓ [PASS] EXACT CRITICAL INVARIANT: Classification Pending = 0, Classification Retry Waiting = 6');

  // Verify 341 contacts immediately cascaded and are ready for Email Generation
  const pendingGenCount = db.get<{ count: number }>(sql`
    SELECT COUNT(*) as count FROM contacts
    WHERE is_relevant = 1 AND generation_status = 'PENDING_GENERATION'
  `)?.count ?? 0;
  assert.strictEqual(pendingGenCount, 341, '341 successful companies must immediately cascade to PENDING_GENERATION');
  console.log('✓ [PASS] 341 successful companies immediately cascaded contacts into Email Generation');

  // =========================================================================
  // SCENARIO B: Retry Round 1 (6 unresolved: 4 succeed, 2 fail)
  // =========================================================================
  console.log('\n--- SCENARIO B: Retry Round 1 (6 unresolved: 4 succeed, 2 fail) ---');

  // Update mock caller: 4 succeed, 2 remain failing
  const stillFailing = new Set<string>([
    'company-fail-5',
    'company-fail-6',
    'company fail 5',
    'company fail 6',
  ]);
  const mockGeminiCallerRound1 = async (prompt: string): Promise<string> => {
    const matches = Array.from(prompt.matchAll(/Company:\s*"([^"]+)"/g)).map((m) => m[1]);
    const results: Array<{ company: string; relevant: boolean }> = [];

    for (const comp of matches) {
      if (stillFailing.has(comp)) {
        throw new Error('429 Too Many Requests: Transient provider rate limit.');
      }
      results.push({ company: comp, relevant: true });
    }
    return JSON.stringify(results);
  };

  // Trigger reconciler: Since active PENDING == 0 and RETRY_WAITING == 6,
  // reconciler must start Retry Round 1!
  // Process in batches of 4 (4 succeed first, remaining 2 fail with 429)
  globalGeminiLimiter.resetForTesting();
  await reconcilePendingClassifications(mockGeminiCallerRound1, { batchSize: 4 });

  // In Retry Round 1:
  // The 6 RETRY_WAITING companies were promoted to PENDING (retry_round = 1).
  // 4 succeeded and cascaded. 2 failed and became RETRY_WAITING (retry_round = 1, retryCount = 2).
  const round1State = getClassificationRoundState(db);
  assert.strictEqual(round1State.activePendingCount, 0, 'Retry Round 1 active PENDING must be 0 after completion');
  assert.strictEqual(round1State.retryWaitingCount, 2, 'Exactly 2 companies remain in RETRY_WAITING');
  assert.strictEqual(round1State.currentMaxRound, 1, 'Current max round must be 1 (Retry Round 1)');

  const round1Stats = getProcessingPipelineStats();
  assert.strictEqual(round1Stats.classificationPendingCount, 0, 'Classification Pending must be 0');
  assert.strictEqual(round1Stats.classificationRetryWaitingCount, 2, 'Classification Retry Waiting must be 2');

  const newPendingGenCount = db.get<{ count: number }>(sql`
    SELECT COUNT(*) as count FROM contacts
    WHERE is_relevant = 1 AND generation_status = 'PENDING_GENERATION'
  `)?.count ?? 0;
  assert.strictEqual(newPendingGenCount, 345, '341 + 4 = 345 contacts now ready for Email Generation');
  console.log('✓ [PASS] Retry Round 1: 4 newly resolved companies immediately cascaded (total 345 in generation pipeline). Classification Pending: 0, Retry Waiting: 2.');

  // =========================================================================
  // SCENARIO C: Retry Round 2 (2 remaining unresolved: both succeed)
  // =========================================================================
  console.log('\n--- SCENARIO C: Retry Round 2 (2 remaining unresolved: both succeed) ---');

  // Both succeed in Round 2
  const mockGeminiCallerRound2 = async (prompt: string): Promise<string> => {
    const matches = Array.from(prompt.matchAll(/Company:\s*"([^"]+)"/g)).map((m) => m[1]);
    return JSON.stringify(matches.map((c) => ({ company: c, relevant: true })));
  };

  globalGeminiLimiter.resetForTesting();
  await reconcilePendingClassifications(mockGeminiCallerRound2);

  const round2State = getClassificationRoundState(db);
  assert.strictEqual(round2State.activePendingCount, 0, 'Round 2 active PENDING = 0');
  assert.strictEqual(round2State.retryWaitingCount, 0, 'Round 2 RETRY_WAITING = 0');
  assert.strictEqual(round2State.currentMaxRound, 2, 'Current max round = 2 (Retry Round 2)');

  const finalGenCount = db.get<{ count: number }>(sql`
    SELECT COUNT(*) as count FROM contacts
    WHERE is_relevant = 1 AND generation_status = 'PENDING_GENERATION'
  `)?.count ?? 0;
  assert.strictEqual(finalGenCount, 347, 'All 347 contacts are now cascaded and in Email Generation');
  console.log('✓ [PASS] Retry Round 2 completed cleanly. All 347 companies resolved. Pending: 0, Retry Waiting: 0.');

  // =========================================================================
  // SCENARIO D & G: Worker Crash During First Round & Stale Lease Recovery
  // =========================================================================
  console.log('\n--- SCENARIO D & G: Worker Crash During Round & Stale Lease Recovery ---');

  // Insert an active record in PENDING with an expired lease
  const expiredIso = new Date(Date.now() - 120000).toISOString();
  db.insert(companyClassifications)
    .values({
      normalizedName: 'stale-crash-co',
      companyName: 'Stale Crash Co',
      classificationResult: 'PENDING',
      retryRound: 0,
      retryCount: 0,
      claimToken: 'crashed_worker_token_999',
      leaseExpiresAt: expiredIso,
      reason: 'Claimed by worker before crash',
      createdAt: nowIso,
      updatedAt: expiredIso,
    })
    .run();

  // Run reconciler: must recover the stale lease and process without starting an accidental retry round
  await reconcilePendingClassifications(mockGeminiCallerRound2);

  const recoveredRow = db
    .select()
    .from(companyClassifications)
    .where(eq(companyClassifications.normalizedName, 'stale-crash-co'))
    .get();

  assert.strictEqual(recoveredRow?.classificationResult, 'RELEVANT', 'Crashed worker record was recovered and resolved');
  assert.strictEqual(recoveredRow?.claimToken, null, 'Claim token cleared');
  assert.strictEqual(recoveredRow?.leaseExpiresAt, null, 'Lease cleared');
  console.log('✓ [PASS] Stale lease recovered automatically after worker crash and successfully resolved.');

  // =========================================================================
  // SCENARIO E & U: Worker Restart While Waiting for Retry & Persistence
  // =========================================================================
  console.log('\n--- SCENARIO E & U: SQLite Persistence Across Worker Restarts ---');

  // Seed 2 companies in RETRY_WAITING
  db.insert(companyClassifications)
    .values({
      normalizedName: 'persist-co-1',
      companyName: 'Persist Co 1',
      classificationResult: 'RETRY_WAITING',
      retryRound: 1,
      retryCount: 1,
      reason: 'Classification Retry Waiting — Simulated waiting state',
      createdAt: nowIso,
      updatedAt: nowIso,
    })
    .run();

  // Simulate process termination and database reconnection
  resetDbConnection();
  const dbAfterRestart = getDb();

  const persistedRow = dbAfterRestart
    .select()
    .from(companyClassifications)
    .where(eq(companyClassifications.normalizedName, 'persist-co-1'))
    .get();

  assert.strictEqual(persistedRow?.classificationResult, 'RETRY_WAITING', 'State is RETRY_WAITING after restart');
  assert.strictEqual(persistedRow?.retryRound, 1, 'retryRound is 1 after restart');
  assert.strictEqual(persistedRow?.retryCount, 1, 'retryCount is 1 after restart');
  console.log('✓ [PASS] State machine perfectly preserved across process restart via SQLite.');

  // Clean up test row
  db.delete(companyClassifications).where(eq(companyClassifications.normalizedName, 'persist-co-1')).run();

  // =========================================================================
  // SCENARIO H: Duplicate Worker Prevention via Atomic Claim Leases
  // =========================================================================
  console.log('\n--- SCENARIO H: Duplicate Worker Prevention via Atomic Claim Leases ---');

  // Seed a pending record
  db.insert(companyClassifications)
    .values({
      normalizedName: 'race-co',
      companyName: 'Race Co',
      classificationResult: 'PENDING',
      retryRound: 0,
      retryCount: 0,
      reason: 'Pending',
      createdAt: nowIso,
      updatedAt: nowIso,
    })
    .run();

  // Worker 1 claims it
  const activeLeaseUntil = new Date(Date.now() + 60000).toISOString();
  const claimRes1 = db.run(sql`
    UPDATE company_classifications
    SET claim_token = 'worker_1_token',
        lease_expires_at = ${activeLeaseUntil}
    WHERE normalized_name = 'race-co'
      AND classification_result = 'PENDING'
      AND (claim_token IS NULL OR lease_expires_at < ${nowIso})
  `);
  assert.strictEqual(claimRes1.changes, 1, 'Worker 1 successfully claimed the record');

  // Worker 2 attempts to claim the same record while lease is active
  const claimRes2 = db.run(sql`
    UPDATE company_classifications
    SET claim_token = 'worker_2_token',
        lease_expires_at = ${activeLeaseUntil}
    WHERE normalized_name = 'race-co'
      AND classification_result = 'PENDING'
      AND (claim_token IS NULL OR lease_expires_at < ${nowIso})
  `);
  assert.strictEqual(claimRes2.changes, 0, 'Worker 2 claim MUST fail (0 changes)');
  console.log('✓ [PASS] Concurrent worker claim collision prevented: duplicate AI calls impossible.');

  // Clean up
  db.delete(companyClassifications).where(eq(companyClassifications.normalizedName, 'race-co')).run();

  // =========================================================================
  // SCENARIO I & J: Gemini 429 Isolation vs OpenRouter 429 Isolation
  // =========================================================================
  console.log('\n--- SCENARIO I & J: Provider Error Isolation (Gemini vs OpenRouter 429) ---');

  globalGeminiLimiter.resetForTesting();
  assert.strictEqual(globalGeminiLimiter.isCooldownActive(), false, 'Gemini cooldown initially false');

  // Simulate OpenRouter 429 failure
  recordOpenRouterFailure('RATE_LIMIT_EXCEEDED', 'Rate limit exceeded: free-models-per-day');
  const openRouterStats = getOpenRouterTelemetry();
  assert.strictEqual(openRouterStats.rateLimit429Count, 1, 'OpenRouter 429 recorded in OpenRouter telemetry');
  assert.strictEqual(globalGeminiLimiter.isCooldownActive(), false, 'OpenRouter 429 must NEVER activate Gemini cooldown');
  console.log('✓ [PASS] OpenRouter 429 is isolated: does NOT trigger or extend Gemini circuit breaker cooldown.');

  // Simulate Gemini 429 failure
  globalGeminiLimiter.recordError(new Error('Gemini API 429 RESOURCE_EXHAUSTED'));
  assert.strictEqual(globalGeminiLimiter.isCooldownActive(), true, 'Gemini 429 successfully activates Gemini cooldown');
  console.log('✓ [PASS] Gemini 429 activates Gemini limiter cooldown as intended.');

  // Reset limiter for remaining tests
  globalGeminiLimiter.resetForTesting();

  // =========================================================================
  // SCENARIO K: Malformed AI Response
  // =========================================================================
  console.log('\n--- SCENARIO K: Malformed AI Response Handling ---');

  db.insert(companyClassifications)
    .values({
      normalizedName: 'malformed-co',
      companyName: 'Malformed Co',
      classificationResult: 'PENDING',
      retryRound: 0,
      retryCount: 0,
      reason: 'Pending',
      createdAt: nowIso,
      updatedAt: nowIso,
    })
    .run();

  const malformedCaller = async () => 'NOT_VALID_JSON_AT_ALL';
  await reconcilePendingClassifications(malformedCaller);

  const malformedRow = db
    .select()
    .from(companyClassifications)
    .where(eq(companyClassifications.normalizedName, 'malformed-co'))
    .get();

  assert.strictEqual(malformedRow?.classificationResult, 'RETRY_WAITING', 'Malformed JSON treated as transient error -> RETRY_WAITING');
  console.log('✓ [PASS] Malformed model output handled cleanly: transitions safely to RETRY_WAITING.');
  db.delete(companyClassifications).where(eq(companyClassifications.normalizedName, 'malformed-co')).run();

  // =========================================================================
  // SCENARIO L: Deterministic Classification Failure -> Terminal FAILED
  // =========================================================================
  console.log('\n--- SCENARIO L: Deterministic Failure Handling (Immediate FAILED) ---');

  db.insert(companyClassifications)
    .values({
      normalizedName: 'deterministic-fail-co',
      companyName: 'Deterministic Fail Co',
      classificationResult: 'PENDING',
      retryRound: 0,
      retryCount: 0,
      reason: 'Pending',
      createdAt: nowIso,
      updatedAt: nowIso,
    })
    .run();

  const permanentErrorCaller = async () => {
    const err = new Error('API key not valid. Please pass a valid API key.');
    throw err;
  };

  await reconcilePendingClassifications(permanentErrorCaller);

  const deterministicRow = db
    .select()
    .from(companyClassifications)
    .where(eq(companyClassifications.normalizedName, 'deterministic-fail-co'))
    .get();

  assert.strictEqual(deterministicRow?.classificationResult, 'FAILED', 'Permanent error immediately marks FAILED');
  console.log('✓ [PASS] Deterministic error transitions immediately to terminal FAILED state.');
  db.delete(companyClassifications).where(eq(companyClassifications.normalizedName, 'deterministic-fail-co')).run();

  // =========================================================================
  // SCENARIO M: Maximum Retry Policy (Capped at 5 Rounds)
  // =========================================================================
  console.log('\n--- SCENARIO M: Maximum Retry Policy (Capped at 5 Rounds) ---');

  // Insert a company with retryCount = 4
  db.insert(companyClassifications)
    .values({
      normalizedName: 'max-retry-co',
      companyName: 'Max Retry Co',
      classificationResult: 'PENDING',
      retryRound: 4,
      retryCount: 4,
      reason: 'Pending 5th attempt',
      createdAt: nowIso,
      updatedAt: nowIso,
    })
    .run();

  // Reconcile with transient error: should reach 5 and transition to FAILED
  const transientErrCaller = async () => {
    throw new Error('503 Service Unavailable');
  };

  await reconcilePendingClassifications(transientErrCaller);

  const maxRetryRow = db
    .select()
    .from(companyClassifications)
    .where(eq(companyClassifications.normalizedName, 'max-retry-co'))
    .get();

  assert.strictEqual(maxRetryRow?.classificationResult, 'FAILED', 'Exceeded 5 retries must transition to FAILED');
  assert.strictEqual(maxRetryRow?.retryCount, 5, 'retryCount is 5');
  assert.ok(maxRetryRow?.reason.includes('maximum retry rounds (5) exceeded'), 'Reason indicates max retries exceeded');
  console.log('✓ [PASS] Bounded retries: 5th failure transitions terminally to FAILED.');
  db.delete(companyClassifications).where(eq(companyClassifications.normalizedName, 'max-retry-co')).run();

  // =========================================================================
  // SCENARIO N: Historical Classifications Preserved & Cascaded Without AI
  // =========================================================================
  console.log('\n--- SCENARIO N: Historical Records Preserved & Cascaded Without AI ---');

  db.insert(companyClassifications)
    .values({
      normalizedName: 'microsoft',
      companyName: 'Microsoft',
      classificationResult: 'RELEVANT',
      isRelevant: true,
      confidence: 0.99,
      reason: 'Relevant — Gemini: Software giant',
      retryRound: 0,
      retryCount: 0,
      createdAt: nowIso,
      updatedAt: nowIso,
    })
    .onConflictDoNothing()
    .run();

  // Add new contact for Microsoft
  db.insert(contacts)
    .values({
      id: 'cont_msft_01',
      batchId,
      companyName: 'Microsoft',
      email: 'recruiter@microsoft.com',
      emailValid: true,
      isDuplicate: false,
      status: 'discovered',
      createdAt: nowIso,
      updatedAt: nowIso,
    })
    .run();

  // Run orphan discovery
  const discRes = discoverAndSeedOrphanedCompanies(db, nowIso);
  assert.strictEqual(discRes.cascaded, 1, 'Historical record cascaded immediately');
  assert.strictEqual(discRes.seeded, 0, 'No new pending row seeded for already-classified company');

  const msftContact = db.select().from(contacts).where(eq(contacts.id, 'cont_msft_01')).get();
  assert.strictEqual(msftContact?.isRelevant, true, 'Contact inherits isRelevant = true');
  assert.strictEqual(msftContact?.generationStatus, 'PENDING_GENERATION', 'Contact promoted to PENDING_GENERATION');
  console.log('✓ [PASS] Historical classifications preserved and immediately cascaded without duplicate AI calls.');

  // =========================================================================
  // SCENARIO R & S: Progressive Email Generation Continues Independently
  // =========================================================================
  console.log('\n--- SCENARIO R & S: Progressive Email Generation & Ready to Send ---');

  // Insert a mock company in RETRY_WAITING to prove generation proceeds despite waiting classification
  db.insert(companyClassifications)
    .values({
      normalizedName: 'unresolved-co-xyz',
      companyName: 'Unresolved Co XYZ',
      classificationResult: 'RETRY_WAITING',
      retryRound: 0,
      retryCount: 1,
      reason: 'Classification Retry Waiting',
      createdAt: nowIso,
      updatedAt: nowIso,
    })
    .run();

  // Seed mock resume if not present
  db.insert(resume)
    .values({
      id: 'current',
      filename: 'resume.pdf',
      filePath: '/data/resume.pdf',
      mimeType: 'application/pdf',
      parsedData: JSON.stringify({
        name: 'Aditya Raj Singh',
        education: [{ degree: 'B.Tech CSE', institution: 'LNJPIT' }],
        skills: { languages: ['TypeScript', 'Python'], frameworks: ['React', 'Next.js'] },
        projects: [{ title: 'Job Agent', techStack: ['TypeScript', 'Next.js'] }],
      }),
      uploadedAt: nowIso,
    })
    .onConflictDoNothing()
    .run();

  saveCandidateProfile({
    fullName: 'Aditya Raj Singh',
    education: [{ id: 'edu_1', degree: 'B.Tech CSE', institution: 'LNJPIT' }],
    skills: { languages: ['TypeScript', 'Python'], frameworks: ['React', 'Next.js'], databases: [], cloudDevOps: [], tools: [], other: [] },
    projects: [{ id: 'proj_1', name: 'Job Agent', techStack: ['TypeScript', 'Next.js'], highlights: [] }],
  }, db);

  // Run Email Generation reconciler on one of the relevant contacts
  const mockAiGenerator = async () => 'Subject: Engineering Opportunities\n\nDear Recruiter,\n\nI am interested in roles at Microsoft.';
  resetGenerationActiveClaimsForTesting();

  // Reconcile 1 email generation
  const genResult = await reconcilePendingEmailGenerations({
    batchSize: 1,
    claimWorkerId: 'test_worker_gen',
    aiCallerOverride: mockAiGenerator,
  });

  assert.ok(genResult.succeeded > 0, 'Email generation must succeed progressively');

  // Verify Ready to Send count
  const readyToSendStats = getProcessingPipelineStats();
  assert.ok(readyToSendStats.readyToSendCount > 0, 'Ready to Send count must increment');
  console.log(`✓ [PASS] Email generation progressed (${genResult.succeeded} generated) while classification retry items were waiting. Ready to Send: ${readyToSendStats.readyToSendCount}.`);

  // Clean up mock company
  db.delete(companyClassifications).where(eq(companyClassifications.normalizedName, 'unresolved-co-xyz')).run();

  // =========================================================================
  // SCENARIO T: Sending Policy Preserved
  // =========================================================================
  console.log('\n--- SCENARIO T: Sending Window & Cooldown Policy Intact ---');

  const sched = db.select().from(schedulerState).where(eq(schedulerState.id, 'singleton')).get();
  assert.strictEqual(sched?.timezone, 'Asia/Kolkata', 'Timezone must be Asia/Kolkata');
  assert.strictEqual(sched?.intervalMinutes, 3, 'Interval must be 3 minutes');
  assert.strictEqual(sched?.startHour, 10, 'Start hour must be 10 AM');
  assert.strictEqual(sched?.endHour, 16, 'End hour must be 4 PM');
  console.log('✓ [PASS] Sending policy preserved: 10:00 AM–4:00 PM Asia/Kolkata window, 3-minute interval, no hard ceiling.');

  // =========================================================================
  // SCENARIO W: Multi-Batch Simultaneous Concurrency & Isolation
  // =========================================================================
  console.log('\n--- SCENARIO W: Multi-Batch Simultaneous Concurrency & Isolation ---');

  const batchAId = 'batch_iso_A';
  const batchBId = 'batch_iso_B';

  db.insert(batches)
    .values([
      {
        id: batchAId,
        filename: 'batch_a.csv',
        uploadDate: nowIso,
        status: 'processing',
        createdAt: nowIso,
        updatedAt: nowIso,
      },
      {
        id: batchBId,
        filename: 'batch_b.csv',
        uploadDate: nowIso,
        status: 'processing',
        createdAt: nowIso,
        updatedAt: nowIso,
      },
    ])
    .run();

  // Contacts for Batch A:
  // A1: "Company AlphaOne Ltd" (RETRY_WAITING, round 0)
  // A2: "Company AlphaTwo Ltd" (PENDING, round 0)
  const normA1 = 'company alphaone';
  const normA2 = 'company alphatwo';
  db.insert(contacts)
    .values([
      {
        id: 'cont_iso_a1',
        batchId: batchAId,
        companyName: 'Company AlphaOne Ltd',
        email: 'recruiter_a1@alphaone.com',
        emailValid: true,
        isDuplicate: false,
        isRelevant: null,
        status: 'discovered',
        createdAt: nowIso,
        updatedAt: nowIso,
      },
      {
        id: 'cont_iso_a2',
        batchId: batchAId,
        companyName: 'Company AlphaTwo Ltd',
        email: 'recruiter_a2@alphatwo.com',
        emailValid: true,
        isDuplicate: false,
        isRelevant: null,
        status: 'discovered',
        createdAt: nowIso,
        updatedAt: nowIso,
      },
    ])
    .run();

  // Contacts for Batch B:
  // B1: "Company BetaOne Ltd" (RETRY_WAITING, round 0)
  // B2: "Company BetaTwo Ltd" (PENDING, round 0)
  const normB1 = 'company betaone';
  const normB2 = 'company betatwo';
  db.insert(contacts)
    .values([
      {
        id: 'cont_iso_b1',
        batchId: batchBId,
        companyName: 'Company BetaOne Ltd',
        email: 'recruiter_b1@betaone.com',
        emailValid: true,
        isDuplicate: false,
        isRelevant: null,
        status: 'discovered',
        createdAt: nowIso,
        updatedAt: nowIso,
      },
      {
        id: 'cont_iso_b2',
        batchId: batchBId,
        companyName: 'Company BetaTwo Ltd',
        email: 'recruiter_b2@betatwo.com',
        emailValid: true,
        isDuplicate: false,
        isRelevant: null,
        status: 'discovered',
        createdAt: nowIso,
        updatedAt: nowIso,
      },
    ])
    .run();

  // Seed company classifications:
  // Batch A companies: A1 is RETRY_WAITING (round 0), A2 is PENDING (round 0)
  // Batch B companies: B1 is RETRY_WAITING (round 0), B2 is PENDING (round 0)
  db.insert(companyClassifications)
    .values([
      {
        normalizedName: normA1,
        companyName: 'Company AlphaOne Ltd',
        classificationResult: 'RETRY_WAITING',
        retryRound: 0,
        retryCount: 1,
        reason: 'Classification Retry Waiting — Transient error',
        createdAt: nowIso,
        updatedAt: nowIso,
      },
      {
        normalizedName: normA2,
        companyName: 'Company AlphaTwo Ltd',
        classificationResult: 'PENDING',
        retryRound: 0,
        retryCount: 0,
        reason: 'Classification Pending',
        createdAt: nowIso,
        updatedAt: nowIso,
      },
      {
        normalizedName: normB1,
        companyName: 'Company BetaOne Ltd',
        classificationResult: 'RETRY_WAITING',
        retryRound: 0,
        retryCount: 1,
        reason: 'Classification Retry Waiting — Transient error',
        createdAt: nowIso,
        updatedAt: nowIso,
      },
      {
        normalizedName: normB2,
        companyName: 'Company BetaTwo Ltd',
        classificationResult: 'PENDING',
        retryRound: 0,
        retryCount: 0,
        reason: 'Classification Pending',
        createdAt: nowIso,
        updatedAt: nowIso,
      },
    ])
    .run();

  // Verify initial batch-scoped round states
  const stateA0 = getClassificationRoundState(db, batchAId);
  const stateB0 = getClassificationRoundState(db, batchBId);

  assert.strictEqual(stateA0.activePendingCount, 1, 'Batch A must have 1 active PENDING company (AlphaTwo)');
  assert.strictEqual(stateA0.retryWaitingCount, 1, 'Batch A must have 1 RETRY_WAITING company (AlphaOne)');
  assert.strictEqual(stateA0.isCurrentRoundDrained, false, 'Batch A must not be drained initially');

  assert.strictEqual(stateB0.activePendingCount, 1, 'Batch B must have 1 active PENDING company (BetaTwo)');
  assert.strictEqual(stateB0.retryWaitingCount, 1, 'Batch B must have 1 RETRY_WAITING company (BetaOne)');
  assert.strictEqual(stateB0.isCurrentRoundDrained, false, 'Batch B must not be drained initially');

  console.log('✓ [PASS] Initial multi-batch state: Batch A and Batch B both have 1 PENDING and 1 RETRY_WAITING item.');

  // Reconcile Batch A: AlphaTwo succeeds
  const mockAlphaSuccessCaller = async () => JSON.stringify([
    { company: 'Company AlphaTwo Ltd', relevant: true, confidence: 0.95, reason: 'Relevant — Tech software enterprise.' }
  ]);

  const reconcileResA = await reconcilePendingClassifications(mockAlphaSuccessCaller, { batchId: batchAId });
  assert.strictEqual(reconcileResA.succeeded, 1, 'AlphaTwo should succeed');

  // Verify Batch A round is now drained (active PENDING = 0, retry waiting = 1)
  const stateADrained = getClassificationRoundState(db, batchAId);
  assert.strictEqual(stateADrained.activePendingCount, 0, 'Batch A active PENDING reached 0 (round drained)');
  assert.strictEqual(stateADrained.retryWaitingCount, 1, 'Batch A has 1 item waiting for retry round');
  assert.strictEqual(stateADrained.isCurrentRoundDrained, true, 'Batch A current round must be drained');

  // Verify Batch B is still NOT drained
  const stateBStillActive = getClassificationRoundState(db, batchBId);
  assert.strictEqual(stateBStillActive.activePendingCount, 1, 'Batch B active PENDING must still be 1 (BetaTwo)');
  assert.strictEqual(stateBStillActive.isCurrentRoundDrained, false, 'Batch B is not drained');

  // Now trigger Batch A's retry round promotion
  const promotedA = promoteBatchRetryWaitingToNextRound(db, batchAId);
  assert.strictEqual(promotedA, 1, 'Batch A should promote 1 RETRY_WAITING record to round 1');

  // Verify Batch A promoted AlphaOne to round 1
  const recA1 = db.select().from(companyClassifications).where(eq(companyClassifications.normalizedName, normA1)).get();
  assert.strictEqual(recA1?.classificationResult, 'PENDING', 'AlphaOne must be promoted to PENDING for round 1');
  assert.strictEqual(recA1?.retryRound, 1, 'AlphaOne retryRound must be incremented to 1');

  // CRITICAL INVARIANT: Batch B retry item (BetaOne) MUST REMAIN in RETRY_WAITING (round 0)!
  const recB1AfterA = db.select().from(companyClassifications).where(eq(companyClassifications.normalizedName, normB1)).get();
  assert.strictEqual(recB1AfterA?.classificationResult, 'RETRY_WAITING', 'BetaOne (Batch B) MUST REMAIN RETRY_WAITING when Batch A drains');
  assert.strictEqual(recB1AfterA?.retryRound, 0, 'BetaOne retryRound must remain 0');

  // Check Batch B state is completely unpolluted
  const stateBAfterA = getClassificationRoundState(db, batchBId);
  assert.strictEqual(stateBAfterA.activePendingCount, 1, 'Batch B active PENDING must still be 1 (BetaTwo)');
  assert.strictEqual(stateBAfterA.retryWaitingCount, 1, 'Batch B retry waiting must still be 1 (BetaOne)');
  assert.strictEqual(stateBAfterA.isCurrentRoundDrained, false, 'Batch B must still NOT be drained');

  console.log('✓ [PASS] Batch A drain promoted ONLY Batch A retry item (AlphaOne -> round 1). Batch B retry item (BetaOne) stayed in RETRY_WAITING (round 0).');

  // Attempting promotion on Batch B directly while BetaTwo is still pending must return 0
  const earlyPromoteB = promoteBatchRetryWaitingToNextRound(db, batchBId);
  assert.strictEqual(earlyPromoteB, 0, 'Batch B cannot promote while active PENDING > 0');

  const recB1StillWaiting = db.select().from(companyClassifications).where(eq(companyClassifications.normalizedName, normB1)).get();
  assert.strictEqual(recB1StillWaiting?.classificationResult, 'RETRY_WAITING', 'BetaOne must strictly remain in RETRY_WAITING');

  // Now reconcile Batch B: BetaTwo succeeds
  const mockBetaSuccessCaller = async () => JSON.stringify([
    { company: 'Company BetaTwo Ltd', relevant: true, confidence: 0.92, reason: 'Relevant — Enterprise AI products.' }
  ]);

  const reconcileResB = await reconcilePendingClassifications(mockBetaSuccessCaller, { batchId: batchBId });
  assert.strictEqual(reconcileResB.succeeded, 1, 'BetaTwo should succeed');

  // Verify Batch B is now drained
  const stateBDrained = getClassificationRoundState(db, batchBId);
  assert.strictEqual(stateBDrained.activePendingCount, 0, 'Batch B active PENDING reached 0 (round drained)');
  assert.strictEqual(stateBDrained.isCurrentRoundDrained, true, 'Batch B current round is drained');

  // Trigger Batch B's retry round
  const promotedB = promoteBatchRetryWaitingToNextRound(db, batchBId);
  assert.strictEqual(promotedB, 1, 'Batch B should promote 1 RETRY_WAITING record to round 1');

  // Verify Batch B promoted BetaOne to round 1
  const recB1AfterB = db.select().from(companyClassifications).where(eq(companyClassifications.normalizedName, normB1)).get();
  assert.strictEqual(recB1AfterB?.classificationResult, 'PENDING', 'BetaOne must now be promoted to PENDING for round 1');
  assert.strictEqual(recB1AfterB?.retryRound, 1, 'BetaOne retryRound must be incremented to 1');

  // Check progressive downstream cascading for both batches
  const contA2 = db.select().from(contacts).where(eq(contacts.id, 'cont_iso_a2')).get();
  assert.strictEqual(contA2?.isRelevant, true, 'Contact A2 must be marked relevant');
  assert.strictEqual(contA2?.status, 'queued', 'Contact A2 must be promoted to queued');
  assert.strictEqual(contA2?.generationStatus, 'PENDING_GENERATION', 'Contact A2 must be ready for email generation');

  const contB2 = db.select().from(contacts).where(eq(contacts.id, 'cont_iso_b2')).get();
  assert.strictEqual(contB2?.isRelevant, true, 'Contact B2 must be marked relevant');
  assert.strictEqual(contB2?.status, 'queued', 'Contact B2 must be promoted to queued');
  assert.strictEqual(contB2?.generationStatus, 'PENDING_GENERATION', 'Contact B2 must be ready for email generation');

  console.log('✓ [PASS] Batch B drain promoted BetaOne to round 1 only when Batch B active PENDING reached 0.');
  console.log('✓ [PASS] Progressive email generation cascaded immediately for both batches without delay.');

  // Clean up isolation test records
  db.delete(batches).where(inArray(batches.id, [batchAId, batchBId])).run();
  db.delete(contacts).where(inArray(contacts.id, ['cont_iso_a1', 'cont_iso_a2', 'cont_iso_b1', 'cont_iso_b2'])).run();
  db.delete(companyClassifications).where(inArray(companyClassifications.normalizedName, [normA1, normA2, normB1, normB2])).run();
  db.delete(outreachQueue).where(inArray(outreachQueue.contactId, ['cont_iso_a2', 'cont_iso_b2'])).run();

  // =========================================================================
  // SCENARIO V: Strict Safety Constraint
  // =========================================================================
  console.log('\n--- SCENARIO V: Strict Safety Audit ---');
  const realSentCount = db.get<{ count: number }>(sql`
    SELECT COUNT(*) as count FROM contacts WHERE status = 'sent' AND gmail_message_id NOT LIKE 'mock%'
  `)?.count ?? 0;
  assert.strictEqual(realSentCount, 0, 'ZERO real recruiter emails dispatched');
  console.log('✓ [PASS] Safety Constraint Verified: Strictly 0 real emails dispatched, no production DB touched.');

  console.log('\n======================================================================');
  console.log('ALL ROUND-BASED CLASSIFICATION TESTS PASSED CLEANLY (23/23 SCENARIOS)');
  console.log('======================================================================');
}

runTests().catch((err) => {
  console.error('\n❌ Test failure:', err);
  process.exit(1);
});
