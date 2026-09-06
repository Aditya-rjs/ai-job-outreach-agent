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
} from './openrouter-client';

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
  currentActiveProvider: AiProvider;
  geminiCooldownActive: boolean;
  geminiCooldownUntil: string | null;
  geminiCooldownRemainingSeconds: number;
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

let totalDispatches = 0;
let geminiSuccesses = 0;
let geminiFailures = 0;
let gemini429Count = 0;
let openRouterDispatches = 0;
let openRouterSuccesses = 0;
let openRouterFailures = 0;
let fallbackCount = 0;
let lastFallbackAt: string | null = null;

let customDispatcherOverride:
  | ((prompt: string, options?: AiCallOptions) => Promise<AiCallResult>)
  | null = null;

export function setDispatcherOverrideForTesting(
  override: ((prompt: string, options?: AiCallOptions) => Promise<AiCallResult>) | null
): void {
  customDispatcherOverride = override;
}

export function resetAiDispatcherTelemetryForTesting(): void {
  totalDispatches = 0;
  geminiSuccesses = 0;
  geminiFailures = 0;
  gemini429Count = 0;
  openRouterDispatches = 0;
  openRouterSuccesses = 0;
  openRouterFailures = 0;
  fallbackCount = 0;
  lastFallbackAt = null;
  customDispatcherOverride = null;
}

/**
 * Returns current provider status and dispatch statistics.
 * Never logs or exposes API keys.
 */
export function getAiDispatcherTelemetry(): AiDispatcherTelemetry {
  const isCooldown = globalGeminiLimiter.isCooldownActive();
  const openRouterReady = isOpenRouterConfigured();
  const currentProvider: AiProvider = isCooldown && openRouterReady ? 'openrouter' : 'gemini';

  return {
    currentActiveProvider: currentProvider,
    geminiCooldownActive: isCooldown,
    geminiCooldownUntil: globalGeminiLimiter.getCooldownUntilIso(),
    geminiCooldownRemainingSeconds: Math.ceil(globalGeminiLimiter.getCooldownRemainingMs() / 1000),
    openRouterConfigured: openRouterReady,
    openRouterModel: getOpenRouterModel(),
    totalDispatches,
    geminiSuccesses,
    geminiFailures,
    gemini429Count,
    openRouterDispatches,
    openRouterSuccesses,
    openRouterFailures,
    fallbackCount,
    lastFallbackAt,
  };
}

/**
 * Primary AI Dispatcher.
 * 
 * Rules:
 * 1. Gemini is always primary.
 * 2. If Gemini succeeds, returns Gemini result.
 * 3. If Gemini is in an active 429 cooldown, immediately routes to OpenRouter (if configured).
 * 4. If Gemini returns 429 / RATE_LIMIT_EXCEEDED, records Gemini 429 cooldown and immediately
 *    falls back to OpenRouter (Free Models Router 'openrouter/free').
 * 5. When Gemini cooldown expires, Gemini automatically becomes primary again.
 * 6. If OpenRouter is not configured or fails, Gemini error handling semantics are preserved.
 */
export async function callAi(
  prompt: string,
  options: AiCallOptions = {}
): Promise<AiCallResult> {
  if (customDispatcherOverride) {
    return customDispatcherOverride(prompt, options);
  }

  totalDispatches++;

  const configuredGeminiModel = process.env.GEMINI_MODEL?.trim() || 'gemini-3.8-flash';
  const openRouterConfigured = isOpenRouterConfigured();

  // If Gemini is already in an active 429 cooldown and OpenRouter is available, route directly to OpenRouter
  if (globalGeminiLimiter.isCooldownActive() && openRouterConfigured) {
    console.log(
      `[AiDispatcher] Gemini is in 429 cooldown (until ${globalGeminiLimiter.getCooldownUntilIso()}). Routing directly to OpenRouter (${getOpenRouterModel()}).`
    );
    openRouterDispatches++;
    try {
      const openRouterRes = await callOpenRouter(prompt, {
        temperature: options.temperature,
        timeoutMs: options.timeoutMs,
        taskName: options.taskName,
      });
      openRouterSuccesses++;
      return {
        text: openRouterRes.text,
        provider: 'openrouter',
        model: openRouterRes.model,
      };
    } catch (openRouterErr) {
      openRouterFailures++;
      console.warn('[AiDispatcher] Direct OpenRouter call failed during Gemini cooldown:', openRouterErr);
      throw openRouterErr;
    }
  }

  // Otherwise, attempt Gemini as primary
  try {
    const text = await callGemini(prompt, {
      model: configuredGeminiModel,
      temperature: options.temperature,
      priority: options.priority ?? GEMINI_PRIORITIES.EMAIL_GENERATION,
      taskName: options.taskName,
      timeoutMs: options.timeoutMs,
      maxRetries: options.maxRetries,
    });

    geminiSuccesses++;
    return {
      text,
      provider: 'gemini',
      model: configuredGeminiModel,
    };
  } catch (geminiErr: unknown) {
    geminiFailures++;
    const diag = categorizeGeminiError(geminiErr);

    const isRateLimit =
      diag.code === 'RATE_LIMIT_EXCEEDED' ||
      /\b429\b/.test(diag.safeDetail) ||
      /RESOURCE_EXHAUSTED/i.test(diag.safeDetail);

    if (isRateLimit) {
      gemini429Count++;
      // Ensure global limiter records 429 cooldown
      if (!globalGeminiLimiter.isCooldownActive()) {
        globalGeminiLimiter.handle429(geminiErr);
      }

      if (openRouterConfigured) {
        fallbackCount++;
        lastFallbackAt = new Date().toISOString();
        console.warn(
          `[AiDispatcher] Gemini rate limit exceeded (429). Falling back immediately to OpenRouter Free Models Router (${getOpenRouterModel()}).`
        );

        openRouterDispatches++;
        try {
          const openRouterRes = await callOpenRouter(prompt, {
            temperature: options.temperature,
            timeoutMs: options.timeoutMs,
            taskName: options.taskName,
          });
          openRouterSuccesses++;
          return {
            text: openRouterRes.text,
            provider: 'openrouter',
            model: openRouterRes.model,
          };
        } catch (openRouterErr) {
          openRouterFailures++;
          console.error('[AiDispatcher] OpenRouter fallback also failed:', openRouterErr);
          throw openRouterErr;
        }
      }
    }

    // Rethrow Gemini error if not rate-limited or OpenRouter is not configured
    throw geminiErr;
  }
}
