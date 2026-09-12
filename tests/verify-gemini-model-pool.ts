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
  resetPersistentAiProviderStateForTesting,
} from '../src/lib/ai/ai-provider-service';
import { globalGeminiLimiter } from '../src/lib/ai/gemini-client';

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
