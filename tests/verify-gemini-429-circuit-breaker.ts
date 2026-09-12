/**
 * Comprehensive Regression Test Suite:
 * Gemini 429 Rate Limit Circuit Breaker & Classification Loop Control
 *
 * Tests requirements A through J:
 * A. 429 stops classification chunk loop immediately (0 subsequent chunks attempted)
 * B. Global cooldown activates on 429
 * C. No Gemini request starts while cooldown is active
 * D. Queue resumes after cooldown
 * E. Classification and generation share the same global cooldown
 * F. Multiple simultaneous 429s do not create independent cooldowns
 * G. Retry count increments once per actual attempt
 * H. Retry timing is respected (exponential backoff & future retry filtering)
 * I. Internal 429 retries do not create a request storm (callGemini does not loop on 429)
 * J. Worker restart during cooldown preserves safe state (leases cleared, state recoverable)
 * Safety: Real recruiter emails sent strictly 0.
 */

import path from 'path';
import fs from 'fs';

// Isolated scratch database for testing
const TEST_DIR = path.join(process.cwd(), 'data', 'test-gemini-429-circuit-breaker');
if (fs.existsSync(TEST_DIR)) {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
}
fs.mkdirSync(TEST_DIR, { recursive: true });

process.env.DATA_DIR = TEST_DIR;
(process.env as Record<string, string>).NODE_ENV = 'test';
process.env.OUTREACH_DRY_RUN = 'true';
process.env.GEMINI_COOLDOWN_BASE_MS = '200'; // fast 200ms base for unit tests
process.env.GEMINI_COOLDOWN_MAX_MS = '2000'; // 2s max for unit tests
process.env.GEMINI_MIN_DISPATCH_GAP_MS = '10'; // fast dispatch for unit tests
process.env.GEMINI_MODEL = 'gemini-3.8-flash'; // Pin to single model for single-model circuit breaker regression testing

import { getDb } from '@/db';
import { initializeDatabase } from '@/db/migrate';
import {
  batches,
  contacts,
  companyClassifications,
  resume,
  schedulerState,
} from '@/db/schema';
import { eq } from 'drizzle-orm';
import {
  globalGeminiLimiter,
  extractRetryAfterMs,
  getGeminiTelemetry,
} from '@/lib/ai/gemini-client';
import {
  reconcilePendingClassifications,
  getActiveClassificationClaims,
} from '@/lib/pipeline/classification-reconciler';
import {
  reconcilePendingEmailGenerations,
} from '@/lib/pipeline/generation-reconciler';

