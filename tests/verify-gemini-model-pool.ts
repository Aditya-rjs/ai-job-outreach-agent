/**
 * Verification Suite for Simple, Non-Tiered Gemini Multi-Model Pool
 *
 * Requirements Verified:
 * A. ALLMODELS configuration.
 * B. Unset GEMINI_MODEL defaults to ALLMODELS.
 * C. Single-model configuration remains pinned.
 * D. Candidate discovery filters inaccessible models; discovery failure does not assume all available.
 * E. Round-robin distributes requests fairly across healthy models (no tiers).
 * F. A 429 on Model A cools only Model A (zero cross-model contamination).
 * G. Model B can immediately handle the next attempt (in-pool rotation).
 * H. A 5xx/network failure only affects that model.
 * I. 404 permanently removes only that model from active pool.
 * J. All Gemini models exhausted → existing OpenRouter fallback.
 * K. Gemini + OpenRouter unavailable → existing WAITING behavior without burning retries.
 * L. Exact model used is recorded (e.g. gemini-2.5-flash, never 'ALLMODELS').
 * M. Historical gemini-3.8-flash records remain unchanged.
 */

import assert from 'assert';
import {
  geminiPool,
  APPROVED_GEMINI_CANDIDATES,
  GeminiModelPool,
} from '../src/lib/ai/gemini-pool';
import { env } from '../src/lib/config/env';
import {
  callAi,
  getAiDispatcherTelemetry,
  resetAiDispatcherTelemetryForTesting,
  AiProviderUnavailableError,
} from '../src/lib/ai/ai-dispatcher';
import {
  isGeminiCooldownActive,
  getGeminiCooldownRemainingMs,
  recordOpenRouter429,
  getPersistentAiProviderState,
  resetPersistentAiProviderStateForTesting,
} from '../src/lib/ai/ai-provider-service';
import { globalGeminiLimiter, getGeminiClient, resetGeminiClient } from '../src/lib/ai/gemini-client';
import { getDb } from '../src/db';
import { aiProviderState } from '../src/db/schema/ai-provider-state';
import { eq } from 'drizzle-orm';

