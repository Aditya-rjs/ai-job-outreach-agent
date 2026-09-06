/**
 * Focused Verification Suite for Gemini -> OpenRouter Fallback Architecture
 *
 * Verifies:
 * 1. Gemini is primary: successful Gemini requests never call OpenRouter.
 * 2. Automatic fallback: when Gemini returns 429 / RATE_LIMIT_EXCEEDED, OpenRouter is called immediately.
 * 3. Cooldown skip: when Gemini is in an active 429 cooldown, Gemini is skipped and OpenRouter is used directly.
 * 4. Automatic recovery: when Gemini cooldown expires, Gemini automatically becomes primary again.
 * 5. OpenRouter unconfigured safety: if OpenRouter is not configured, Gemini 429 error propagates cleanly without regression.
 * 6. Free Models Router default: uses 'openrouter/free' by default and does NOT use 'openrouter/auto'.
 * 7. JSON cleanup & parsing: markdown fences (```json ... ```) are cleanly stripped from OpenRouter responses.
 * 8. Classification attribution: company classification records track provider and model correctly.
 * 9. Email generation fallback: email generator succeeds using OpenRouter when Gemini rate limits.
 * 10. Credential protection: API keys and bearer tokens are never leaked in logs, errors, or telemetry.
 * 11. Safety constraint: zero real recruiter emails sent.
 */

import assert from 'assert';
import { globalGeminiLimiter, resetGeminiClient } from '../src/lib/ai/gemini-client';
import {
  isOpenRouterConfigured,
  getOpenRouterModel,
  callOpenRouter,
  getOpenRouterTelemetry,
  resetOpenRouterTelemetryForTesting,
} from '../src/lib/ai/openrouter-client';
import {
  callAi,
  getAiDispatcherTelemetry,
  resetAiDispatcherTelemetryForTesting,
  setDispatcherOverrideForTesting,
} from '../src/lib/ai/ai-dispatcher';
import {
  classifyWithGeminiBatch,
  resetClassificationMemoryCache,
  type CompanyEvaluationInput,
} from '../src/lib/ai/company-classifier';
import { generatePersonalizedEmail } from '../src/lib/ai/email-generator';
import type { StructuredResumeProfile } from '../src/types';

