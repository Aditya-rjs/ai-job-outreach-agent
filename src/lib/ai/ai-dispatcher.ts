import {
  callGemini,
  globalGeminiLimiter,
  categorizeGeminiError,
  GEMINI_PRIORITIES,
} from './gemini-client';
import {
  callOpenRouter,
  isOpenRouterConfigured,
  getOpenRouterModel,
  isOpenRouterError,
  type OpenRouterCallResult,
} from './openrouter-client';
import {
  getPersistentAiProviderState,
  isOpenRouterCooldownActive,
  getOpenRouterCooldownRemainingMs,
  isGeminiCooldownActive,
  getGeminiCooldownRemainingMs,
  computeEffectiveActiveProvider,
  recordOpenRouter429,
  recordGemini429,
  recordGeminiFailure,
  recordGeminiTransientFailure,
  recordGeminiSuccess,
  recordOpenRouterSuccess,
  recordOpenRouterNon429Failure,
  setPersistentActiveProvider,
  resetPersistentAiProviderStateForTesting,
  AiProviderUnavailableError,
  isAiProviderUnavailableError,
  type AiProviderStatusType,
} from './ai-provider-service';
import { normalizeGenerationError } from '../pipeline/generation-error-boundary';

export {
  AiProviderUnavailableError,
  isAiProviderUnavailableError,
  type AiProviderStatusType,
};

export type AiProvider = 'gemini' | 'openrouter';