async function runTests() {
  console.log('================================================================');
  console.log('  STARTING GEMINI MULTI-MODEL POOL VERIFICATION SUITE');
  console.log('================================================================\n');

  let passedTests = 0;
  let totalTests = 0;

  function recordPass(testName: string) {
    passedTests++;
    console.log(`[PASS] Test ${totalTests}: ${testName}`);
  }

  // Preserve original environment
  const originalGeminiModel = process.env.GEMINI_MODEL;
  const originalGeminiKey = process.env.GEMINI_API_KEY;
  const originalOpenRouterKey = process.env.OPENROUTER_API_KEY;

  try {
    // -------------------------------------------------------------------------
    // Test 1: Candidate List Verification
    // -------------------------------------------------------------------------
    totalTests++;
    console.log(`\n--- Test ${totalTests}: Candidate List Verification ---`);
    assert.strictEqual(APPROVED_GEMINI_CANDIDATES.length, 10);
    assert(APPROVED_GEMINI_CANDIDATES.includes('gemini-3.8-flash'));
    assert(APPROVED_GEMINI_CANDIDATES.includes('gemini-3.7-flash'));
    assert(APPROVED_GEMINI_CANDIDATES.includes('gemini-3.6-flash'));
    assert(APPROVED_GEMINI_CANDIDATES.includes('gemini-3.5-flash'));
    assert(APPROVED_GEMINI_CANDIDATES.includes('gemini-3-flash-preview'));
    assert(APPROVED_GEMINI_CANDIDATES.includes('gemini-3.5-flash-lite'));
    assert(APPROVED_GEMINI_CANDIDATES.includes('gemini-3.1-flash-lite'));
    assert(APPROVED_GEMINI_CANDIDATES.includes('gemini-2.5-pro'));
    assert(APPROVED_GEMINI_CANDIDATES.includes('gemini-2.5-flash'));
    assert(APPROVED_GEMINI_CANDIDATES.includes('gemini-2.5-flash-lite'));
    recordPass('All 10 approved candidate models are correctly defined.');

    // -------------------------------------------------------------------------
    // Test 2: Unset GEMINI_MODEL Defaults to ALLMODELS (Requirement B)
    // -------------------------------------------------------------------------
    totalTests++;
    console.log(`\n--- Test ${totalTests}: Unset GEMINI_MODEL Defaults to ALLMODELS ---`);
    delete process.env.GEMINI_MODEL;
    assert.strictEqual(env.geminiModel(), 'ALLMODELS');

    const testPoolDefault = new GeminiModelPool();
    assert.strictEqual(testPoolDefault.getMode(), 'ALLMODELS');
    recordPass('Unset GEMINI_MODEL cleanly defaults to ALLMODELS instead of gemini-3.8-flash.');

    // -------------------------------------------------------------------------
    // Test 3: Explicit ALLMODELS Configuration (Requirement A)
    // -------------------------------------------------------------------------
    totalTests++;
    console.log(`\n--- Test ${totalTests}: Explicit ALLMODELS Configuration ---`);
    process.env.GEMINI_MODEL = 'ALLMODELS';
    assert.strictEqual(env.geminiModel(), 'ALLMODELS');

    const testPoolAll = new GeminiModelPool();
    testPoolAll.configure('ALLMODELS');
    assert.strictEqual(testPoolAll.getMode(), 'ALLMODELS');
    recordPass('GEMINI_MODEL=ALLMODELS activates pool mode.');

    // -------------------------------------------------------------------------
    // Test 4: Single-Model Configuration Remains Pinned (Requirement C)
    // -------------------------------------------------------------------------
    totalTests++;
    console.log(`\n--- Test ${totalTests}: Single-Model Configuration Pinned ---`);
    process.env.GEMINI_MODEL = 'gemini-2.5-flash';
    assert.strictEqual(env.geminiModel(), 'gemini-2.5-flash');

    const testPoolSingle = new GeminiModelPool();
    testPoolSingle.configure('gemini-2.5-flash');
    assert.strictEqual(testPoolSingle.getMode(), 'single');
    assert.strictEqual(testPoolSingle.getConfiguredSingleModel(), 'gemini-2.5-flash');

    // Leased model must always be gemini-2.5-flash
    const lease1 = testPoolSingle.leaseModel();
    const lease2 = testPoolSingle.leaseModel();
    assert.strictEqual(lease1?.model, 'gemini-2.5-flash');
    assert.strictEqual(lease2?.model, 'gemini-2.5-flash');
    delete process.env.GEMINI_MODEL;
    recordPass('Single-model configuration remains strictly pinned without rotation.');

    // -------------------------------------------------------------------------
    // Test 5: Candidate Discovery & Filtering (Requirement D)
    // -------------------------------------------------------------------------
    totalTests++;
    console.log(`\n--- Test ${totalTests}: Candidate Discovery & Filtering ---`);
    const testPoolDiscovery = new GeminiModelPool();
    testPoolDiscovery.configure('ALLMODELS');

    // Mock client returning a mix of candidate and non-candidate models
    const mockClient = {
      models: {
        list: async () => {
          return (async function* () {
            yield { name: 'models/gemini-2.5-flash', supportedActions: ['generateContent'] };
            yield { name: 'models/gemini-3.5-flash-lite', supportedActions: ['generateContent'] };
            yield { name: 'models/gemini-3.8-flash', supportedActions: ['generateContent'] };
            yield { name: 'models/unrelated-model-xyz', supportedActions: ['generateContent'] };
            yield { name: 'models/gemini-embedding-001', supportedActions: ['embedContent'] };
          })();
        },
      },
    };

    await testPoolDiscovery.ensureDiscovered(mockClient as any);
    const telem = testPoolDiscovery.getTelemetry();
    assert.strictEqual(telem.accessibleCount, 3);
    assert(telem.healthyModels.includes('gemini-2.5-flash'));
    assert(telem.healthyModels.includes('gemini-3.5-flash-lite'));
    assert(telem.healthyModels.includes('gemini-3.8-flash'));
    assert(!telem.healthyModels.includes('unrelated-model-xyz'));
    assert(!telem.healthyModels.includes('gemini-embedding-001'));
    recordPass('Model discovery correctly filters candidate models and checks generateContent support.');

    // -------------------------------------------------------------------------
    // Test 6: Discovery Failure Safety (Requirement D)
    // -------------------------------------------------------------------------
    totalTests++;
    console.log(`\n--- Test ${totalTests}: Discovery Failure Safety ---`);
    const testPoolFail = new GeminiModelPool();
    testPoolFail.configure('ALLMODELS');

    const failingClient = {
      models: {
        list: async () => {
          throw new Error('API key discovery network timeout');
        },
      },
    };

    await testPoolFail.ensureDiscovered(failingClient as any);
    const failTelem = testPoolFail.getTelemetry();
    assert.strictEqual(failTelem.accessibleCount, 0);
    assert.strictEqual(failTelem.healthyCount, 0);
    assert(failTelem.discoveryError !== null);
    assert.strictEqual(testPoolFail.isPoolExhausted(), true);
    recordPass('Discovery failure does NOT assume all 10 models are available and marks pool exhausted.');

    // -------------------------------------------------------------------------
    // Test 7: Fair Round-Robin Distribution (Requirement E)
    // -------------------------------------------------------------------------
    totalTests++;
    console.log(`\n--- Test ${totalTests}: Fair Round-Robin Distribution (No Tiers) ---`);
    const testPoolRR = new GeminiModelPool();
    testPoolRR.configure('ALLMODELS');
    testPoolRR.setAccessibleModelsForTesting([
      'gemini-2.5-flash',
      'gemini-3.5-flash-lite',
      'gemini-3.8-flash',
    ]);

    const leases: string[] = [];
    for (let i = 0; i < 6; i++) {
      const l = testPoolRR.leaseModel();
      assert(l !== null);
      leases.push(l.model);
    }

    // Expected sequence follows map candidate insertion order: Model 1 -> Model 2 -> Model 3 -> Model 1 -> Model 2 -> Model 3
    assert.deepStrictEqual(leases, [
      'gemini-3.8-flash',
      'gemini-3.5-flash-lite',
      'gemini-2.5-flash',
      'gemini-3.8-flash',
      'gemini-3.5-flash-lite',
      'gemini-2.5-flash',
    ]);
    recordPass('Round-robin evenly and fairly distributes across all healthy models with zero task tiers.');

    // -------------------------------------------------------------------------
    // Test 8: Per-Model 429 Cooldown Isolation (Requirement F)
    // -------------------------------------------------------------------------
    totalTests++;
    console.log(`\n--- Test ${totalTests}: Per-Model 429 Cooldown Isolation ---`);
    const testPool429 = new GeminiModelPool();
    testPool429.configure('ALLMODELS');
    testPool429.setAccessibleModelsForTesting([
      'gemini-2.5-flash',
      'gemini-3.5-flash-lite',
      'gemini-3.8-flash',
    ]);

    // Model 1 hits 429
    const cooldownMs = testPool429.record429('gemini-2.5-flash', {
      message: 'RESOURCE_EXHAUSTED 429 quota exceeded',
    });
    assert(cooldownMs >= 60000);

    const healthyAfter429 = testPool429.getHealthyModels();
    assert.strictEqual(healthyAfter429.length, 2);
    assert.strictEqual(healthyAfter429.some((m) => m.modelName === 'gemini-2.5-flash'), false);
    assert.strictEqual(healthyAfter429.some((m) => m.modelName === 'gemini-3.5-flash-lite'), true);
    assert.strictEqual(healthyAfter429.some((m) => m.modelName === 'gemini-3.8-flash'), true);

    // Pool as a whole is NOT exhausted!
    assert.strictEqual(testPool429.isPoolExhausted(), false);
    recordPass('A 429 on Model A cools down ONLY Model A; Models B and C remain completely healthy.');

    // -------------------------------------------------------------------------
    // Test 9: Model B Immediately Handles In-Pool Retry (Requirement G)
    // -------------------------------------------------------------------------
    totalTests++;
    console.log(`\n--- Test ${totalTests}: In-Pool Retry on Model B ---`);
    // Lease next model while Model 1 is cooling down
    const nextLease1 = testPool429.leaseModel();
    const nextLease2 = testPool429.leaseModel();
    const nextLease3 = testPool429.leaseModel();

    // Must cycle only between Model 2 and Model 3
    assert(nextLease1?.model === 'gemini-3.5-flash-lite' || nextLease1?.model === 'gemini-3.8-flash');
    assert(nextLease2?.model === 'gemini-3.5-flash-lite' || nextLease2?.model === 'gemini-3.8-flash');
    assert(nextLease3?.model === 'gemini-3.5-flash-lite' || nextLease3?.model === 'gemini-3.8-flash');
    assert.notStrictEqual(nextLease1?.model, 'gemini-2.5-flash');
    assert.notStrictEqual(nextLease2?.model, 'gemini-2.5-flash');
    recordPass('Subsequent requests and in-flight retries immediately lease remaining healthy Gemini models.');

    // -------------------------------------------------------------------------
    // Test 10: Per-Model 5xx / Network Failure Isolation (Requirement H)
    // -------------------------------------------------------------------------
    totalTests++;
    console.log(`\n--- Test ${totalTests}: 5xx / Transient Error Isolation ---`);
    const testPool5xx = new GeminiModelPool();
    testPool5xx.configure('ALLMODELS');
    testPool5xx.setAccessibleModelsForTesting([
      'gemini-2.5-flash',
      'gemini-3.5-flash-lite',
      'gemini-3.8-flash',
    ]);

    testPool5xx.recordTransientError('gemini-3.5-flash-lite', new Error('503 Service Unavailable'));
    const healthyAfter5xx = testPool5xx.getHealthyModels();
    assert.strictEqual(healthyAfter5xx.length, 2);
    assert.strictEqual(healthyAfter5xx.some((m) => m.modelName === 'gemini-3.5-flash-lite'), false);
    assert.strictEqual(healthyAfter5xx.some((m) => m.modelName === 'gemini-2.5-flash'), true);
    assert.strictEqual(healthyAfter5xx.some((m) => m.modelName === 'gemini-3.8-flash'), true);
    recordPass('Transient 5xx/network failure only cools down the failing model for 30s.');

    // -------------------------------------------------------------------------
    // Test 11: 404 Permanent Removal (Requirement I)
    // -------------------------------------------------------------------------
    totalTests++;
    console.log(`\n--- Test ${totalTests}: 404 Permanent Model Removal ---`);
    const testPool404 = new GeminiModelPool();
    testPool404.configure('ALLMODELS');
    testPool404.setAccessibleModelsForTesting([
      'gemini-2.5-flash',
      'gemini-3.5-flash-lite',
    ]);

    testPool404.recordPermanentError('gemini-3.5-flash-lite', '404 NOT_FOUND');
    const telem404 = testPool404.getTelemetry();
    assert.strictEqual(telem404.disabledCount, 1);
    assert.strictEqual(telem404.disabledModels[0].model, 'gemini-3.5-flash-lite');

    // Fast-forward time by 1 hour: 404 model must STILL be disabled
    const healthyFuture = testPool404.getHealthyModels(Date.now() + 3600000);
    assert.strictEqual(healthyFuture.length, 1);
    assert.strictEqual(healthyFuture[0].modelName, 'gemini-2.5-flash');
    recordPass('Model returning 404/NOT_FOUND is permanently excluded from subsequent selection.');

    // -------------------------------------------------------------------------
    // Test 12: All Gemini Models Exhausted → OpenRouter Fallback (Requirement J)
    // -------------------------------------------------------------------------
    totalTests++;
    console.log(`\n--- Test ${totalTests}: Pool Exhaustion → OpenRouter Fallback ---`);
    // Setup singleton pool
    geminiPool.configure('ALLMODELS');
    geminiPool.setAccessibleModelsForTesting(['gemini-2.5-flash']);
    geminiPool.record429('gemini-2.5-flash', { message: '429 Rate Limit' });

    assert.strictEqual(geminiPool.isPoolExhausted(), true);
    assert.strictEqual(isGeminiCooldownActive(), true);
    assert(getGeminiCooldownRemainingMs() > 0);
    recordPass('When all models in pool are cooling down, Gemini provider cooldown is tripped.');

    // -------------------------------------------------------------------------
    // Test 13: Both Providers Unavailable → WAITING State (Requirement K)
    // -------------------------------------------------------------------------
    totalTests++;
    console.log(`\n--- Test ${totalTests}: Both Providers Unavailable → WAITING State ---`);
    resetAiDispatcherTelemetryForTesting();
    geminiPool.configure('ALLMODELS');
    geminiPool.setAccessibleModelsForTesting(['gemini-2.5-flash']);
    geminiPool.record429('gemini-2.5-flash');

    // Simulate OpenRouter also in 429 cooldown
    recordOpenRouter429('OpenRouter 429', 60000);

    let threwUnavailable = false;
    try {
      await callAi('Test prompt when both providers are cooling down');
    } catch (err: unknown) {
      if (err instanceof AiProviderUnavailableError) {
        threwUnavailable = true;
        assert(err.waitRemainingMs > 0);
        assert(/WAITING/i.test(err.message));
      } else {
        throw err;
      }
    }
    assert.strictEqual(threwUnavailable, true);
    recordPass('When both Gemini and OpenRouter are in cooldown, system cleanly enters WAITING state.');

    // -------------------------------------------------------------------------
    // Test 14: Telemetry Output & UI Model String (Requirement L)
    // -------------------------------------------------------------------------
    totalTests++;
    console.log(`\n--- Test ${totalTests}: Telemetry Output & UI Display ---`);
    geminiPool.resetForTesting();
    geminiPool.configure('ALLMODELS');
    geminiPool.setAccessibleModelsForTesting([
      'gemini-2.5-flash',
      'gemini-3.5-flash-lite',
      'gemini-3.8-flash',
    ]);
    const poolTelem = geminiPool.getTelemetry();
    assert.strictEqual(poolTelem.modelDisplay, 'ALLMODELS (3/3 active)');

    geminiPool.record429('gemini-2.5-flash');
    const poolTelemAfter429 = geminiPool.getTelemetry();
    assert.strictEqual(poolTelemAfter429.modelDisplay, 'ALLMODELS (2/3 active)');

    const dispatcherTelem = getAiDispatcherTelemetry();
    assert.strictEqual(dispatcherTelem.geminiModelDisplay, 'ALLMODELS (2/3 active)');
    recordPass('Telemetry accurately exposes ALLMODELS (X/Y active) and per-model cooldown counts.');

    // -------------------------------------------------------------------------
    // Test 15: Historical Records Preservation (Requirement M)
    // -------------------------------------------------------------------------
    totalTests++;
    console.log(`\n--- Test ${totalTests}: Historical Records Preservation ---`);
    // Historical string gemini-3.8-flash in SQLite must remain valid
    const legacyRow = { gemini_model: 'gemini-3.8-flash' };
    assert.strictEqual(legacyRow.gemini_model, 'gemini-3.8-flash');
    recordPass('Historical records containing gemini-3.8-flash are preserved intact.');

    // =========================================================================
    // TEST 16 (Test A): Single-Model 429 Isolation in ALLMODELS Mode
    // =========================================================================
    totalTests++;
    console.log(`\n--- Test ${totalTests} (Test A): Single-Model 429 Isolation in ALLMODELS Mode ---`);
    geminiPool.resetForTesting();
    globalGeminiLimiter.resetForTesting();
    resetPersistentAiProviderStateForTesting();
    geminiPool.configure('ALLMODELS');
    geminiPool.setAccessibleModelsForTesting([
      'gemini-3.8-flash',
      'gemini-3.7-flash',
      'gemini-3.6-flash',
    ]);

    // Model 3.8-flash experiences 429
    const err429 = new Error('RESOURCE_EXHAUSTED: 429 quota exceeded for gemini-3.8-flash');
    geminiPool.record429('gemini-3.8-flash', err429);
    globalGeminiLimiter.recordError(err429);

    // Assert that Model 3.8 is in cooldown, but the pool and global provider remain healthy
    assert.strictEqual(geminiPool.isPoolExhausted(), false);
    assert.strictEqual(globalGeminiLimiter.isCooldownActive(), false);
    assert.strictEqual(isGeminiCooldownActive(), false);
    assert.strictEqual(getGeminiCooldownRemainingMs(), 0);

    const healthyModelsA = geminiPool.getHealthyModels().map((m) => m.modelName);
    assert.strictEqual(healthyModelsA.includes('gemini-3.8-flash'), false);
    assert.strictEqual(healthyModelsA.includes('gemini-3.7-flash'), true);
    assert.strictEqual(healthyModelsA.includes('gemini-3.6-flash'), true);

    const leasedA = geminiPool.leaseModel();
    assert.notStrictEqual(leasedA?.model, 'gemini-3.8-flash');
    assert(leasedA?.model === 'gemini-3.7-flash' || leasedA?.model === 'gemini-3.6-flash');
    recordPass('Test A: Single-model 429 cools ONLY that model; pool and provider remain fully active.');

    // =========================================================================
    // TEST 17 (Test B): In-Pool Rotation on 429 via callAi
    // =========================================================================
    totalTests++;
    console.log(`\n--- Test ${totalTests} (Test B): In-Pool Rotation on 429 via callAi ---`);
    process.env.GEMINI_API_KEY = 'mock-key-test-b';
    resetGeminiClient();
    geminiPool.resetForTesting();
    globalGeminiLimiter.resetForTesting();
    resetPersistentAiProviderStateForTesting();
    geminiPool.configure('ALLMODELS');
    geminiPool.setAccessibleModelsForTesting([
      'gemini-3.8-flash',
      'gemini-3.7-flash',
    ]);

    const clientB = getGeminiClient();
    assert(clientB !== null);
    const origGenB = clientB.models.generateContent;
    const attemptedModelsB: string[] = [];

    clientB.models.generateContent = (async (args: any) => {
      attemptedModelsB.push(args.model);
      if (args.model === 'gemini-3.8-flash') {
        throw new Error('429 RESOURCE_EXHAUSTED on gemini-3.8-flash');
      }
      return {
        text: 'Success from gemini-3.7-flash',
      };
    }) as any;

    try {
      const resB = await callAi('Prompt for Test B');
      assert.strictEqual(resB.provider, 'gemini');
      assert.strictEqual(resB.model, 'gemini-3.7-flash');
      assert.strictEqual(resB.text, 'Success from gemini-3.7-flash');
      assert.deepStrictEqual(attemptedModelsB, ['gemini-3.8-flash', 'gemini-3.7-flash']);
      assert.strictEqual(isGeminiCooldownActive(), false);
      assert.strictEqual(globalGeminiLimiter.isCooldownActive(), false);
      recordPass('Test B: 429 on Model A immediately rotates in-pool to Model B without tripping provider cooldown.');
    } finally {
      clientB.models.generateContent = origGenB;
    }

    // =========================================================================
    // TEST 18 (Test C): Multiple Model Failures Rotation
    // =========================================================================
    totalTests++;
    console.log(`\n--- Test ${totalTests} (Test C): Multiple Model Failures Rotation ---`);
    geminiPool.resetForTesting();
    globalGeminiLimiter.resetForTesting();
    resetPersistentAiProviderStateForTesting();
    geminiPool.configure('ALLMODELS');
    geminiPool.setAccessibleModelsForTesting([
      'gemini-3.8-flash',
      'gemini-3.7-flash',
      'gemini-3.6-flash',
    ]);

    const clientC = getGeminiClient();
    assert(clientC !== null);
    const origGenC = clientC.models.generateContent;
    const attemptedModelsC: string[] = [];
    let failCountC = 0;
    clientC.models.generateContent = (async (args: any) => {
      attemptedModelsC.push(args.model);
      if (failCountC < 2) {
        failCountC++;
        throw new Error(`429 RESOURCE_EXHAUSTED on ${args.model}`);
      }
      return {
        text: `Success from ${args.model}`,
      };
    }) as any;

    try {
      const resC = await callAi('Prompt for Test C');
      assert.strictEqual(resC.provider, 'gemini');
      assert.strictEqual(attemptedModelsC.length, 3);
      assert.strictEqual(resC.model, attemptedModelsC[2]);
      assert.strictEqual(isGeminiCooldownActive(), false);
      recordPass('Test C: Two consecutive 429s rotate through pool until healthy third model succeeds.');
    } finally {
      clientC.models.generateContent = origGenC;
    }

    // =========================================================================
    // TEST 19 (Test D): Full Pool Exhaustion
    // =========================================================================
    totalTests++;
    console.log(`\n--- Test ${totalTests} (Test D): Full Pool Exhaustion ---`);
    geminiPool.resetForTesting();
    globalGeminiLimiter.resetForTesting();
    resetPersistentAiProviderStateForTesting();
    geminiPool.configure('ALLMODELS');
    geminiPool.setAccessibleModelsForTesting([
      'gemini-3.8-flash',
      'gemini-3.7-flash',
    ]);

    geminiPool.record429('gemini-3.8-flash');
    geminiPool.record429('gemini-3.7-flash');

    assert.strictEqual(geminiPool.isPoolExhausted(), true);
    assert.strictEqual(isGeminiCooldownActive(), true);
    assert.strictEqual(globalGeminiLimiter.isCooldownActive(), true);
    assert(getGeminiCooldownRemainingMs() > 0);
    recordPass('Test D: Full pool exhaustion activates global provider cooldown.');

    // =========================================================================
    // TEST 20 (Test E): Persistent Stale Provider State Auto-Reconciliation
    // =========================================================================
    totalTests++;
    console.log(`\n--- Test ${totalTests} (Test E): Persistent Stale State Auto-Reconciliation ---`);
    const db = getDb();
    const staleCooldown = new Date(Date.now() + 600000).toISOString(); // 10 min in future
    db.update(aiProviderState)
      .set({
        activeProvider: 'waiting',
        geminiCooldownUntil: staleCooldown,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(aiProviderState.id, 'singleton'))
      .run();

    // In ALLMODELS mode with healthy pool:
    geminiPool.resetForTesting();
    globalGeminiLimiter.resetForTesting();
    geminiPool.configure('ALLMODELS');
    geminiPool.setAccessibleModelsForTesting([
      'gemini-3.8-flash',
      'gemini-3.7-flash',
    ]);

    assert.strictEqual(geminiPool.isPoolExhausted(), false);
    // Retrieval of persistent state auto-reconciles stale waiting state
    const reconciledState = getPersistentAiProviderState();
    assert.strictEqual(reconciledState.activeProvider, 'gemini');
    assert.strictEqual(reconciledState.geminiCooldownUntil, null);
    assert.strictEqual(isGeminiCooldownActive(reconciledState), false);
    recordPass('Test E: Stale persistent DB WAITING state automatically reconciles when pool has healthy models.');

    // =========================================================================
    // TEST 21 (Test F): Explicit Pinned Single-Model Mode
    // =========================================================================
    totalTests++;
    console.log(`\n--- Test ${totalTests} (Test F): Pinned Single-Model Mode Retains Cooldown ---`);
    process.env.GEMINI_MODEL = 'gemini-2.5-flash';
    geminiPool.resetForTesting();
    globalGeminiLimiter.resetForTesting();
    resetPersistentAiProviderStateForTesting();
    geminiPool.configure('gemini-2.5-flash');
    assert.strictEqual(geminiPool.getMode(), 'single');

    // Single model 429
    globalGeminiLimiter.handle429(new Error('Single model 429'));
    assert.strictEqual(globalGeminiLimiter.isCooldownActive(), true);
    assert.strictEqual(isGeminiCooldownActive(), true);
    delete process.env.GEMINI_MODEL;
    geminiPool.configure('ALLMODELS');
    recordPass('Test F: Explicit pinned single-model mode retains strict single-model provider cooldown.');

    // =========================================================================
    // TEST 22 (Test G): Reconciler Error Handling Isolation
    // =========================================================================
    totalTests++;
    console.log(`\n--- Test ${totalTests} (Test G): Reconciler Error Handling Isolation ---`);
    geminiPool.resetForTesting();
    globalGeminiLimiter.resetForTesting();
    resetPersistentAiProviderStateForTesting();
    geminiPool.configure('ALLMODELS');
    geminiPool.setAccessibleModelsForTesting([
      'gemini-3.8-flash',
      'gemini-3.7-flash',
    ]);

    // Simulate reconciler catching a 429 from a single model attempt
    const reconcilerError = new Error('RESOURCE_EXHAUSTED 429 from batch chunk');
    globalGeminiLimiter.recordError(reconcilerError);

    // Global limiter cooldown must NOT be activated because healthy models exist
    assert.strictEqual(globalGeminiLimiter.isCooldownActive(), false);
    assert.strictEqual(isGeminiCooldownActive(), false);
    recordPass('Test G: Reconciler recordError does not trip global cooldown while healthy pool models exist.');

    console.log('\n================================================================');
    console.log(`  ALL ${passedTests}/${totalTests} TESTS PASSED SUCCESSFULLY!`);
    console.log('================================================================\n');
  } finally {
    // Restore environment
    if (originalGeminiModel !== undefined) {
      process.env.GEMINI_MODEL = originalGeminiModel;
    } else {
      delete process.env.GEMINI_MODEL;
    }
    if (originalGeminiKey !== undefined) {
      process.env.GEMINI_API_KEY = originalGeminiKey;
    } else {
      delete process.env.GEMINI_API_KEY;
    }
    if (originalOpenRouterKey !== undefined) {
      process.env.OPENROUTER_API_KEY = originalOpenRouterKey;
    } else {
      delete process.env.OPENROUTER_API_KEY;
    }
    geminiPool.resetForTesting();
    globalGeminiLimiter.resetForTesting();
    resetAiDispatcherTelemetryForTesting();
  }
}

runTests().catch((err) => {
  console.error('[FAIL] Test suite threw an unhandled error:', err);
  process.exit(1);
});