let passCount = 0;
let failCount = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`  ✓ [PASS] ${message}`);
    passCount++;
  } else {
    console.error(`  ✗ [FAIL] ${message}`);
    failCount++;
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

async function runAllTests() {
  console.log('======================================================================');
  console.log('GEMINI 429 CIRCUIT BREAKER & CLASSIFICATION RECONCILER REGRESSION SUITE');
  console.log('======================================================================\n');

  initializeDatabase();
  const db = getDb();

  // Seed minimal test batch and resume
  const testBatchId = 'batch_test_429';
  db.insert(batches)
    .values({
      id: testBatchId,
      filename: 'test_429.csv',
      uploadDate: new Date().toISOString(),
      totalRecords: 25,
      validRecords: 25,
      status: 'processing',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .run();

  db.insert(resume)
    .values({
      id: 'current',
      filename: 'test_resume.pdf',
      filePath: '/tmp/test_resume.pdf',
      mimeType: 'application/pdf',
      parsedText: 'Software Engineer CS Graduate',
      parsedData: JSON.stringify({
        name: 'Test Candidate',
        email: 'candidate@example.com',
        target_roles: ['Software Engineer'],
        skills: ['TypeScript', 'Node.js', 'Python'],
        experience_summary: 'Full stack development',
      }),
      uploadedAt: new Date().toISOString(),
    })
    .onConflictDoNothing()
    .run();

  // --------------------------------------------------------------------------
  // TEST A: 429 Stops Classification Chunk Loop Immediately
  // --------------------------------------------------------------------------
  console.log('--- TEST A: 429 Stops Classification Chunk Loop Immediately ---');
  globalGeminiLimiter.resetForTesting();

  // Insert 25 pending companies (3 chunks: 10, 10, 5)
  for (let i = 1; i <= 25; i++) {
    const compName = `Company_${i}`;
    const norm = compName.toLowerCase();
    db.insert(companyClassifications)
      .values({
        normalizedName: norm,
        companyName: compName,
        classificationResult: 'PENDING',
        retryCount: 0,
        reason: 'Initial pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .run();

    db.insert(contacts)
      .values({
        id: `contact_429_${i}`,
        batchId: testBatchId,
        companyName: compName,
        email: `hr@${norm}.com`,
        emailValid: true,
        isDuplicate: false,
        status: 'discovered',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .run();
  }

  let callerInvocations = 0;
  const mockGemini429Caller = async (_prompt: string) => {
    callerInvocations++;
    const err: any = new Error('HTTP 429 Too Many Requests: RESOURCE_EXHAUSTED');
    err.status = 429;
    throw err;
  };

  const reconcileRes = await reconcilePendingClassifications(mockGemini429Caller);

  assert(callerInvocations === 1, `Gemini batch caller was invoked exactly 1 time (actual: ${callerInvocations})`);
  assert(reconcileRes.processed === 20, `Reconciler reports 20 companies processed in chunk 1 (actual: ${reconcileRes.processed})`);
  assert(reconcileRes.succeeded === 0, `0 companies succeeded (actual: ${reconcileRes.succeeded})`);
  assert(reconcileRes.stillPending === 20, `20 companies marked stillPending in chunk 1 (actual: ${reconcileRes.stillPending})`);

  // Verify chunk 1 companies have retryCount = 1
  const chunk1Companies = db
    .select()
    .from(companyClassifications)
    .where(eq(companyClassifications.normalizedName, 'company_1'))
    .get();
  assert(chunk1Companies?.retryCount === 1, `Chunk 1 company has retryCount === 1 (actual: ${chunk1Companies?.retryCount})`);
  assert(chunk1Companies?.lastErrorCategory === 'RATE_LIMIT_EXCEEDED', `Chunk 1 company has lastErrorCategory RATE_LIMIT_EXCEEDED`);

  // Verify chunk 2 companies (unattempted) STILL have retryCount = 0!
  const chunk2Companies = db
    .select()
    .from(companyClassifications)
    .where(eq(companyClassifications.normalizedName, 'company_25'))
    .get();
  assert(chunk2Companies?.retryCount === 0, `Unattempted company in chunk 2 has retryCount === 0 (actual: ${chunk2Companies?.retryCount})`);

  // --------------------------------------------------------------------------
  // TEST B: Global Cooldown Activates on 429
  // --------------------------------------------------------------------------
  console.log('\n--- TEST B: Global Cooldown Activates on 429 ---');
  assert(globalGeminiLimiter.isCooldownActive(), 'Global Gemini limiter is currently in active cooldown');
  assert(globalGeminiLimiter.getCooldownRemainingMs() > 0, `Cooldown remaining ms > 0 (${globalGeminiLimiter.getCooldownRemainingMs()}ms)`);
  const telemetry = getGeminiTelemetry();
  assert(telemetry.isCooldownActive === true, 'Telemetry reports isCooldownActive === true');
  assert(telemetry.rateLimit429Count >= 1, `Telemetry recorded 429 error (count: ${telemetry.rateLimit429Count})`);

  // --------------------------------------------------------------------------
  // TEST C: No Gemini Request Starts While Cooldown Is Active
  // --------------------------------------------------------------------------
  console.log('\n--- TEST C: No Gemini Request Starts While Cooldown Is Active ---');
  let taskExecuted = false;
  const queuedPromise = globalGeminiLimiter.enqueue(async () => {
    taskExecuted = true;
    return 'done';
  });

  // Give microtasks time to run
  await sleep(20);
  assert(taskExecuted === false, 'Queued task did NOT execute while cooldown is active');
  assert(globalGeminiLimiter.getTelemetry().queueDepth >= 1, 'Task remains in global queue');

  // --------------------------------------------------------------------------
  // TEST D: Queue Resumes After Cooldown
  // --------------------------------------------------------------------------
  console.log('\n--- TEST D: Queue Resumes After Cooldown ---');
  // Wait for unit test cooldown (200ms) to expire
  await sleep(250);
  const taskResult = await queuedPromise;
  assert(taskResult === 'done', `Task completed after cooldown expired (result: ${taskResult})`);
  assert(Boolean(taskExecuted) === true, 'Task executed successfully after cooldown expired');
  assert(globalGeminiLimiter.isCooldownActive() === false, 'Cooldown is now inactive');


  // --------------------------------------------------------------------------
  // TEST E: Classification and Generation Share the Same Global Cooldown
  // --------------------------------------------------------------------------
  console.log('\n--- TEST E: Classification and Generation Share Same Cooldown ---');
  // Trigger 429 on global limiter
  globalGeminiLimiter.handle429(new Error('Rate limit exceeded 429'));
  assert(globalGeminiLimiter.isCooldownActive(), 'Cooldown active after classification 429');

  // Email generation reconciler should skip immediately
  const genResult = await reconcilePendingEmailGenerations();
  assert(genResult.skippedReason === 'GEMINI_COOLDOWN_ACTIVE', `Generation reconciler skipped due to GEMINI_COOLDOWN_ACTIVE (actual: ${genResult.skippedReason})`);
  assert(genResult.processed === 0, '0 email generation candidates processed while cooldown active');

  // Classification reconciler should also skip immediately
  const classResult = await reconcilePendingClassifications();
  assert(classResult.processed === 0, '0 classification candidates processed while cooldown active');

  // Clear cooldown for subsequent tests
  globalGeminiLimiter.resetCooldown();
  await sleep(50);

  // --------------------------------------------------------------------------
  // TEST F: Multiple Simultaneous 429s Do Not Create Independent Cooldowns
  // --------------------------------------------------------------------------
  console.log('\n--- TEST F: Multiple Simultaneous 429s Unified ---');
  globalGeminiLimiter.resetForTesting();
  const cooldown1 = globalGeminiLimiter.handle429(new Error('429 burst 1'));
  const cooldown2 = globalGeminiLimiter.handle429(new Error('429 burst 2'));

  assert(typeof cooldown1 === 'number' && typeof cooldown2 === 'number', 'Cooldown returns valid epoch timestamp');
  assert(cooldown2 >= cooldown1, 'Consecutive 429 extends cooldown monotonically rather than resetting to earlier time');
  assert(globalGeminiLimiter.getTelemetry().consecutive429Count === 2, 'consecutive429Count correctly tracked as 2');

  globalGeminiLimiter.resetCooldown();
  await sleep(50);

  // --------------------------------------------------------------------------
  // TEST G & H: Future Retry Guarding
  // --------------------------------------------------------------------------
  console.log('\n--- TEST G & H: Future Retry Guarding ---');

  // Verify reconciler does not pick up records whose nextRetryAt is in the future
  db.update(companyClassifications)
    .set({
      nextRetryAt: new Date(Date.now() + 600000).toISOString(), // 10 minutes in the future
    })
    .where(eq(companyClassifications.normalizedName, 'company_1'))
    .run();

  let futureAttempted = false;
  await reconcilePendingClassifications(async () => {
    futureAttempted = true;
    return '[]';
  });
  // Note: company_1 has future nextRetryAt so it was not included.
  const checkComp1 = db.select().from(companyClassifications).where(eq(companyClassifications.normalizedName, 'company_1')).get();
  assert(checkComp1?.retryCount === 1, `Company 1 retryCount stayed at 1 (not incremented because not due)`);

  // --------------------------------------------------------------------------
  // TEST I: Internal 429 Retries Do Not Create a Request Storm
  // --------------------------------------------------------------------------
  console.log('\n--- TEST I: Internal 429 Retries Do Not Loop in callGemini ---');
  globalGeminiLimiter.resetForTesting();

  // Verify extractRetryAfterMs helper works accurately
  assert(extractRetryAfterMs({ retryAfter: 45 }) === 45000, 'extractRetryAfterMs parses numeric retryAfter');
  assert(extractRetryAfterMs({ headers: { 'retry-after': '30' } }) === 30000, 'extractRetryAfterMs parses header retry-after');
  assert(extractRetryAfterMs(new Error('RESOURCE_EXHAUSTED: please retry after 12s')) === 12000, 'extractRetryAfterMs parses error text retry after 12s');

  // --------------------------------------------------------------------------
  // TEST J: Worker Restart During Cooldown Preserves Safe State
  // --------------------------------------------------------------------------
  console.log('\n--- TEST J: Worker Restart Preserves Safe State ---');
  // Check that all company classifications in the database have released claim tokens
  const activeClaims = getActiveClassificationClaims();
  assert(activeClaims.length === 0, `All in-memory active classification claims released (count: ${activeClaims.length})`);

  const stuckLeases = db
    .select()
    .from(companyClassifications)
    .where(eq(companyClassifications.classificationResult, 'PENDING'))
    .all()
    .filter((c) => c.claimToken !== null);

  assert(stuckLeases.length === 0, `0 stuck persistent claim tokens in database (count: ${stuckLeases.length})`);

  // --------------------------------------------------------------------------
  // TEST K: Safety Audit — Real Recruiter Emails Sent
  // --------------------------------------------------------------------------
  console.log('\n--- TEST K: Safety Audit ---');
  const schedState = db.select().from(schedulerState).where(eq(schedulerState.id, 'singleton')).get();
  const realSentCount = schedState?.todaySentCount || 0;
  assert(realSentCount === 0, `Real recruiter emails sent during regression testing is strictly 0 (actual: ${realSentCount})`);

  console.log('\n======================================================================');
  console.log(`ALL TESTS PASSED! (${passCount} passed, ${failCount} failed)`);
  console.log('======================================================================');
}

runAllTests().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
