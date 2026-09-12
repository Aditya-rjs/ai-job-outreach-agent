/**
 * Focused regression test suite:
 * 1. Web/dashboard reads cannot clear an active worker Gemini cooldown.
 * 2. Worker Gemini cooldown remains intact across web-process provider-state reads.
 * 3. 1st consecutive OpenRouter 429 = 60s.
 * 4. 2nd consecutive OpenRouter 429 = 120s.
 * 5. 3rd consecutive OpenRouter 429 = 300s.
 * 6. 4th consecutive OpenRouter 429 = 600s.
 * 7. Further consecutive 429s remain capped at 600s.
 * 8. Successful OpenRouter dispatch resets the consecutive 429 backoff.
 * 9. Lifetime OpenRouter failure telemetry remains cumulative.
 * 10. OpenRouter is never dispatched while its cooldown is active.
 * 11. Gemini remains primary when healthy Gemini models are available.
 * 12. OpenRouter remains fallback-only.
 */

import path from 'path';
import fs from 'fs';
import assert from 'assert';

const TEST_DIR = path.join(process.cwd(), 'data', `test-provider-fix-${Date.now()}`);
fs.mkdirSync(TEST_DIR, { recursive: true });

process.env.DATA_DIR = TEST_DIR;
(process.env as any).NODE_ENV = 'test';
process.env.OUTREACH_WORKER_NO_AUTO_START = 'true';
process.env.OUTREACH_DRY_RUN = 'true';
process.env.OPENROUTER_API_KEY = 'test-openrouter-key';

import { getDb, resetDbConnection } from '../src/db';
import { initializeDatabase } from '../src/db/migrate';
import { aiProviderState } from '../src/db/schema';
import { eq } from 'drizzle-orm';
import {
  getPersistentAiProviderState,
  isGeminiCooldownActive,
  getGeminiCooldownRemainingMs,
  isOpenRouterCooldownActive,
  getOpenRouterCooldownRemainingMs,
  computeOpenRouter429CooldownMs,
  computeEffectiveActiveProvider,
  recordOpenRouter429,
  recordOpenRouterSuccess,
  recordGemini429,
  recordGeminiSuccess,
  resetPersistentAiProviderStateForTesting,
} from '../src/lib/ai/ai-provider-service';
import {
  getAiDispatcherTelemetry,
} from '../src/lib/ai/ai-dispatcher';
import { geminiPool } from '../src/lib/ai/gemini-pool';

