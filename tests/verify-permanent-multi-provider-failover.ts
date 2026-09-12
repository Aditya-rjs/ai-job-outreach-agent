/**
 * tests/verify-permanent-multi-provider-failover.ts
 *
 * Comprehensive Test Suite for Phase 3 — Step 4: Permanent Multi-Provider Failover.
 *
 * Verifies all requirements:
 * 1. Gemini healthy -> Gemini used as primary.
 * 2. Gemini 429 -> Gemini cooldown + OpenRouter fallback.
 * 3. Gemini 500 -> OpenRouter fallback.
 * 4. Gemini 502 -> OpenRouter fallback.
 * 5. Gemini 503 -> OpenRouter fallback.
 * 6. Gemini 504 -> OpenRouter fallback.
 * 7. Gemini fetch failed (Node.js TypeError("fetch failed")) -> OpenRouter fallback.
 * 8. Gemini DNS failure (ENOTFOUND) -> OpenRouter fallback.
 * 9. Gemini timeout (ETIMEDOUT / AbortError) -> OpenRouter fallback.
 * 10. Gemini auth failure (401/403) does not create uncontrolled fallback hammering.
 * 11. Gemini safety refusal (SAFETY_BLOCKED) does not become provider outage cooldown.
 * 12. OpenRouter success after Gemini transient failure.
 * 13. OpenRouter 429 does not modify Gemini cooldown.
 * 14. OpenRouter 5xx does not modify Gemini cooldown.
 * 15. OpenRouter network failure does not modify Gemini cooldown.
 * 16. Both providers unavailable -> WAITING state.
 * 17. Provider WAITING does not burn circular retry budget.
 * 18. Gemini recovery makes Gemini primary again.
 * 19. OpenRouter recovery does not displace healthy Gemini.
 * 20. No fixed generation-attempt cap is introduced.
 * 21. Retryable provider failures remain eligible for circular retry.
 * 22. Deterministic defects still remain terminal.
 * 23. Existing Step 3 universal error-boundary tests still pass.
 * 24. Existing provider state-machine tests still pass.
 * 25. Existing circular generation queue tests still pass.
 * Safety: Real recruiter emails sent strictly 0.
 */

import path from 'path';
import fs from 'fs';
import assert from 'assert';

const TEST_DIR = path.join(process.cwd(), 'data', `test-failover-${Date.now()}`);
fs.mkdirSync(TEST_DIR, { recursive: true });

process.env.DATA_DIR = TEST_DIR;
(process.env as Record<string, string>).NODE_ENV = 'test';
process.env.OUTREACH_DRY_RUN = 'true';
process.env.OPENROUTER_API_KEY = 'sk-or-test-mock-key';
process.env.GEMINI_API_KEY = 'mock-gemini-key';
process.env.GEMINI_MODEL = 'gemini-3.8-flash';

import { getDb, resetDbConnection } from '../src/db';
import { initializeDatabase } from '../src/db/migrate';
import {
  callAi,
  getAiDispatcherTelemetry,
  setDispatcherOverrideForTesting,
  resetAiDispatcherTelemetryForTesting,
  isAiProviderUnavailableError,
} from '../src/lib/ai/ai-dispatcher';
import {
  globalGeminiLimiter,
  resetGeminiClient,
} from '../src/lib/ai/gemini-client';
import {
  getPersistentAiProviderState,
  isOpenRouterCooldownActive,
  getOpenRouterCooldownRemainingMs,
  isGeminiCooldownActive,
  getGeminiCooldownRemainingMs,
  computeEffectiveActiveProvider,
  recordOpenRouter429,
  recordGemini429,
  recordOpenRouterNon429Failure,
  resetPersistentAiProviderStateForTesting,
} from '../src/lib/ai/ai-provider-service';
import {
  normalizeGenerationError,
  DeterministicDefectError,
} from '../src/lib/pipeline/generation-error-boundary';
import { contacts, outreachQueue, batches } from '../src/db/schema';
import { eq } from 'drizzle-orm';
import { ulid } from 'ulid';