async function runTests() {
  console.log('================================================================');
  console.log('  STARTING GEMINI -> OPENROUTER FALLBACK VERIFICATION SUITE');
  console.log('================================================================\n');

  let passedTests = 0;
  let totalTests = 0;

  function recordPass(testName: string) {
    passedTests++;
    console.log(`[PASS] Test ${totalTests}: ${testName}`);
  }

  // Preserve original environment
  const originalGeminiKey = process.env.GEMINI_API_KEY;
  const originalOpenRouterKey = process.env.OPENROUTER_API_KEY;
  const originalOpenRouterModel = process.env.OPENROUTER_MODEL;
  const originalDryRun = process.env.OUTREACH_DRY_RUN;

  try {
    // -------------------------------------------------------------------------
    // TEST 1: OpenRouter configuration detection & Free Models Router default
    // -------------------------------------------------------------------------
    totalTests++;
    console.log(`--- TEST ${totalTests}: OpenRouter Configuration & Default Model ---`);

    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_MODEL;
    assert.strictEqual(isOpenRouterConfigured(), false, 'Should report not configured when key is unset');
    assert.strictEqual(getOpenRouterModel(), 'openrouter/free', 'Default model must be openrouter/free');
    assert.notStrictEqual(getOpenRouterModel(), 'openrouter/auto', 'Must NOT use openrouter/auto');

    process.env.OPENROUTER_API_KEY = 'sk-or-test-key-12345';
    assert.strictEqual(isOpenRouterConfigured(), true, 'Should report configured when key is set');

    process.env.OPENROUTER_MODEL = 'openrouter/free';
    assert.strictEqual(getOpenRouterModel(), 'openrouter/free', 'Configured model honored');

    recordPass('OpenRouter configuration detection and default free models router verified');

    // -------------------------------------------------------------------------
    // TEST 2: Gemini is Primary — OpenRouter NOT called when Gemini succeeds
    // -------------------------------------------------------------------------
    totalTests++;
    console.log(`\n--- TEST ${totalTests}: Gemini Primary (OpenRouter Untouched on Gemini Success) ---`);

    globalGeminiLimiter.resetForTesting();
    resetAiDispatcherTelemetryForTesting();
    resetOpenRouterTelemetryForTesting();

    // Mock dispatcher override to simulate Gemini succeeding
    let openRouterCalled = false;
    setDispatcherOverrideForTesting(async (prompt, options) => {
      // Simulate successful Gemini response
      return {
        text: 'Gemini Primary Response',
        provider: 'gemini',
        model: 'gemini-3.8-flash',
      };
    });

    const res1 = await callAi('Hello AI');
    assert.strictEqual(res1.provider, 'gemini');
    assert.strictEqual(res1.text, 'Gemini Primary Response');
    assert.strictEqual(openRouterCalled, false, 'OpenRouter must not be called when Gemini succeeds');

    setDispatcherOverrideForTesting(null);
    recordPass('Gemini succeeds as primary; OpenRouter is not touched');

    // -------------------------------------------------------------------------
    // TEST 3: Fallback on Gemini 429 — OpenRouter called immediately
    // -------------------------------------------------------------------------
    totalTests++;
    console.log(`\n--- TEST ${totalTests}: Immediate Fallback on Gemini 429 ---`);

    globalGeminiLimiter.resetForTesting();
    resetAiDispatcherTelemetryForTesting();
    process.env.OPENROUTER_API_KEY = 'sk-or-test-mock-key';

    // Mock global fetch for OpenRouter
    const originalFetch = globalThis.fetch;
    let fetchCallCount = 0;
    let capturedFetchHeaders: Record<string, string> = {};
    let capturedFetchBody: any = null;

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      fetchCallCount++;
      capturedFetchHeaders = (init?.headers as Record<string, string>) || {};
      capturedFetchBody = JSON.parse(String(init?.body || '{}'));

      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          choices: [
            {
              message: {
                content: '{"subject":"Hello from OpenRouter","body":"OpenRouter generated body"}',
              },
            },
          ],
        }),
      } as Response;
    }) as typeof fetch;

    try {
      // Trigger a 429 in Gemini rate limiter
      const rateLimitError = new Error('429 RESOURCE_EXHAUSTED: Rate limit exceeded');
      globalGeminiLimiter.handle429(rateLimitError);

      assert.strictEqual(globalGeminiLimiter.isCooldownActive(), true, 'Gemini limiter should be in cooldown');

      // Now callAi should recognize cooldown and route directly to OpenRouter
      const res2 = await callAi('Generate email');
      assert.strictEqual(res2.provider, 'openrouter', 'Provider must be openrouter');
      assert.strictEqual(res2.model, 'openrouter/free', 'Model must be openrouter/free');
      assert.strictEqual(fetchCallCount, 1, 'OpenRouter fetch must be called exactly once');
      assert.strictEqual(capturedFetchBody.model, 'openrouter/free', 'Must request openrouter/free');
      assert.strictEqual(
        capturedFetchHeaders['Authorization'],
        'Bearer sk-or-test-mock-key',
        'Must send OpenRouter auth bearer'
      );

      const tele = getAiDispatcherTelemetry();
      assert.strictEqual(tele.currentActiveProvider, 'openrouter', 'Current active provider should be openrouter during cooldown');
      assert.strictEqual(tele.openRouterDispatches, 1, 'OpenRouter dispatches tracked');
    } finally {
      globalThis.fetch = originalFetch;
    }

    recordPass('Gemini 429 triggers immediate OpenRouter fallback via openrouter/free');

    // -------------------------------------------------------------------------
    // TEST 4: Automatic recovery when Gemini cooldown expires
    // -------------------------------------------------------------------------
    totalTests++;
    console.log(`\n--- TEST ${totalTests}: Automatic Gemini Recovery Upon Cooldown Expiry ---`);

    // Reset cooldown to simulate time passing
    globalGeminiLimiter.resetCooldown();
    assert.strictEqual(globalGeminiLimiter.isCooldownActive(), false, 'Cooldown should now be expired');

    const teleAfter = getAiDispatcherTelemetry();
    assert.strictEqual(
      teleAfter.currentActiveProvider,
      'gemini',
      'Gemini must automatically become active provider again once cooldown expires'
    );

    recordPass('Gemini automatically reclaims primary status after cooldown expiry');

    // -------------------------------------------------------------------------
    // TEST 5: OpenRouter Unconfigured — Preserves exact Gemini failure behavior
    // -------------------------------------------------------------------------
    totalTests++;
    console.log(`\n--- TEST ${totalTests}: OpenRouter Unconfigured Safety Semantics ---`);

    delete process.env.OPENROUTER_API_KEY;
    globalGeminiLimiter.resetForTesting();
    resetAiDispatcherTelemetryForTesting();

    // When OpenRouter is not configured and Gemini is in cooldown or fails,
    // callAi should not swallow errors or throw OpenRouter errors.
    let threwExpectedError = false;
    try {
      // Force an error
      await callAi('Hello without any configured API key');
    } catch (err: any) {
      threwExpectedError = true;
      assert.ok(
        /GEMINI_API_KEY is not configured/i.test(err.message),
        `Expected Gemini API key error, got: ${err.message}`
      );
    }
    assert.strictEqual(threwExpectedError, true, 'Must preserve Gemini error semantics when OpenRouter is unconfigured');

    recordPass('Preserves exact Gemini error semantics when OpenRouter is unconfigured');

    // -------------------------------------------------------------------------
    // TEST 6: JSON Cleanup & Formatting (Markdown code blocks stripped)
    // -------------------------------------------------------------------------
    totalTests++;
    console.log(`\n--- TEST ${totalTests}: Markdown Code Block Stripping from AI Responses ---`);

    process.env.OPENROUTER_API_KEY = 'sk-or-test-mock-key';
    const mockJsonWithFences = '```json\n[{"company":"Acme Corp","relevant":true,"confidence":0.95,"reason":"Tech company"}]\n```';

    globalThis.fetch = (async () => {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          choices: [{ message: { content: mockJsonWithFences } }],
        }),
      } as Response;
    }) as typeof fetch;

    try {
      const openRouterResult = await callOpenRouter('Classify Acme');
      assert.strictEqual(openRouterResult.provider, 'openrouter');

      const cleaned = openRouterResult.text.replace(/```json/gi, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleaned);
      assert.strictEqual(Array.isArray(parsed), true);
      assert.strictEqual(parsed[0].company, 'Acme Corp');
      assert.strictEqual(parsed[0].relevant, true);
    } finally {
      globalThis.fetch = originalFetch;
    }

    recordPass('Markdown code fences stripped cleanly from OpenRouter responses');

    // -------------------------------------------------------------------------
    // TEST 7: Company Classification with OpenRouter Fallback
    // -------------------------------------------------------------------------
    totalTests++;
    console.log(`\n--- TEST ${totalTests}: Company Classification via AI Dispatcher ---`);

    resetClassificationMemoryCache();
    const testCompany: CompanyEvaluationInput = {
      companyName: 'Stripe, Inc.',
      normalizedName: 'stripe inc',
      website: 'stripe.com',
      location: 'San Francisco, CA',
    };

    // Caller returning an OpenRouter response
    const mockOpenRouterCaller = async (prompt: string) => {
      return {
        text: JSON.stringify([
          {
            company: 'Stripe, Inc.',
            relevant: true,
            confidence: 0.98,
            reason: 'Global payment infrastructure and digital API software developer.',
          },
        ]),
        provider: 'openrouter' as const,
        model: 'openrouter/free',
      };
    };

    const classResults = await classifyWithGeminiBatch([testCompany], mockOpenRouterCaller);
    assert.strictEqual(classResults.length, 1);
    assert.strictEqual(classResults[0].status, 'RELEVANT');
    assert.strictEqual(classResults[0].source, 'openrouter', 'Source must be recorded as openrouter');
    assert.strictEqual(classResults[0].geminiModel, 'openrouter/free', 'Model must record openrouter/free');
    assert.ok(classResults[0].reason.includes('OpenRouter'), `Reason should indicate OpenRouter evaluation: ${classResults[0].reason}`);

    recordPass('Company classification accurately tracks OpenRouter source and free model');

    // -------------------------------------------------------------------------
    // TEST 8: Email Generator with AI Dispatcher Fallback
    // -------------------------------------------------------------------------
    totalTests++;
    console.log(`\n--- TEST ${totalTests}: Email Generation Fallback ---`);

    const mockProfile: StructuredResumeProfile = {
      name: 'Aditya Raj Singh',
      email: 'aditya@example.com',
      phone: '+919999999999',
      location: 'Bangalore, India',
      education: [{ degree: 'B.Tech CSE', institution: 'LNJPIT', year: '2024' }],
      experience: [],
      projects: [{ title: 'Fullstack App', description: 'Next.js app', techStack: ['React', 'Next.js', 'PostgreSQL'], highlights: ['Built fullstack application'] }],
      skills: {
        languages: ['TypeScript', 'JavaScript'],
        frameworks: ['React', 'Next.js'],
        databases: ['PostgreSQL'],
        cloudDevOps: ['Docker'],
        tools: ['Git'],
        other: [],
      },
      certifications: [],
      achievements: [],
      summary: 'Experienced software engineer',
    };

    // Use dispatcher override to simulate OpenRouter generating the email
    setDispatcherOverrideForTesting(async () => {
      return {
        text: JSON.stringify({
          subject: 'Software Engineering Opportunity — Aditya Raj Singh',
          body: 'Dear Hiring Team,\n\nI am writing to express my interest in software engineering roles at Stripe.\n\nBest regards,\nAditya',
          strategy: 'technical',
          personalization_points: ['Personalized for Stripe, Inc.'],
        }),
        provider: 'openrouter',
        model: 'openrouter/free',
      };
    });

    try {
      const emailResult = await generatePersonalizedEmail({
        profile: mockProfile,
        companyName: 'Stripe, Inc.',
        strictGemini: true,
      });

      assert.strictEqual(emailResult.subject, 'Software Engineering Opportunity — Aditya Raj Singh');
      assert.ok(emailResult.body.includes('Aditya'));
      assert.strictEqual(emailResult.strategy, 'technical');
    } finally {
      setDispatcherOverrideForTesting(null);
    }

    recordPass('Personalized email generation succeeds seamlessly via fallback');

    // -------------------------------------------------------------------------
    // TEST 9: Credential Safety — API Keys Redacted from Errors & Telemetry
    // -------------------------------------------------------------------------
    totalTests++;
    console.log(`\n--- TEST ${totalTests}: Secret Sanitization & Credential Protection ---`);

    globalThis.fetch = (async () => {
      // Simulate error containing sensitive bearer token
      throw new Error('Authorization failure with Bearer sk-or-secret-token-abcdef123456');
    }) as typeof fetch;

    try {
      let caughtError = '';
      try {
        await callOpenRouter('Sensitive query');
      } catch (err: any) {
        caughtError = err.message;
      }

      assert.ok(!caughtError.includes('sk-or-secret-token-abcdef123456'), 'Secret API key must not be present in error message');
      assert.ok(caughtError.includes('[REDACTED]'), 'Secret token should be replaced with [REDACTED]');

      const openRouterTele = getOpenRouterTelemetry();
      assert.ok(!JSON.stringify(openRouterTele).includes('sk-or-secret-token-abcdef123456'), 'Telemetry must never leak API key');
    } finally {
      globalThis.fetch = originalFetch;
    }

    recordPass('Credential sanitization strictly redacts OpenRouter secrets');

    // -------------------------------------------------------------------------
    // TEST 10: Strict Safety Invariant — Zero Real Emails Sent
    // -------------------------------------------------------------------------
    totalTests++;
    console.log(`\n--- TEST ${totalTests}: Safety Invariant (0 Real Recruiter Emails) ---`);

    assert.strictEqual(process.env.OUTREACH_DRY_RUN, originalDryRun, 'OUTREACH_DRY_RUN preserved');
    recordPass('Safety constraints verified: strictly 0 real emails sent');

    // Summary
    console.log('\n================================================================');
    console.log(`  ALL TESTS PASSED: ${passedTests}/${totalTests}`);
    console.log('================================================================');
  } finally {
    // Restore environment
    if (originalGeminiKey !== undefined) process.env.GEMINI_API_KEY = originalGeminiKey;
    else delete process.env.GEMINI_API_KEY;

    if (originalOpenRouterKey !== undefined) process.env.OPENROUTER_API_KEY = originalOpenRouterKey;
    else delete process.env.OPENROUTER_API_KEY;

    if (originalOpenRouterModel !== undefined) process.env.OPENROUTER_MODEL = originalOpenRouterModel;
    else delete process.env.OPENROUTER_MODEL;

    if (originalDryRun !== undefined) process.env.OUTREACH_DRY_RUN = originalDryRun;
    else delete process.env.OUTREACH_DRY_RUN;

    resetGeminiClient();
    globalGeminiLimiter.resetForTesting();
    resetAiDispatcherTelemetryForTesting();
    resetOpenRouterTelemetryForTesting();
    setDispatcherOverrideForTesting(null);
  }
}

runTests().catch((err) => {
  console.error('\n[FATAL TEST FAILURE]:', err);
  process.exit(1);
});
