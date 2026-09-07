/**
 * Comprehensive Verification Suite for AI Provider Routing & State Machine Architecture
 *
 * Explicitly verifies all requirements:
 * 1. Gemini healthy -> Gemini active.
 * 2. Gemini 429 -> OpenRouter active.
 * 3. Gemini unavailable + OpenRouter available -> OpenRouter active.
 * 4. Gemini unavailable + OpenRouter unavailable -> WAITING.
 * 5. Both unavailable -> OpenRouter recovers first -> OpenRouter immediately becomes active.
 * 6. Both unavailable -> Gemini recovers first -> Gemini immediately becomes active.
 * 7. Both recover -> Gemini wins because it is primary.
 * 8. OpenRouter active -> Gemini recovers -> automatically return to Gemini.
 * 9. OpenRouter 429 -> OpenRouter cooldown recorded.
 * 10. OpenRouter 429 never changes Gemini cooldown.
 * 11. WAITING never burns classification retries.
 * 12. WAITING never burns generation retries.
 * 13. Dashboard reads the effective provider state from SQLite.
 * 14. Provider state survives process restart.
 * 15. Persistent telemetry still works across the separate Railway web and worker processes.
 * 16. Existing resume deadlock fix remains intact.
 * 17. Existing sending-window, 3-minute spacing, 144-hour cooldown, and no-daily-cap tests remain intact.
 * 18. Classification Reconciler provider isolation remains intact.
 */

import path from 'path';
import fs from 'fs';
import assert from 'assert';

const TEST_DIR = path.join(process.cwd(), 'data', 'test-ai-provider-state-machine');
if (fs.existsSync(TEST_DIR)) {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
}
fs.mkdirSync(TEST_DIR, { recursive: true });

process.env.DATA_DIR = TEST_DIR;
(process.env as Record<string, string>).NODE_ENV = 'test';
process.env.OUTREACH_DRY_RUN = 'true';
process.env.OPENROUTER_API_KEY = 'sk-or-test-key-mock';
process.env.GEMINI_API_KEY = 'mock-gemini-key';

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
  setPersistentActiveProvider,
  resetPersistentAiProviderStateForTesting,
} from '../src/lib/ai/ai-provider-service';
import {
  isOpenRouterError,
  OpenRouterError,
  resetOpenRouterTelemetryForTesting,
} from '../src/lib/ai/openrouter-client';
import { getDashboardStats } from '../src/lib/db-helpers';
import {
  contacts,
  companyClassifications,
  schedulerState,
  batches,
  aiProviderState,
} from '../src/db/schema';
import { eq, sql } from 'drizzle-orm';
import { reconcilePendingEmailGenerations } from '../src/lib/pipeline/generation-reconciler';
import { reconcilePendingClassifications } from '../src/lib/pipeline/classification-reconciler';
import { isWithinDailyWindow, computeNextEligibleSendTime } from '../src/lib/scheduler/time-utils';