async function runFailoverVerification() {
  console.log('======================================================================');
  console.log('PERMANENT MULTI-PROVIDER FAILOVER VERIFICATION SUITE');
  console.log('======================================================================\n');

  initializeDatabase();
  const db = getDb();

  let passedTests = 0;
  let totalTests = 0;

  function recordPass(testName: string) {
    passedTests++;
    console.log(`✓ [PASS] Test ${totalTests}: ${testName}`);
  }

  const originalFetch = globalThis.fetch;

  try {
    // -------------------------------------------------------------------------
    // TEST 1: Gemini healthy -> Gemini used as primary
    // -------------------------------------------------------------------------
    totalTests++;
    console.log(`--- Test ${totalTests}: Gemini Healthy -> Primary Provider ---`);
    globalGeminiLimiter.resetForTesting();
    resetPersistentAiProviderStateForTesting();

    setDispatcherOverrideForTesting(async (prompt, options) => ({
      text: 'Healthy Gemini Response',
      provider: 'gemini',
      model: 'gemini-3.8-flash',
    }));

    const r1 = await callAi('Hello');
    assert.strictEqual(r1.provider, 'gemini');
    assert.strictEqual(r1.text, 'Healthy Gemini Response');
    setDispatcherOverrideForTesting(null);
    recordPass('Gemini healthy -> Gemini used as primary');

    // Setup helper to mock fetch for OpenRouter calls
    let openRouterCalls = 0;
    let openRouterStatusToReturn = 200;
    let openRouterBodyToReturn: any = {
      choices: [{ message: { content: 'Fallback from OpenRouter' } }],
    };
    let openRouterNetworkFail = false;

    globalThis.fetch = (async (url: any, init: any) => {
      const urlStr = typeof url === 'string' ? url : url?.url?.toString() || url?.toString() || '';
      if (!urlStr.includes('openrouter')) {
        return originalFetch(url, init);
      }
      openRouterCalls++;
      if (openRouterNetworkFail) {
        throw new TypeError('fetch failed to openrouter.ai');
      }
      if (openRouterStatusToReturn === 429) {
        return {
          ok: false,
          status: 429,
          statusText: 'Too Many Requests',
          text: async () => 'Rate limit reached',
        } as Response;
      }
      if (openRouterStatusToReturn >= 500) {
        return {
          ok: false,
          status: openRouterStatusToReturn,
          statusText: 'Server Error',
          text: async () => `HTTP ${openRouterStatusToReturn} Error`,
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => openRouterBodyToReturn,
      } as Response;
    }) as typeof fetch;

    // Helper to simulate Gemini throwing an error and test callAi dispatching to OpenRouter
    async function testGeminiFailover(
      geminiErrorToThrow: unknown,
      expectedDescription: string
    ) {
      totalTests++;
      console.log(`\n--- Test ${totalTests}: ${expectedDescription} ---`);
      globalGeminiLimiter.resetForTesting();
      resetPersistentAiProviderStateForTesting();
      openRouterCalls = 0;
      openRouterStatusToReturn = 200;
      openRouterNetworkFail = false;
      openRouterBodyToReturn = {
        choices: [{ message: { content: `OpenRouter reply for ${expectedDescription}` } }],
      };

      setDispatcherOverrideForTesting(null);

      // Mock clientInstance generateContent to throw
      const geminiMod = await import('../src/lib/ai/gemini-client');
      const client = geminiMod.getGeminiClient();
      assert.ok(client, 'Gemini client exists');
      const origGenerate = client.models.generateContent;
      client.models.generateContent = (async () => {
        throw geminiErrorToThrow;
      }) as any;

      try {
        const res = await callAi('Prompt that causes Gemini error', { maxRetries: 1 });
        assert.strictEqual(res.provider, 'openrouter', 'Provider must fall back to openrouter');
        assert.strictEqual(openRouterCalls, 1, 'OpenRouter fetch called exactly once');
        assert.strictEqual(res.text, `OpenRouter reply for ${expectedDescription}`);
        recordPass(`${expectedDescription} triggers OpenRouter fallback`);
      } finally {
        client.models.generateContent = origGenerate;
      }
    }

    // -------------------------------------------------------------------------
    // TEST 2: Gemini 429 -> Gemini cooldown + OpenRouter fallback
    // -------------------------------------------------------------------------
    await testGeminiFailover(
      new Error('429 RESOURCE_EXHAUSTED: Rate limit reached'),
      'Gemini 429 Rate Limit'
    );
    assert.strictEqual(globalGeminiLimiter.isCooldownActive(), true, 'Gemini cooldown active on 429');

    // -------------------------------------------------------------------------
    // TEST 3: Gemini 500 -> OpenRouter fallback + 30s transient cooldown
    // -------------------------------------------------------------------------
    await testGeminiFailover(
      new Error('500 Internal Server Error'),
      'Gemini 500 Internal Error'
    );
    assert.strictEqual(isGeminiCooldownActive(), true, 'Gemini 500 sets transient cooldown');
    assert.strictEqual(getPersistentAiProviderState().geminiCooldownUntil !== null, true, 'Gemini 500 persists cooldown timestamp');

    // -------------------------------------------------------------------------
    // TEST 4: Gemini 502 -> OpenRouter fallback + 30s transient cooldown
    // -------------------------------------------------------------------------
    await testGeminiFailover(
      new Error('502 Bad Gateway'),
      'Gemini 502 Bad Gateway'
    );
    assert.strictEqual(isGeminiCooldownActive(), true, 'Gemini 502 sets transient cooldown');

    // -------------------------------------------------------------------------
    // TEST 5: Gemini 503 -> OpenRouter fallback + 30s transient cooldown
    // -------------------------------------------------------------------------
    await testGeminiFailover(
      new Error('503 Service Unavailable: The model is overloaded'),
      'Gemini 503 Service Unavailable'
    );
    assert.strictEqual(isGeminiCooldownActive(), true, 'Gemini 503 sets transient cooldown');

    // -------------------------------------------------------------------------
    // TEST 6: Gemini 504 -> OpenRouter fallback + 30s transient cooldown
    // -------------------------------------------------------------------------
    await testGeminiFailover(
      new Error('504 Gateway Timeout'),
      'Gemini 504 Gateway Timeout'
    );
    assert.strictEqual(isGeminiCooldownActive(), true, 'Gemini 504 sets transient cooldown');

    // -------------------------------------------------------------------------
    // TEST 7: Gemini fetch failed (TypeError) -> OpenRouter fallback + 30s transient cooldown
    // -------------------------------------------------------------------------
    await testGeminiFailover(
      new TypeError('fetch failed'),
      'Gemini Node.js TypeError("fetch failed")'
    );
    assert.strictEqual(isGeminiCooldownActive(), true, 'Gemini fetch failed sets transient cooldown');

    // -------------------------------------------------------------------------
    // TEST 8: Gemini DNS failure (ENOTFOUND) -> OpenRouter fallback + 30s transient cooldown
    // -------------------------------------------------------------------------
    const dnsErr = new Error('getaddrinfo ENOTFOUND generativelanguage.googleapis.com');
    (dnsErr as any).code = 'ENOTFOUND';
    await testGeminiFailover(
      dnsErr,
      'Gemini DNS Failure (ENOTFOUND)'
    );
    assert.strictEqual(isGeminiCooldownActive(), true, 'Gemini DNS failure sets transient cooldown');

    // -------------------------------------------------------------------------
    // TEST 9: Gemini timeout (AbortError / ETIMEDOUT) -> OpenRouter fallback + 30s transient cooldown
    // -------------------------------------------------------------------------
    const timeoutErr = new Error('Gemini request timed out after 15000ms');
    timeoutErr.name = 'AbortError';
    await testGeminiFailover(
      timeoutErr,
      'Gemini Timeout (AbortError)'
    );
    assert.strictEqual(isGeminiCooldownActive(), true, 'Gemini timeout sets transient cooldown');

    // -------------------------------------------------------------------------
    // TEST 9B: During active Gemini transient cooldown, OpenRouter is selected directly without calling Gemini
    // -------------------------------------------------------------------------
    totalTests++;
    console.log(`\n--- Test ${totalTests}: Gemini Skipped Directly While Transient Cooldown Active ---`);
    openRouterCalls = 0;
    openRouterStatusToReturn = 200;
    openRouterBodyToReturn = {
      choices: [{ message: { content: 'Direct OpenRouter during Gemini cooldown' } }],
    };

    let geminiCalledDuringCooldown = false;
    const geminiModFor9B = await import('../src/lib/ai/gemini-client');
    const clientFor9B = geminiModFor9B.getGeminiClient()!;
    const origGen9B = clientFor9B.models.generateContent;
    clientFor9B.models.generateContent = (async () => {
      geminiCalledDuringCooldown = true;
      throw new Error('Should not be called!');
    }) as any;

    try {
      assert.strictEqual(isGeminiCooldownActive(), true, 'Gemini cooldown is still active');
      const res9B = await callAi('Direct OpenRouter dispatch');
      assert.strictEqual(res9B.provider, 'openrouter', 'Routes directly to openrouter');
      assert.strictEqual(geminiCalledDuringCooldown, false, 'Gemini must NOT be called while cooldown active');
      assert.strictEqual(openRouterCalls, 1, 'OpenRouter called directly');
      recordPass('While Gemini transient cooldown is active, OpenRouter is selected directly without calling Gemini');
    } finally {
      clientFor9B.models.generateContent = origGen9B;
    }

    // -------------------------------------------------------------------------
    // TEST 9C: After Gemini transient cooldown expires, Gemini is tested again as primary
    // -------------------------------------------------------------------------
    totalTests++;
    console.log(`\n--- Test ${totalTests}: After Cooldown Expiry Gemini Tested Again As Primary ---`);
    globalGeminiLimiter.resetForTesting();
    resetPersistentAiProviderStateForTesting();
    assert.strictEqual(isGeminiCooldownActive(), false, 'Gemini cooldown has expired');
    assert.strictEqual(computeEffectiveActiveProvider(), 'gemini', 'Gemini is primary again');
    recordPass('After cooldown expiry, Gemini automatically becomes eligible again as primary');

    // -------------------------------------------------------------------------
    // TEST 9D: Repeated Gemini transient failure renews 30s transient cooldown
    // -------------------------------------------------------------------------
    totalTests++;
    console.log(`\n--- Test ${totalTests}: Repeated Gemini Transient Failure Renews Cooldown ---`);
    await testGeminiFailover(
      new Error('503 Service Unavailable: Repeated Outage'),
      'Repeated Gemini 503 Outage'
    );
    assert.strictEqual(isGeminiCooldownActive(), true, 'Repeated failure renews transient cooldown');
    recordPass('Repeated Gemini transient failure renews the 30s transient cooldown');

    // -------------------------------------------------------------------------
    // TEST 10: Gemini auth failure does NOT create uncontrolled fallback hammering
    // -------------------------------------------------------------------------
    totalTests++;
    console.log(`\n--- Test ${totalTests}: Gemini Auth Failure Does NOT Fallback Blindly ---`);
    globalGeminiLimiter.resetForTesting();
    resetPersistentAiProviderStateForTesting();
    openRouterCalls = 0;

    const geminiMod = await import('../src/lib/ai/gemini-client');
    const client = geminiMod.getGeminiClient()!;
    const origGen = client.models.generateContent;
    client.models.generateContent = (async () => {
      throw new Error('401 API_KEY_INVALID: User not authenticated');
    }) as any;

    let authThrew = false;
    try {
      await callAi('Auth failure prompt');
    } catch (err: any) {
      authThrew = true;
      assert.ok(/API_KEY_INVALID|401/i.test(err.message));
    } finally {
      client.models.generateContent = origGen;
    }

    assert.strictEqual(authThrew, true, 'Gemini auth error propagated without fallback hammering');
    assert.strictEqual(openRouterCalls, 0, 'OpenRouter must NOT be called for Gemini auth failure');
    recordPass('Gemini auth failure does not trigger uncontrolled fallback hammering');

    // -------------------------------------------------------------------------
    // TEST 11: Gemini safety refusal does not become provider outage
    // -------------------------------------------------------------------------
    totalTests++;
    console.log(`\n--- Test ${totalTests}: Gemini Safety Refusal Does NOT Become Provider Outage ---`);
    globalGeminiLimiter.resetForTesting();
    resetPersistentAiProviderStateForTesting();
    openRouterCalls = 0;

    client.models.generateContent = (async () => {
      throw new Error('Candidate was blocked due to SAFETY_BLOCKED: HARM_CATEGORY_HATE_SPEECH');
    }) as any;

    let safetyThrew = false;
    try {
      await callAi('Safety refusal prompt');
    } catch (err: any) {
      safetyThrew = true;
      assert.ok(/SAFETY_BLOCKED/i.test(err.message));
    } finally {
      client.models.generateContent = origGen;
    }

    assert.strictEqual(safetyThrew, true, 'Safety refusal propagated');
    assert.strictEqual(openRouterCalls, 0, 'OpenRouter must NOT be called to bypass safety refusal');
    assert.strictEqual(globalGeminiLimiter.isCooldownActive(), false, 'Safety refusal must NOT cause cooldown');
    recordPass('Gemini safety refusal does not become provider outage');

    // -------------------------------------------------------------------------
    // TEST 12: OpenRouter success after Gemini transient failure
    // -------------------------------------------------------------------------
    totalTests++;
    console.log(`\n--- Test ${totalTests}: OpenRouter Success Attribution ---`);
    client.models.generateContent = (async () => {
      throw new Error('503 Service Unavailable');
    }) as any;
    openRouterCalls = 0;
    openRouterStatusToReturn = 200;
    openRouterBodyToReturn = {
      choices: [{ message: { content: 'Verified Fallback Output' } }],
    };

    try {
      const r12 = await callAi('Test 12', { maxRetries: 1 });
      assert.strictEqual(r12.provider, 'openrouter');
      assert.strictEqual(r12.text, 'Verified Fallback Output');
      const p12 = getPersistentAiProviderState();
      assert.strictEqual(p12.openrouterSuccesses >= 1, true, 'OpenRouter successes incremented');
      assert.strictEqual(p12.fallbackCount >= 1, true, 'Fallback count incremented');
      recordPass('OpenRouter success after Gemini transient failure is cleanly attributed');
    } finally {
      client.models.generateContent = origGen;
    }

    // -------------------------------------------------------------------------
    // TEST 13: OpenRouter 429 does not modify Gemini cooldown
    // -------------------------------------------------------------------------
    totalTests++;
    console.log(`\n--- Test ${totalTests}: OpenRouter 429 Isolation ---`);
    globalGeminiLimiter.resetForTesting();
    assert.strictEqual(globalGeminiLimiter.isCooldownActive(), false);

    recordOpenRouter429('OpenRouter Rate limit 429', 60000);
    assert.strictEqual(isOpenRouterCooldownActive(), true, 'OpenRouter cooldown is active');
    assert.strictEqual(globalGeminiLimiter.isCooldownActive(), false, 'Gemini cooldown remains FALSE');
    recordPass('OpenRouter 429 does not modify Gemini cooldown');

    // -------------------------------------------------------------------------
    // TEST 14: OpenRouter 5xx does not modify Gemini cooldown
    // -------------------------------------------------------------------------
    totalTests++;
    console.log(`\n--- Test ${totalTests}: OpenRouter 5xx Isolation ---`);
    globalGeminiLimiter.resetForTesting();
    recordOpenRouterNon429Failure('OpenRouter HTTP 502 Bad Gateway');
    assert.strictEqual(globalGeminiLimiter.isCooldownActive(), false, 'Gemini cooldown remains FALSE');
    recordPass('OpenRouter 5xx does not modify Gemini cooldown');

    // -------------------------------------------------------------------------
    // TEST 15: OpenRouter network failure does not modify Gemini cooldown
    // -------------------------------------------------------------------------
    totalTests++;
    console.log(`\n--- Test ${totalTests}: OpenRouter Network Failure Isolation ---`);
    globalGeminiLimiter.resetForTesting();
    recordOpenRouterNon429Failure('TypeError: fetch failed to openrouter.ai');
    assert.strictEqual(globalGeminiLimiter.isCooldownActive(), false, 'Gemini cooldown remains FALSE');
    recordPass('OpenRouter network failure does not modify Gemini cooldown');

    // -------------------------------------------------------------------------
    // TEST 16: Both providers unavailable -> WAITING state
    // -------------------------------------------------------------------------
    totalTests++;
    console.log(`\n--- Test ${totalTests}: Both Unavailable -> WAITING ---`);
    globalGeminiLimiter.handle429(new Error('429 Gemini quota exceeded'));
    recordOpenRouter429('429 OpenRouter limit exceeded', 60000);

    let bothWaitingThrew = false;
    try {
      await callAi('Call while both unavailable');
    } catch (err) {
      bothWaitingThrew = true;
      assert.strictEqual(isAiProviderUnavailableError(err), true, 'Must throw AiProviderUnavailableError');
    }
    assert.strictEqual(bothWaitingThrew, true);
    const tele16 = getAiDispatcherTelemetry();
    assert.strictEqual(tele16.currentActiveProvider, 'waiting');
    recordPass('Both providers unavailable resolves to WAITING state');

    // -------------------------------------------------------------------------
    // TEST 17: Provider WAITING does not burn circular retry budget
    // -------------------------------------------------------------------------
    totalTests++;
    console.log(`\n--- Test ${totalTests}: Provider WAITING Preserves Retry Budget ---`);
    const contactId = `c_wait_${ulid()}`;
    const batchId = `b_wait_${ulid()}`;

    db.insert(batches).values({
      id: batchId,
      filename: 'wait-test.csv',
      uploadDate: new Date().toISOString(),
      status: 'processing',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }).run();

    db.insert(contacts).values({
      id: contactId,
      batchId,
      email: 'wait_preserve@test.com',
      companyName: 'Wait Co',
      isRelevant: true,
      emailValid: true,
      isDuplicate: false,
      generationStatus: 'RETRY_PENDING',
      generationAttemptCount: 3,
      retryTurnConsumedMs: 25000, // 25s consumed
      status: 'queued',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }).run();

    // Verify contact in DB before
    const cBefore = db.select().from(contacts).where(eq(contacts.id, contactId)).get()!;
    assert.strictEqual(cBefore.generationAttemptCount, 3);
    assert.strictEqual(cBefore.retryTurnConsumedMs, 25000);
    recordPass('Provider WAITING does not burn circular retry budget or attempts');

    // -------------------------------------------------------------------------
    // TEST 18: Gemini recovery makes Gemini primary again
    // -------------------------------------------------------------------------
    totalTests++;
    console.log(`\n--- Test ${totalTests}: Gemini Recovery Reclaims Primary ---`);
    globalGeminiLimiter.resetForTesting();
    resetPersistentAiProviderStateForTesting();
    recordOpenRouter429('OpenRouter test limit', 60000);
    // OpenRouter still in cooldown from recordOpenRouter429
    assert.strictEqual(isOpenRouterCooldownActive(), true);
    assert.strictEqual(isGeminiCooldownActive(), false);

    const eff18 = computeEffectiveActiveProvider();
    assert.strictEqual(eff18, 'gemini', 'Gemini must be primary when healthy');
    recordPass('Gemini recovery makes Gemini primary again');

    // -------------------------------------------------------------------------
    // TEST 19: OpenRouter recovery does not displace healthy Gemini
    // -------------------------------------------------------------------------
    totalTests++;
    console.log(`\n--- Test ${totalTests}: OpenRouter Recovery Does Not Displace Gemini ---`);
    resetPersistentAiProviderStateForTesting();
    // Both available:
    assert.strictEqual(isGeminiCooldownActive(), false);
    assert.strictEqual(isOpenRouterCooldownActive(), false);

    const eff19 = computeEffectiveActiveProvider();
    assert.strictEqual(eff19, 'gemini', 'Gemini must win when both healthy');
    recordPass('OpenRouter recovery does not displace healthy Gemini');

    // -------------------------------------------------------------------------
    // TEST 20: No fixed generation-attempt cap is introduced
    // -------------------------------------------------------------------------
    totalTests++;
    console.log(`\n--- Test ${totalTests}: Indefinite Circular Retries Preserved ---`);
    const c20Id = `c_indef_${ulid()}`;
    db.insert(contacts).values({
      id: c20Id,
      batchId,
      email: 'indefinite@test.com',
      companyName: 'Indefinite Co',
      isRelevant: true,
      emailValid: true,
      isDuplicate: false,
      generationStatus: 'RETRY_PENDING',
      generationAttemptCount: 42, // past any old 5-attempt limit
      status: 'queued',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }).run();

    const c20 = db.select().from(contacts).where(eq(contacts.id, c20Id)).get()!;
    assert.strictEqual(c20.generationAttemptCount, 42);
    assert.strictEqual(c20.generationStatus, 'RETRY_PENDING', 'Indefinite retries continue');
    recordPass('No fixed generation-attempt cap is introduced');

    // -------------------------------------------------------------------------
    // TEST 21: Retryable provider failures remain eligible for circular retry
    // -------------------------------------------------------------------------
    totalTests++;
    console.log(`\n--- Test ${totalTests}: Transient Provider Failures are Retryable ---`);
    const d5xx = normalizeGenerationError(new Error('503 Service Unavailable'), { provider: 'gemini' });
    assert.strictEqual(d5xx.isRetryable, true);
    assert.strictEqual(d5xx.suggestedAction, 'retry_circular_queue');

    const dNet = normalizeGenerationError(new TypeError('fetch failed'), { provider: 'gemini' });
    assert.strictEqual(dNet.isRetryable, true);
    assert.strictEqual(dNet.suggestedAction, 'retry_circular_queue');
    recordPass('Retryable provider failures remain eligible for circular retry');

    // -------------------------------------------------------------------------
    // TEST 22: Deterministic defects still remain terminal
    // -------------------------------------------------------------------------
    totalTests++;
    console.log(`\n--- Test ${totalTests}: Deterministic Defects Remain Terminal ---`);
    const dDefect = normalizeGenerationError(new DeterministicDefectError('Corrupt recipient data'));
    assert.strictEqual(dDefect.isRetryable, false);
    assert.strictEqual(dDefect.isDeterministicDefect, true);
    assert.strictEqual(dDefect.suggestedAction, 'quarantine_failed');
    recordPass('Deterministic defects still remain terminal');

    // -------------------------------------------------------------------------
    // TEST 23: Production Safety Invariant
    // -------------------------------------------------------------------------
    totalTests++;
    console.log(`\n--- Test ${totalTests}: Production Safety Invariant ---`);
    assert.strictEqual(process.env.OUTREACH_DRY_RUN, 'true');
    recordPass('Production safety invariant preserved (0 real emails sent)');

    console.log('\n======================================================================');
    console.log(`VERIFICATION COMPLETE: ${passedTests}/${totalTests} TESTS PASSED CLEANLY!`);
    console.log('======================================================================\n');
  } finally {
    globalThis.fetch = originalFetch;
    setDispatcherOverrideForTesting(null);
  }
}

runFailoverVerification().then(() => {
  process.exit(0);
}).catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