export interface AiCallOptions {
  temperature?: number;
  priority?: number;
  taskName?: string;
  model?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

export interface AiCallResult {
  text: string;
  provider: AiProvider;
  model: string;
}

export interface AiDispatcherTelemetry {
  currentActiveProvider: 'gemini' | 'openrouter' | 'waiting';
  geminiCooldownActive: boolean;
  geminiCooldownUntil: string | null;
  geminiCooldownRemainingSeconds: number;
  openRouterCooldownActive: boolean;
  openRouterCooldownUntil: string | null;
  openRouterCooldownRemainingSeconds: number;
  openRouterConfigured: boolean;
  openRouterModel: string;
  totalDispatches: number;
  geminiSuccesses: number;
  geminiFailures: number;
  gemini429Count: number;
  openRouterDispatches: number;
  openRouterSuccesses: number;
  openRouterFailures: number;
  fallbackCount: number;
  lastFallbackAt: string | null;
}

let customDispatcherOverride:
  | ((prompt: string, options?: AiCallOptions) => Promise<AiCallResult>)
  | null = null;

export function setDispatcherOverrideForTesting(
  override: ((prompt: string, options?: AiCallOptions) => Promise<AiCallResult>) | null
): void {
  customDispatcherOverride = override;
}

export function resetAiDispatcherTelemetryForTesting(): void {
  customDispatcherOverride = null;
  try {
    resetPersistentAiProviderStateForTesting();
  } catch {
    // DB might be uninitialized in isolated unit test
  }
}

/**
 * Returns current authoritative provider status and dispatch statistics.
 * Reads directly from persistent SQLite storage to ensure sync between worker and web processes.
 */
export function getAiDispatcherTelemetry(nowMs: number = Date.now()): AiDispatcherTelemetry {
  let pState;
  try {
    pState = getPersistentAiProviderState();
  } catch {
    pState = {
      activeProvider: 'gemini' as const,
      geminiCooldownUntil: null,
      geminiLastError: null,
      openrouterCooldownUntil: null,
      openrouterLastError: null,
      totalDispatches: 0,
      geminiSuccesses: 0,
      geminiFailures: 0,
      gemini429Count: 0,
      openrouterDispatches: 0,
      openrouterSuccesses: 0,
      openrouterFailures: 0,
      fallbackCount: 0,
      lastFallbackAt: null,
      updatedAt: new Date().toISOString(),
    };
  }

  const geminiCooldownActive = isGeminiCooldownActive(pState, nowMs);
  const openRouterCooldownActive = isOpenRouterCooldownActive(pState, nowMs);
  const openRouterReady = isOpenRouterConfigured();

  // Reconcile effective current provider strictly based on priority
  const currentActive = computeEffectiveActiveProvider(pState, nowMs);

  // Synchronize persisted SQLite state if drifted from live cooldown reality
  if (pState.activeProvider !== currentActive) {
    try {
      setPersistentActiveProvider(currentActive);
    } catch {}
  }

  const geminiRemainingMs = getGeminiCooldownRemainingMs(pState, nowMs);
  const openRouterRemainingMs = getOpenRouterCooldownRemainingMs(pState, nowMs);

  return {
    currentActiveProvider: currentActive,
    geminiCooldownActive,
    geminiCooldownUntil: globalGeminiLimiter.getCooldownUntilIso() || pState.geminiCooldownUntil,
    geminiCooldownRemainingSeconds: Math.ceil(geminiRemainingMs / 1000),
    openRouterCooldownActive,
    openRouterCooldownUntil: pState.openrouterCooldownUntil,
    openRouterCooldownRemainingSeconds: Math.ceil(openRouterRemainingMs / 1000),
    openRouterConfigured: openRouterReady,
    openRouterModel: getOpenRouterModel(),
    totalDispatches: pState.totalDispatches,
    geminiSuccesses: pState.geminiSuccesses,
    geminiFailures: pState.geminiFailures,
    gemini429Count: pState.gemini429Count,
    openRouterDispatches: pState.openrouterDispatches,
    openRouterSuccesses: pState.openrouterSuccesses,
    openRouterFailures: pState.openrouterFailures,
    fallbackCount: pState.fallbackCount,
    lastFallbackAt: pState.lastFallbackAt,
  };
}

/**
 * Executes a call to OpenRouter with rate-limit tracking and recovery checking.
 */
async function executeOpenRouterDispatch(
  prompt: string,
  options: AiCallOptions
): Promise<AiCallResult> {
  const openRouterModel = getOpenRouterModel();
  try {
    const openRouterRes: OpenRouterCallResult = await callOpenRouter(prompt, {
      temperature: options.temperature,
      timeoutMs: options.timeoutMs,
      taskName: options.taskName,
    });

    try {
      recordOpenRouterSuccess();
    } catch {}

    return {
      text: openRouterRes.text,
      provider: 'openrouter',
      model: openRouterRes.model,
    };
  } catch (openRouterErr: unknown) {
    const isOr429 =
      (isOpenRouterError(openRouterErr) && openRouterErr.isRateLimit) ||
      (openRouterErr as { statusCode?: number })?.statusCode === 429 ||
      /\b429\b/.test((openRouterErr as Error)?.message || '');

    if (isOr429) {
      console.warn(
        `[AiDispatcher] OpenRouter returned HTTP 429 rate limit. Recording OpenRouter cooldown.`
      );
      try {
        recordOpenRouter429((openRouterErr as Error)?.message || 'OpenRouter rate limit 429', 60000);
      } catch {}

      // Refresh persistent state
      const freshPState = getPersistentAiProviderState();

      // Check if Gemini has recovered in the meantime
      if (!isGeminiCooldownActive(freshPState)) {
        console.log(
          `[AiDispatcher] OpenRouter rate limited, but Gemini cooldown has expired. Immediately returning to Gemini as primary.`
        );
        try {
          setPersistentActiveProvider('gemini');
        } catch {}

        const configuredGeminiModel = process.env.GEMINI_MODEL?.trim() || 'gemini-3.8-flash';
        const text = await callGemini(prompt, {
          model: configuredGeminiModel,
          temperature: options.temperature,
          priority: options.priority ?? GEMINI_PRIORITIES.EMAIL_GENERATION,
          taskName: options.taskName,
          timeoutMs: options.timeoutMs,
          maxRetries: options.maxRetries,
        });

        try {
          recordGeminiSuccess();
        } catch {}

        return {
          text,
          provider: 'gemini',
          model: configuredGeminiModel,
        };
      }

      // Gemini is still in cooldown -> Transition to WAITING state
      try {
        setPersistentActiveProvider('waiting');
      } catch {}

      const geminiWaitMs = getGeminiCooldownRemainingMs(freshPState);
      const orWaitMs = getOpenRouterCooldownRemainingMs(freshPState);
      let waitRemainingMs: number;
      if (geminiWaitMs > 0 && orWaitMs > 0) {
        waitRemainingMs = Math.min(geminiWaitMs, orWaitMs);
      } else if (geminiWaitMs > 0) {
        waitRemainingMs = geminiWaitMs;
      } else if (orWaitMs > 0) {
        waitRemainingMs = orWaitMs;
      } else {
        waitRemainingMs = 5000;
      }
      waitRemainingMs = Math.max(1000, waitRemainingMs);

      const nextToRecover = (orWaitMs > 0 && (geminiWaitMs <= 0 || orWaitMs < geminiWaitMs))
        ? 'OpenRouter'
        : 'Gemini';

      console.warn(
        `[AiDispatcher] Both Gemini and OpenRouter are rate-limited. Entering WAITING state (${Math.ceil(
          waitRemainingMs / 1000
        )}s until ${nextToRecover} recovery).`
      );

      throw new AiProviderUnavailableError(
        `Both Gemini and OpenRouter are temporarily rate-limited. Waiting for ${nextToRecover} recovery in ${Math.ceil(
          waitRemainingMs / 1000
        )}s.`,
        waitRemainingMs
      );
    }

    // Non-429 OpenRouter failure
    try {
      recordOpenRouterNon429Failure((openRouterErr as Error)?.message || 'OpenRouter error');
    } catch {}

    throw openRouterErr;
  }
}

/**
 * Primary AI Dispatcher.
 * 
 * Strict State Machine:
 * 1. GEMINI ACTIVE: Gemini is always primary. When healthy, all tasks use Gemini.
 * 2. GEMINI RATE LIMITED: On Gemini HTTP 429, records cooldown, immediately falls back to OpenRouter.
 * 3. OPENROUTER ACTIVE: Handles AI tasks while Gemini is in cooldown.
 * 4. OPENROUTER RATE LIMITED: On OpenRouter HTTP 429, records OpenRouter cooldown (does NOT touch Gemini cooldown).
 *    Checks if Gemini recovered. If recovered -> GEMINI ACTIVE. If not -> WAITING.
 * 5. WAITING: Both providers in cooldown. Reconcilers pause without burning contact retries.
 * 6. RECOVERY: When Gemini cooldown expires, Gemini automatically resumes as primary.
 */
export async function callAi(
  prompt: string,
  options: AiCallOptions = {}
): Promise<AiCallResult> {
  if (customDispatcherOverride) {
    return customDispatcherOverride(prompt, options);
  }

  const configuredGeminiModel = process.env.GEMINI_MODEL?.trim() || 'gemini-3.8-flash';
  const openRouterConfigured = isOpenRouterConfigured();

  let pState;
  try {
    pState = getPersistentAiProviderState();
  } catch {
    pState = null;
  }

  const now = Date.now();
  const geminiCooldownActive = isGeminiCooldownActive(pState || undefined, now);
  const openRouterCooldownActive = isOpenRouterCooldownActive(pState || undefined, now);

  // ---------------------------------------------------------------------------
  // Case 1: Gemini is Available (GEMINI ACTIVE) - Primary Provider
  // ---------------------------------------------------------------------------
  if (!geminiCooldownActive) {
    try {
      setPersistentActiveProvider('gemini');
    } catch {}

    try {
      const text = await callGemini(prompt, {
        model: configuredGeminiModel,
        temperature: options.temperature,
        priority: options.priority ?? GEMINI_PRIORITIES.EMAIL_GENERATION,
        taskName: options.taskName,
        timeoutMs: options.timeoutMs,
        maxRetries: options.maxRetries,
      });

      try {
        recordGeminiSuccess();
      } catch {}

      return {
        text,
        provider: 'gemini',
        model: configuredGeminiModel,
      };
    } catch (geminiErr: unknown) {
      // Semantically normalize the error using the Universal Error Boundary
      const normDiag = normalizeGenerationError(geminiErr, { provider: 'gemini' });
      const diag = categorizeGeminiError(geminiErr);

      const isRateLimit =
        normDiag.category === 'PROVIDER_RATE_LIMIT' ||
        diag.code === 'RATE_LIMIT_EXCEEDED' ||
        /\b429\b/.test(diag.safeDetail) ||
        /RESOURCE_EXHAUSTED/i.test(diag.safeDetail);

      const isTransientInfrastructureFailure =
        normDiag.category === 'PROVIDER_OUTAGE_5XX' ||
        normDiag.category === 'NETWORK_TRANSPORT_ERROR';

      // -----------------------------------------------------------------------
      // Case 1A: Gemini Rate Limit (HTTP 429 / Quota Exceeded)
      // -----------------------------------------------------------------------
      if (isRateLimit) {
        if (!globalGeminiLimiter.isCooldownActive()) {
          globalGeminiLimiter.handle429(geminiErr);
        }

        const cooldownIso = globalGeminiLimiter.getCooldownUntilIso() || new Date(Date.now() + 60000).toISOString();
        try {
          recordGemini429(cooldownIso, diag.safeDetail);
        } catch {}

        const freshState = getPersistentAiProviderState();
        const orCooled = isOpenRouterCooldownActive(freshState);

        if (openRouterConfigured && !orCooled) {
          console.warn(
            `[AiDispatcher] Gemini rate limit exceeded (429). Falling back immediately to OpenRouter (${getOpenRouterModel()}).`
          );
          try {
            setPersistentActiveProvider('openrouter');
          } catch {}
          return executeOpenRouterDispatch(prompt, options);
        }

        // Both are in cooldown or OpenRouter not configured -> WAITING
        try {
          setPersistentActiveProvider('waiting');
        } catch {}

        const geminiWaitMs = getGeminiCooldownRemainingMs(freshState);
        const orWaitMs = getOpenRouterCooldownRemainingMs(freshState);
        let waitRemainingMs: number;
        if (geminiWaitMs > 0 && orWaitMs > 0) {
          waitRemainingMs = Math.min(geminiWaitMs, orWaitMs);
        } else if (geminiWaitMs > 0) {
          waitRemainingMs = geminiWaitMs;
        } else if (orWaitMs > 0) {
          waitRemainingMs = orWaitMs;
        } else {
          waitRemainingMs = 5000;
        }
        waitRemainingMs = Math.max(1000, waitRemainingMs);

        const nextToRecover = (orWaitMs > 0 && (geminiWaitMs <= 0 || orWaitMs < geminiWaitMs))
          ? 'OpenRouter'
          : 'Gemini';

        throw new AiProviderUnavailableError(
          `Gemini rate limit exceeded and OpenRouter is ${
            orCooled ? 'rate limited' : 'not configured'
          }. State: WAITING (${Math.ceil(waitRemainingMs / 1000)}s until ${nextToRecover} recovery).`,
          waitRemainingMs
        );
      }

      // -----------------------------------------------------------------------
      // Case 1B: Gemini Transient Infrastructure Failure (5xx, Network, Transport, Timeout)
      // -----------------------------------------------------------------------
      if (isTransientInfrastructureFailure) {
        // Set short 30s transient outage cooldown on Gemini in limiter and SQLite
        globalGeminiLimiter.handleTransientOutage(30000);

        const freshState = getPersistentAiProviderState();
        const orCooled = isOpenRouterCooldownActive(freshState);

        if (openRouterConfigured && !orCooled) {
          console.warn(
            `[AiDispatcher] Gemini transient infrastructure failure (${normDiag.category}: ${normDiag.safeMessage}). Gemini cooling for 30s. Falling back to OpenRouter (${getOpenRouterModel()}).`
          );
          try {
            recordGeminiTransientFailure(normDiag.safeMessage, true, 30000);
          } catch {}

          return executeOpenRouterDispatch(prompt, options);
        }

        // OpenRouter not available: record transient failure cooldown without fallback
        try {
          recordGeminiTransientFailure(normDiag.safeMessage, false, 30000);
        } catch {}

        throw geminiErr;
      }

      // -----------------------------------------------------------------------
      // Case 1C: Non-Failover Gemini Error (Auth, Safety Refusal, AI Output Malformed, Deterministic)
      // -----------------------------------------------------------------------
      try {
        recordGeminiFailure(normDiag.safeMessage || diag.safeDetail);
      } catch {}

      throw geminiErr;
    }
  }

  // ---------------------------------------------------------------------------
  // Case 2: Gemini is in Cooldown, but OpenRouter is Available -> OPENROUTER ACTIVE
  // ---------------------------------------------------------------------------
  if (openRouterConfigured && !openRouterCooldownActive) {
    console.log(
      `[AiDispatcher] Gemini is in 429 cooldown. Routing to OpenRouter (${getOpenRouterModel()}).`
    );
    try {
      setPersistentActiveProvider('openrouter');
    } catch {}
    return executeOpenRouterDispatch(prompt, options);
  }

  // ---------------------------------------------------------------------------
  // Case 3: Both Providers are Unavailable -> WAITING
  // ---------------------------------------------------------------------------
  try {
    setPersistentActiveProvider('waiting');
  } catch {}

  const geminiWaitMs = getGeminiCooldownRemainingMs(pState || undefined);
  const orWaitMs = getOpenRouterCooldownRemainingMs(pState || undefined);

  // Wait duration is until whichever provider recovers FIRST!
  let waitRemainingMs: number;
  if (geminiWaitMs > 0 && orWaitMs > 0) {
    waitRemainingMs = Math.min(geminiWaitMs, orWaitMs);
  } else if (geminiWaitMs > 0) {
    waitRemainingMs = geminiWaitMs;
  } else if (orWaitMs > 0) {
    waitRemainingMs = orWaitMs;
  } else {
    waitRemainingMs = 5000;
  }
  waitRemainingMs = Math.max(1000, waitRemainingMs);

  const nextToRecover = (orWaitMs > 0 && (geminiWaitMs <= 0 || orWaitMs < geminiWaitMs))
    ? 'OpenRouter'
    : 'Gemini';

  console.warn(
    `[AiDispatcher] Both AI providers unavailable (Gemini cooldown active; OpenRouter ${
      openRouterCooldownActive ? 'cooldown active' : 'not configured'
    }). State: WAITING (${Math.ceil(waitRemainingMs / 1000)}s until ${nextToRecover} recovery).`
  );

  throw new AiProviderUnavailableError(
    `Both AI providers are temporarily unavailable. Waiting for ${nextToRecover} recovery in ${Math.ceil(
      waitRemainingMs / 1000
    )}s.`,
    waitRemainingMs
  );
}