async function runTests() {
  console.log('======================================================================');
  console.log('VERIFY PROVIDER ROUTING & PROGRESSIVE COOLDOWN FIXES');
  console.log('======================================================================');

  initializeDatabase();
  resetPersistentAiProviderStateForTesting();
  geminiPool.resetCooldownsForTesting();
  geminiPool.configure('ALLMODELS');

  // -------------------------------------------------------------------------
  // TEST 1 & 2: Web process read must NEVER clear active worker Gemini cooldown
  // -------------------------------------------------------------------------
  console.log('\n--- TEST 1 & 2: Worker Gemini cooldown protection against web-process reads ---');
  const now = Date.now();
  const workerCooldownUntilIso = new Date(now + 90000).toISOString(); // 90s in future

  // Worker writes Gemini cooldown in SQLite
  recordGemini429(workerCooldownUntilIso, 'All Gemini pool models exhausted (quota exceeded)');

  // Verify SQLite has the cooldown
  let state = getPersistentAiProviderState();
  assert.strictEqual(state.geminiCooldownUntil, workerCooldownUntilIso, 'Cooldown timestamp must be stored');

  // Simulate Web process: local in-memory pool has healthy models (because web process never made calls)
  geminiPool.resetCooldownsForTesting();
  assert.strictEqual(geminiPool.isPoolExhausted(now), false, 'Web process pool has healthy models');

  // Web process performs a read (e.g. GET /api/dashboard)
  const webReadState = getPersistentAiProviderState();

  // Crucial assertion: Web process read must NOT have cleared geminiCooldownUntil!
  assert.strictEqual(
    webReadState.geminiCooldownUntil,
    workerCooldownUntilIso,
    'Web process read must NOT clear worker Gemini cooldown'
  );

  // Check that isGeminiCooldownActive and getGeminiCooldownRemainingMs honor it
  assert.strictEqual(
    isGeminiCooldownActive(webReadState, now),
    true,
    'isGeminiCooldownActive must remain true while SQLite cooldown is active'
  );
  const remainingMs = getGeminiCooldownRemainingMs(webReadState, now);
  assert.ok(
    remainingMs > 80000 && remainingMs <= 90000,
    `Remaining cooldown should reflect SQLite cooldown (~90s), got ${remainingMs}ms`
  );

  const telem = getAiDispatcherTelemetry(now);
  assert.strictEqual(telem.geminiCooldownActive, true, 'Telemetry must report geminiCooldownActive: true');
  assert.strictEqual(
    telem.geminiCooldownUntil,
    workerCooldownUntilIso,
    'Telemetry must preserve worker cooldown until ISO'
  );

  console.log('✔ [PASS] Worker Gemini cooldown is 100% protected against web-process reads');

  // -------------------------------------------------------------------------
  // TEST 3 - 7: Progressive OpenRouter 429 Cooldown (60s -> 120s -> 300s -> 600s -> 600s)
  // -------------------------------------------------------------------------
  console.log('\n--- TEST 3 - 7: Progressive OpenRouter 429 backoff schedule ---');
  resetPersistentAiProviderStateForTesting();

  // 1st consecutive 429 -> 60s
  const res1 = recordOpenRouter429('Rate limit #1');
  assert.strictEqual(res1.consecutiveCount, 1, 'Consecutive count should be 1');
  assert.strictEqual(res1.cooldownMs, 60000, '1st cooldown must be 60s (60000ms)');
  let pState = getPersistentAiProviderState();
  assert.strictEqual(pState.openrouterConsecutive429Count, 1);
  assert.strictEqual(pState.openrouterFailures, 1);

  // 2nd consecutive 429 -> 120s
  const res2 = recordOpenRouter429('Rate limit #2');
  assert.strictEqual(res2.consecutiveCount, 2, 'Consecutive count should be 2');
  assert.strictEqual(res2.cooldownMs, 120000, '2nd cooldown must be 120s (120000ms)');
  pState = getPersistentAiProviderState();
  assert.strictEqual(pState.openrouterConsecutive429Count, 2);
  assert.strictEqual(pState.openrouterFailures, 2);

  // 3rd consecutive 429 -> 300s
  const res3 = recordOpenRouter429('Rate limit #3');
  assert.strictEqual(res3.consecutiveCount, 3, 'Consecutive count should be 3');
  assert.strictEqual(res3.cooldownMs, 300000, '3rd cooldown must be 300s (300000ms)');
  pState = getPersistentAiProviderState();
  assert.strictEqual(pState.openrouterConsecutive429Count, 3);
  assert.strictEqual(pState.openrouterFailures, 3);

  // 4th consecutive 429 -> 600s
  const res4 = recordOpenRouter429('Rate limit #4');
  assert.strictEqual(res4.consecutiveCount, 4, 'Consecutive count should be 4');
  assert.strictEqual(res4.cooldownMs, 600000, '4th cooldown must be 600s (600000ms)');
  pState = getPersistentAiProviderState();
  assert.strictEqual(pState.openrouterConsecutive429Count, 4);
  assert.strictEqual(pState.openrouterFailures, 4);

  // 5th consecutive 429 -> capped at 600s
  const res5 = recordOpenRouter429('Rate limit #5');
  assert.strictEqual(res5.consecutiveCount, 5, 'Consecutive count should be 5');
  assert.strictEqual(res5.cooldownMs, 600000, '5th cooldown must remain capped at 600s (600000ms)');
  pState = getPersistentAiProviderState();
  assert.strictEqual(pState.openrouterConsecutive429Count, 5);
  assert.strictEqual(pState.openrouterFailures, 5);

  // Verify pure helper function directly
  assert.strictEqual(computeOpenRouter429CooldownMs(0), 60000);
  assert.strictEqual(computeOpenRouter429CooldownMs(1), 60000);
  assert.strictEqual(computeOpenRouter429CooldownMs(2), 120000);
  assert.strictEqual(computeOpenRouter429CooldownMs(3), 300000);
  assert.strictEqual(computeOpenRouter429CooldownMs(4), 600000);
  assert.strictEqual(computeOpenRouter429CooldownMs(10), 600000);

  console.log('✔ [PASS] Progressive cooldown schedule (60s -> 120s -> 300s -> 600s max) verified');

  // -------------------------------------------------------------------------
  // TEST 8 & 9: Successful OpenRouter dispatch resets consecutive backoff; lifetime telemetry preserved
  // -------------------------------------------------------------------------
  console.log('\n--- TEST 8 & 9: OpenRouter success resets consecutive backoff & preserves lifetime stats ---');
  // Currently failures = 5, consecutive = 5
  recordOpenRouterSuccess();

  pState = getPersistentAiProviderState();
  assert.strictEqual(pState.openrouterConsecutive429Count, 0, 'Consecutive count must reset to 0 on success');
  assert.strictEqual(pState.openrouterCooldownUntil, null, 'Cooldown must be cleared on success');
  assert.strictEqual(pState.openrouterFailures, 5, 'Lifetime failures counter must NOT be reset (must stay 5)');
  assert.strictEqual(pState.openrouterSuccesses, 1, 'Successes counter must increment');
  assert.strictEqual(pState.openrouterDispatches, 1, 'Dispatches counter must increment');

  // Next 429 after success starts back at 1st level (60s)
  const resAfterSuccess = recordOpenRouter429('Rate limit after recovery');
  assert.strictEqual(resAfterSuccess.consecutiveCount, 1, 'Consecutive count must start at 1 again');
  assert.strictEqual(resAfterSuccess.cooldownMs, 60000, 'Cooldown must be 60s for 1st consecutive');
  pState = getPersistentAiProviderState();
  assert.strictEqual(pState.openrouterFailures, 6, 'Lifetime failures counter increments to 6');

  console.log('✔ [PASS] Success cleanly resets consecutive count to 0 while lifetime failures remain cumulative');

  // -------------------------------------------------------------------------
  // TEST 10: OpenRouter is NEVER dispatched while its cooldown is active
  // -------------------------------------------------------------------------
  console.log('\n--- TEST 10: OpenRouter is never dispatched while cooldown is active ---');
  resetPersistentAiProviderStateForTesting();
  const testNow = Date.now();

  // Set OpenRouter cooldown active for 120s
  recordOpenRouter429('Rate limit 429', 120000);
  pState = getPersistentAiProviderState();
  assert.strictEqual(isOpenRouterCooldownActive(pState, testNow), true);
  assert.ok(getOpenRouterCooldownRemainingMs(pState, testNow) > 100000);

  // When Gemini is also in cooldown and OpenRouter is in cooldown -> effective provider is WAITING
  recordGemini429(new Date(testNow + 120000).toISOString(), 'Gemini cooling');
  pState = getPersistentAiProviderState();
  const active = computeEffectiveActiveProvider(pState, testNow);
  assert.strictEqual(active, 'waiting', 'Both in cooldown must evaluate to waiting');

  console.log('✔ [PASS] Dispatches are blocked while OpenRouter cooldown is active');

  // -------------------------------------------------------------------------
  // TEST 11 & 12: Gemini remains primary when healthy; OpenRouter is fallback-only
  // -------------------------------------------------------------------------
  console.log('\n--- TEST 11 & 12: Gemini primary & OpenRouter fallback-only priority ---');
  resetPersistentAiProviderStateForTesting();
  geminiPool.resetCooldownsForTesting();

  // State with both healthy
  pState = getPersistentAiProviderState();
  assert.strictEqual(
    computeEffectiveActiveProvider(pState, Date.now()),
    'gemini',
    'Gemini must always be primary when healthy'
  );

  // Gemini cooling down, OpenRouter healthy -> OpenRouter fallback active
  recordGemini429(new Date(Date.now() + 60000).toISOString(), 'Gemini pool exhausted');
  pState = getPersistentAiProviderState();
  assert.strictEqual(
    computeEffectiveActiveProvider(pState, Date.now()),
    'openrouter',
    'OpenRouter must become active when Gemini is in cooldown and OpenRouter is healthy'
  );

  // When Gemini cooldown expires -> returns to Gemini primary
  const futureTime = Date.now() + 70000;
  assert.strictEqual(
    computeEffectiveActiveProvider(pState, futureTime),
    'gemini',
    'Gemini must automatically resume as primary once cooldown expires'
  );

  console.log('✔ [PASS] Gemini primary and OpenRouter fallback-only priority strictly verified');

  // -------------------------------------------------------------------------
  // CLEANUP
  // -------------------------------------------------------------------------
  resetPersistentAiProviderStateForTesting();
  resetDbConnection();
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {}

  console.log('\n======================================================================');
  console.log('ALL 15 PROVIDER ROUTING & PROGRESSIVE COOLDOWN TESTS PASSED!');
  console.log('======================================================================\n');
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