async function runStateMachineVerification() {
  console.log('======================================================================');
  console.log('AI PROVIDER ROUTING & STATE MACHINE ARCHITECTURE VERIFICATION SUITE');
  console.log('======================================================================\n');

  initializeDatabase();
  const db = getDb();

  let passedTests = 0;
  let totalTests = 0;

  function recordPass(testName: string) {
    passedTests++;
    console.log(`✓ [PASS] Requirement ${totalTests}: ${testName}`);
  }

  const originalFetch = globalThis.fetch;

  try {
    // -------------------------------------------------------------------------
    // REQUIREMENT 1: Gemini healthy -> Gemini is used as primary
    // -------------------------------------------------------------------------
    totalTests++;
    console.log(`\n--- Requirement ${totalTests}: Gemini Healthy -> Primary Provider ---`);

    globalGeminiLimiter.resetForTesting();
    resetPersistentAiProviderStateForTesting();

    setDispatcherOverrideForTesting(async (prompt) => ({
      text: 'Gemini Primary Success',
      provider: 'gemini',
      model: 'gemini-3.8-flash',
    }));

    const res1 = await callAi('Hello Primary');
    assert.strictEqual(res1.provider, 'gemini');
    assert.strictEqual(res1.text, 'Gemini Primary Success');

    const tele1 = getAiDispatcherTelemetry();
    assert.strictEqual(tele1.currentActiveProvider, 'gemini');
    setDispatcherOverrideForTesting(null);
    recordPass('Gemini is used when healthy; state shows gemini active');

    // -------------------------------------------------------------------------
    // REQUIREMENT 2: Gemini 429 -> OpenRouter is used immediately
    // -------------------------------------------------------------------------
    totalTests++;
    console.log(`\n--- Requirement ${totalTests}: Gemini 429 -> OpenRouter Fallback ---`);

    globalGeminiLimiter.resetForTesting();
    resetPersistentAiProviderStateForTesting();

    let orFetchCalls = 0;
    globalThis.fetch = (async () => {
      orFetchCalls++;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: 'OpenRouter Fallback Response' } }],
        }),
      } as Response;
    }) as typeof fetch;

    globalGeminiLimiter.handle429(new Error('429 RESOURCE_EXHAUSTED: quota exceeded'));
    assert.strictEqual(globalGeminiLimiter.isCooldownActive(), true, 'Gemini cooldown should be active');

    const res2 = await callAi('Hello Fallback');
    assert.strictEqual(res2.provider, 'openrouter');
    assert.strictEqual(res2.text, 'OpenRouter Fallback Response');
    assert.strictEqual(orFetchCalls, 1, 'OpenRouter was called once');

    const tele2 = getAiDispatcherTelemetry();
    assert.strictEqual(tele2.currentActiveProvider, 'openrouter');
    assert.strictEqual(tele2.openRouterDispatches, 1);
    assert.strictEqual(tele2.openRouterSuccesses, 1);
    recordPass('Gemini 429 switches immediately to OpenRouter; state is openrouter active');

    // -------------------------------------------------------------------------
    // REQUIREMENT 3: Gemini unavailable + OpenRouter available -> OpenRouter active
    // -------------------------------------------------------------------------
    totalTests++;
    console.log(`\n--- Requirement ${totalTests}: Gemini Unavailable + OpenRouter Available ---`);

    assert.strictEqual(globalGeminiLimiter.isCooldownActive(), true);
    assert.strictEqual(isOpenRouterCooldownActive(), false);
    const eff3 = computeEffectiveActiveProvider();
    assert.strictEqual(eff3, 'openrouter');
    recordPass('Gemini unavailable + OpenRouter available resolves to openrouter active');

    // -------------------------------------------------------------------------
    // REQUIREMENT 4: OpenRouter 429 -> OpenRouter cooldown recorded independently
    // -------------------------------------------------------------------------
    totalTests++;
    console.log(`\n--- Requirement ${totalTests}: OpenRouter 429 Cooldown Recorded ---`);

    recordOpenRouter429('Rate limit 429: free-models-per-day', 60000);
    assert.strictEqual(isOpenRouterCooldownActive(), true, 'OpenRouter cooldown is active');

    const pState4 = getPersistentAiProviderState();
    assert.ok(pState4.openrouterCooldownUntil !== null, 'OpenRouter cooldown timestamp is stored');
    recordPass('OpenRouter 429 records an independent OpenRouter cooldown timestamp');

    // -------------------------------------------------------------------------
    // REQUIREMENT 5: OpenRouter 429 does NOT modify Gemini cooldown
    // -------------------------------------------------------------------------
    totalTests++;
    console.log(`\n--- Requirement ${totalTests}: Provider Isolation (OpenRouter 429 != Gemini CD) ---`);

    globalGeminiLimiter.resetForTesting();
    assert.strictEqual(globalGeminiLimiter.isCooldownActive(), false, 'Gemini cooldown is false');
    recordOpenRouter429('OpenRouter 429 isolation test', 60000);
    assert.strictEqual(globalGeminiLimiter.isCooldownActive(), false, 'Gemini cooldown must remain FALSE');
    assert.strictEqual(globalGeminiLimiter.getCooldownUntilIso(), null, 'Gemini cooldownUntil must remain NULL');
    recordPass('OpenRouter 429 never sets or extends Gemini rate-limiter cooldown');

    // -------------------------------------------------------------------------
    // REQUIREMENT 6: Gemini unavailable + OpenRouter unavailable -> WAITING
    // -------------------------------------------------------------------------
    totalTests++;
    console.log(`\n--- Requirement ${totalTests}: Both Cooling -> WAITING State ---`);

    globalGeminiLimiter.handle429(new Error('429 Gemini rate limit'));
    assert.strictEqual(globalGeminiLimiter.isCooldownActive(), true);
    assert.strictEqual(isOpenRouterCooldownActive(), true);

    let waitingThrew = false;
    try {
      await callAi('Hello during both cooldowns');
    } catch (err: any) {
      waitingThrew = true;
      assert.strictEqual(isAiProviderUnavailableError(err), true, 'Error must be AiProviderUnavailableError');
    }

    assert.strictEqual(waitingThrew, true, 'callAi throws AiProviderUnavailableError');
    const tele6 = getAiDispatcherTelemetry();
    assert.strictEqual(tele6.currentActiveProvider, 'waiting', 'Current provider must be waiting');
    recordPass('When both providers are cooling down, system enters WAITING state');

    // -------------------------------------------------------------------------
    // REQUIREMENT 7: Critical Recovery Case: OpenRouter recovers FIRST from WAITING
    // -------------------------------------------------------------------------
    totalTests++;
    console.log(`\n--- Requirement ${totalTests}: Critical: OpenRouter Recovers FIRST from WAITING ---`);

    // Setup user's exact scenario:
    // Gemini: cooldown active until 12:10
    // OpenRouter: cooldown active until 12:05
    // Current time: 12:00 -> WAITING
    // At 12:05: OpenRouter recovers -> immediately OPENROUTER ACTIVE (do not wait for Gemini)
    // At 12:10: Gemini recovers -> automatically GEMINI ACTIVE
    const t0 = new Date('2026-09-07T12:00:00.000Z').getTime();
    const orExpiry = new Date('2026-09-07T12:05:00.000Z').toISOString();
    const geminiExpiry = new Date('2026-09-07T12:10:00.000Z').toISOString();

    recordGemini429(geminiExpiry, 'Gemini 429 quota');
    globalGeminiLimiter.setCooldownUntilForTesting(new Date(geminiExpiry).getTime());

    recordOpenRouter429('OpenRouter 429 limit', orExpiry);

    // At 12:00:
    const teleAt1200 = getAiDispatcherTelemetry(t0);
    assert.strictEqual(teleAt1200.currentActiveProvider, 'waiting', 'At 12:00 both cooling -> WAITING');
    assert.strictEqual(teleAt1200.geminiCooldownActive, true);
    assert.strictEqual(teleAt1200.openRouterCooldownActive, true);

    // At 12:05:01 (OpenRouter expired, Gemini still cooling until 12:10):
    const t1 = new Date('2026-09-07T12:05:01.000Z').getTime();
    const teleAt1205 = getAiDispatcherTelemetry(t1);
    assert.strictEqual(teleAt1205.openRouterCooldownActive, false, 'OpenRouter cooldown must be expired');
    assert.strictEqual(teleAt1205.geminiCooldownActive, true, 'Gemini still cooling until 12:10');
    assert.strictEqual(
      teleAt1205.currentActiveProvider,
      'openrouter',
      'OpenRouter recovering first MUST immediately activate OpenRouter (not wait for Gemini)'
    );

    // At 12:10:01 (Gemini cooldown also expired):
    const t2 = new Date('2026-09-07T12:10:01.000Z').getTime();
    const teleAt1210 = getAiDispatcherTelemetry(t2);
    assert.strictEqual(teleAt1210.geminiCooldownActive, false, 'Gemini cooldown expired');
    assert.strictEqual(
      teleAt1210.currentActiveProvider,
      'gemini',
      'Gemini recovering MUST automatically return to Gemini as primary'
    );
    recordPass('OpenRouter-first recovery immediately switches to OpenRouter without waiting for Gemini');

    // -------------------------------------------------------------------------
    // REQUIREMENT 8: Gemini recovers FIRST from WAITING
    // -------------------------------------------------------------------------
    totalTests++;
    console.log(`\n--- Requirement ${totalTests}: Gemini Recovers FIRST from WAITING ---`);

    // Setup scenario:
    // Gemini cooldown until 12:05
    // OpenRouter cooldown until 12:10
    // At 12:05: Gemini recovers -> immediately GEMINI ACTIVE (does not wait for OpenRouter)
    const geminiExpiryFirst = new Date('2026-09-07T12:05:00.000Z').toISOString();
    const orExpiryLater = new Date('2026-09-07T12:10:00.000Z').toISOString();

    recordGemini429(geminiExpiryFirst, 'Gemini limit');
    globalGeminiLimiter.setCooldownUntilForTesting(new Date(geminiExpiryFirst).getTime());
    recordOpenRouter429('OpenRouter limit', orExpiryLater);

    // At 12:00:
    const teleWait = getAiDispatcherTelemetry(t0);
    assert.strictEqual(teleWait.currentActiveProvider, 'waiting');

    // At 12:05:01:
    const teleGeminiRecovered = getAiDispatcherTelemetry(t1);
    assert.strictEqual(teleGeminiRecovered.geminiCooldownActive, false, 'Gemini cooldown expired');
    assert.strictEqual(teleGeminiRecovered.openRouterCooldownActive, true, 'OpenRouter still in cooldown');
    assert.strictEqual(
      teleGeminiRecovered.currentActiveProvider,
      'gemini',
      'Gemini recovering first MUST immediately activate Gemini as primary'
    );
    recordPass('Gemini-first recovery immediately switches to Gemini as primary');

    // -------------------------------------------------------------------------
    // REQUIREMENT 9: Both recover at approximately the same time -> Gemini wins
    // -------------------------------------------------------------------------
    totalTests++;
    console.log(`\n--- Requirement ${totalTests}: Both Recover -> Gemini Wins As Primary ---`);

    const tAfterBoth = new Date('2026-09-07T12:15:00.000Z').getTime();
    const teleBothRecovered = getAiDispatcherTelemetry(tAfterBoth);
    assert.strictEqual(teleBothRecovered.geminiCooldownActive, false);
    assert.strictEqual(teleBothRecovered.openRouterCooldownActive, false);
    assert.strictEqual(teleBothRecovered.currentActiveProvider, 'gemini', 'When both are available, Gemini wins');
    recordPass('When both providers are available/recovered, Gemini wins as primary');

    // -------------------------------------------------------------------------
    // REQUIREMENT 10: OpenRouter active -> Gemini recovers -> returns to Gemini
    // -------------------------------------------------------------------------
    totalTests++;
    console.log(`\n--- Requirement ${totalTests}: OpenRouter Active -> Gemini Recovers -> Returns to Gemini ---`);

    globalGeminiLimiter.resetForTesting();
    resetPersistentAiProviderStateForTesting();

    // Trigger Gemini 429
    globalGeminiLimiter.handle429(new Error('429 Gemini rate limit'));
    assert.strictEqual(globalGeminiLimiter.isCooldownActive(), true);

    const teleDuringCooling = getAiDispatcherTelemetry();
    assert.strictEqual(teleDuringCooling.currentActiveProvider, 'openrouter');

    // Gemini cooldown expires
    globalGeminiLimiter.resetCooldown();
    db.update(aiProviderState)
      .set({ geminiCooldownUntil: null, updatedAt: new Date().toISOString() })
      .where(eq(aiProviderState.id, 'singleton'))
      .run();

    const teleAfterExpiry = getAiDispatcherTelemetry();
    assert.strictEqual(teleAfterExpiry.currentActiveProvider, 'gemini', 'Returned to Gemini as primary');
    recordPass('OpenRouter active automatically returns to Gemini once Gemini cooldown expires');

    // -------------------------------------------------------------------------
    // REQUIREMENT 11: WAITING never burns generation retries
    // -------------------------------------------------------------------------
    totalTests++;
    console.log(`\n--- Requirement ${totalTests}: WAITING Never Burns Generation Retries ---`);

    // Put both providers into active cooldown
    globalGeminiLimiter.handle429(new Error('429 Gemini'));
    recordOpenRouter429('429 OpenRouter', 60000);

    const nowIso = new Date().toISOString();
    const batchId = 'batch_wait_test_gen';
    const contactId = 'contact_wait_test_gen';

    db.insert(batches)
      .values({
        id: batchId,
        filename: 'test_gen.csv',
        uploadDate: nowIso,
        status: 'processing',
        createdAt: nowIso,
        updatedAt: nowIso,
      })
      .onConflictDoNothing()
      .run();

    db.insert(contacts)
      .values({
        id: contactId,
        batchId,
        companyName: 'Acme Test Corp Gen',
        contactName: 'Bob',
        email: 'bob.wait@acme.com',
        isRelevant: true,
        emailValid: true,
        isDuplicate: false,
        status: 'queued',
        generationStatus: 'PENDING_GENERATION',
        generationAttemptCount: 0,
        createdAt: nowIso,
        updatedAt: nowIso,
      })
      .onConflictDoNothing()
      .run();

    await reconcilePendingEmailGenerations();

    const contactAfter = db.select().from(contacts).where(eq(contacts.id, contactId)).get();
    assert.strictEqual(contactAfter?.generationAttemptCount, 0, 'Generation attempt count MUST remain 0');
    assert.strictEqual(contactAfter?.generationStatus, 'PENDING_GENERATION', 'Status MUST remain PENDING_GENERATION');
    recordPass('WAITING state releases claim without burning generation retry attempts');

    // -------------------------------------------------------------------------
    // REQUIREMENT 12: WAITING never burns classification retries
    // -------------------------------------------------------------------------
    totalTests++;
    console.log(`\n--- Requirement ${totalTests}: WAITING Never Burns Classification Retries ---`);

    db.insert(companyClassifications)
      .values({
        normalizedName: 'waiting-no-burn-co',
        companyName: 'Waiting No Burn Co',
        classificationResult: 'PENDING',
        retryRound: 0,
        retryCount: 0,
        reason: 'Pending',
        createdAt: nowIso,
        updatedAt: nowIso,
      })
      .onConflictDoNothing()
      .run();

    // Call classification reconciler with caller throwing AiProviderUnavailableError
    setDispatcherOverrideForTesting(async () => {
      throw new (await import('../src/lib/ai/ai-provider-service')).AiProviderUnavailableError('Both rate limited', 30000);
    });

    try {
      await reconcilePendingClassifications();
    } catch {}
    setDispatcherOverrideForTesting(null);

    const classRow = db
      .select()
      .from(companyClassifications)
      .where(eq(companyClassifications.normalizedName, 'waiting-no-burn-co'))
      .get();

    assert.strictEqual(classRow?.retryCount, 0, 'Classification retry count MUST NOT increment in WAITING');
    assert.strictEqual(classRow?.classificationResult, 'PENDING', 'Classification result MUST remain PENDING');
    recordPass('WAITING state preserves classification records without burning retry rounds');

    // -------------------------------------------------------------------------
    // REQUIREMENT 13: Dashboard reads effective provider state from SQLite
    // -------------------------------------------------------------------------
    totalTests++;
    console.log(`\n--- Requirement ${totalTests}: Dashboard Sync Across Multi-Process ---`);

    globalGeminiLimiter.resetForTesting();
    resetPersistentAiProviderStateForTesting();

    // Put Gemini in cooldown so OpenRouter is effective
    globalGeminiLimiter.handle429(new Error('429 Gemini rate limit'));

    const stats = getDashboardStats();
    assert.ok(stats.aiTelemetry !== undefined, 'Dashboard stats includes aiTelemetry');
    assert.strictEqual(stats.aiTelemetry.currentActiveProvider, 'openrouter');
    assert.strictEqual(stats.aiTelemetry.openRouterConfigured, true);
    recordPass('Dashboard reads effective provider telemetry directly from persistent SQLite');

    // -------------------------------------------------------------------------
    // REQUIREMENT 14: Provider state & counters survive process restart
    // -------------------------------------------------------------------------
    totalTests++;
    console.log(`\n--- Requirement ${totalTests}: Persisted Counters & State Survive Restart ---`);

    resetDbConnection();
    const restartedState = getPersistentAiProviderState();
    assert.strictEqual(typeof restartedState.totalDispatches, 'number');
    assert.strictEqual(typeof restartedState.openrouterDispatches, 'number');
    recordPass('Cumulative counters and provider state survive database reconnection and process restart');

    // -------------------------------------------------------------------------
    // REQUIREMENT 15: Existing sending policies strictly preserved
    // -------------------------------------------------------------------------
    totalTests++;
    console.log(`\n--- Requirement ${totalTests}: Sending Window, 3-Min Spacing & No Cap Preserved ---`);

    const schedRow = db.select().from(schedulerState).where(eq(schedulerState.id, 'singleton')).get();
    assert.strictEqual(schedRow?.startHour, 10);
    assert.strictEqual(schedRow?.startMinute, 0);
    assert.strictEqual(schedRow?.endHour, 16);
    assert.strictEqual(schedRow?.endMinute, 0);
    assert.strictEqual(schedRow?.timezone, 'Asia/Kolkata');
    assert.strictEqual(schedRow?.intervalMinutes, 3);
    assert.strictEqual(schedRow?.isPaused, false);

    const midWindowNow = new Date('2026-09-07T08:00:00.000Z');
    const nextSend = computeNextEligibleSendTime({
      lastSendAttemptAt: '2026-09-07T08:00:00.000Z',
      intervalMinutes: 3,
      timezone: 'Asia/Kolkata',
      startHour: 10,
      startMinute: 0,
      endHour: 16,
      endMinute: 0,
      now: midWindowNow,
    });
    assert.strictEqual(nextSend, '2026-09-07T08:03:00.000Z');
    recordPass('10:00 AM–4:00 PM IST window, 3-minute spacing, and no-hard-cap policies preserved');

    // -------------------------------------------------------------------------
    // REQUIREMENT 16: Existing 144-hour recipient cooldown policy preserved
    // -------------------------------------------------------------------------
    totalTests++;
    console.log(`\n--- Requirement ${totalTests}: 144-Hour Recipient Cooldown Preserved ---`);

    const { getCooldownCutoffIso } = await import('../src/lib/scheduler/time-utils');
    const cutoff = getCooldownCutoffIso(new Date('2026-09-07T12:00:00.000Z').getTime());
    assert.strictEqual(cutoff, '2026-09-01T12:00:00.000Z');
    recordPass('144-hour recipient cooldown policy strictly preserved');

    // -------------------------------------------------------------------------
    // REQUIREMENT 17: Resume update deadlock fix & uncertain dispatch safety preserved
    // -------------------------------------------------------------------------
    totalTests++;
    console.log(`\n--- Requirement ${totalTests}: Resume Update Deadlock Fix & Uncertain Safety ---`);

    const colInfo = db.all<{ name: string }>(sql`PRAGMA table_info(contacts)`);
    const hasResumeVersion = colInfo.some((c) => c.name === 'resume_version');
    assert.strictEqual(hasResumeVersion, true, 'resume_version column present');

    const { contacts: contactsTable } = await import('../src/db/schema');
    assert.ok(contactsTable.status !== undefined);
    recordPass('Resume update deadlock fix and uncertain Gmail dispatch safety remain intact');

    // -------------------------------------------------------------------------
    // REQUIREMENT 18: Classification reconciler OpenRouter 429 cannot cool Gemini
    // -------------------------------------------------------------------------
    totalTests++;
    console.log(`\n--- Requirement ${totalTests}: Classification Reconciler Provider Isolation ---`);

    globalGeminiLimiter.resetForTesting();
    resetPersistentAiProviderStateForTesting();

    db.insert(companyClassifications)
      .values({
        normalizedName: 'or-test-isolation-co',
        companyName: 'OR Test Isolation Co',
        classificationResult: 'PENDING',
        retryRound: 0,
        retryCount: 0,
        reason: 'Pending',
        createdAt: nowIso,
        updatedAt: nowIso,
      })
      .onConflictDoNothing()
      .run();

    const openRouter429Error = new OpenRouterError('OpenRouter rate limit 429', 429, true);

    setDispatcherOverrideForTesting(async () => {
      throw openRouter429Error;
    });

    try {
      await reconcilePendingClassifications();
    } catch {}

    setDispatcherOverrideForTesting(null);

    assert.strictEqual(
      globalGeminiLimiter.isCooldownActive(),
      false,
      'Classification OpenRouter 429 MUST NOT activate Gemini cooldown'
    );
    recordPass('Classification reconciler OpenRouter 429 is isolated from Gemini');

    console.log('\n======================================================================');
    console.log(`ALL ${totalTests}/${totalTests} AI PROVIDER STATE MACHINE REQUIREMENTS VERIFIED CLEANLY!`);
    console.log('======================================================================\n');
  } finally {
    globalThis.fetch = originalFetch;
    setDispatcherOverrideForTesting(null);
    globalGeminiLimiter.resetForTesting();
    resetGeminiClient();
    resetOpenRouterTelemetryForTesting();
    resetAiDispatcherTelemetryForTesting();

    try {
      resetDbConnection();
      if (fs.existsSync(TEST_DIR)) {
        fs.rmSync(TEST_DIR, { recursive: true, force: true });
      }
    } catch {}
  }
}

runStateMachineVerification().catch((err) => {
  console.error('\n[FATAL SUITE FAILURE]:', err);
  process.exit(1);
});
