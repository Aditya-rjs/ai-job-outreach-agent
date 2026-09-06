import { sanitizeSecretText } from './gemini-client';

export interface OpenRouterCallOptions {
  model?: string;
  temperature?: number;
  maxRetries?: number;
  timeoutMs?: number;
  taskName?: string;
}

export interface OpenRouterCallResult {
  text: string;
  model: string;
  provider: 'openrouter';
}

export class OpenRouterError extends Error {
  public readonly provider = 'openrouter' as const;
  public readonly statusCode?: number;
  public readonly isRateLimit: boolean;

  constructor(message: string, statusCode?: number, isRateLimit: boolean = false) {
    super(message);
    this.name = 'OpenRouterError';
    this.statusCode = statusCode;
    this.isRateLimit = isRateLimit;
    Object.setPrototypeOf(this, OpenRouterError.prototype);
  }
}

export function isOpenRouterError(error: unknown): error is OpenRouterError {
  return (
    error instanceof OpenRouterError ||
    (typeof error === 'object' &&
      error !== null &&
      'provider' in error &&
      (error as { provider: unknown }).provider === 'openrouter')
  );
}

export interface OpenRouterTelemetry {
  currentModel: string;
  isConfigured: boolean;
  totalRequests: number;
  requestsStarted: number;
  requestsSucceeded: number;
  requestsFailed: number;
  rateLimit429Count: number;
  lastError: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
}

let requestsStarted = 0;
let requestsSucceeded = 0;
let requestsFailed = 0;
let rateLimit429Count = 0;
let lastError: string | null = null;
let lastSuccessAt: string | null = null;
let lastFailureAt: string | null = null;

export function isOpenRouterConfigured(): boolean {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  return Boolean(key && key.length > 0);
}

export function getOpenRouterModel(): string {
  return process.env.OPENROUTER_MODEL?.trim() || 'openrouter/free';
}

export function getOpenRouterTelemetry(): OpenRouterTelemetry {
  return {
    currentModel: getOpenRouterModel(),
    isConfigured: isOpenRouterConfigured(),
    totalRequests: requestsStarted,
    requestsStarted,
    requestsSucceeded,
    requestsFailed,
    rateLimit429Count,
    lastError,
    lastSuccessAt,
    lastFailureAt,
  };
}

export function resetOpenRouterTelemetryForTesting(): void {
  requestsStarted = 0;
  requestsSucceeded = 0;
  requestsFailed = 0;
  rateLimit429Count = 0;
  lastError = null;
  lastSuccessAt = null;
  lastFailureAt = null;
}

export function recordOpenRouterFailure(code: string, message: string): void {
  requestsStarted++;
  requestsFailed++;
  lastFailureAt = new Date().toISOString();
  lastError = sanitizeSecretText(message);
  if (code === 'RATE_LIMIT_EXCEEDED' || /\b429\b/.test(message)) {
    rateLimit429Count++;
  }
}

/**
 * Calls OpenRouter chat completions API using native fetch.
 * Uses the free models router ('openrouter/free') by default.
 * Redacts secrets, keys, and tokens from all error messages.
 */
export async function callOpenRouter(
  prompt: string,
  options: OpenRouterCallOptions = {}
): Promise<OpenRouterCallResult> {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is not configured in the environment.');
  }

  const model = options.model?.trim() || getOpenRouterModel();
  const maxRetries = options.maxRetries ?? 2;
  const timeoutMs = options.timeoutMs ?? 20000;
  const temperature = options.temperature ?? 0.1;

  requestsStarted++;
  let currentError: unknown = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const appUrl = process.env.NEXT_PUBLIC_APP_URL?.trim() || 'http://localhost:3000';

      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': appUrl,
          'X-Title': 'AI Job Outreach Agent',
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: 'user',
              content: prompt,
            },
          ],
          temperature,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        const sanitizedBody = sanitizeSecretText(errorBody);
        const statusText = response.statusText || 'Error';
        const msg = `OpenRouter API HTTP ${response.status} (${statusText}): ${sanitizedBody}`;

        // Rate limit 429
        if (response.status === 429) {
          rateLimit429Count++;
          throw new OpenRouterError(`OpenRouter rate limit exceeded (429): ${sanitizedBody}`, 429, true);
        }

        // Auth failure (permanent - do not retry)
        if (response.status === 401 || response.status === 403) {
          throw new OpenRouterError(`OpenRouter authentication rejected (${response.status}): ${sanitizedBody}`, response.status, false);
        }

        throw new OpenRouterError(msg, response.status, false);
      }

      const json = await response.json();
      const content = json?.choices?.[0]?.message?.content;

      if (!content || typeof content !== 'string' || content.trim().length === 0) {
        throw new OpenRouterError('Empty response from OpenRouter');
      }

      requestsSucceeded++;
      lastSuccessAt = new Date().toISOString();

      return {
        text: content.trim(),
        model,
        provider: 'openrouter',
      };
    } catch (err: unknown) {
      clearTimeout(timeoutId);
      currentError = err;

      const errMessage = err instanceof Error ? err.message : String(err);
      const sanitized = sanitizeSecretText(errMessage);

      // Do not retry authentication errors or explicit 401/403
      if (/401|403|unauthorized|authentication rejected/i.test(sanitized)) {
        break;
      }

      // If more attempts remain and it's a transient failure (network/timeout/502/503/504)
      if (attempt < maxRetries) {
        const backoffMs = attempt * 1000 + Math.random() * 250;
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        continue;
      }

      break;
    }
  }

  requestsFailed++;
  lastFailureAt = new Date().toISOString();
  const finalErrorMsg = currentError instanceof Error ? currentError.message : String(currentError || 'Unknown OpenRouter failure');
  lastError = sanitizeSecretText(finalErrorMsg);

  if (currentError instanceof OpenRouterError) {
    throw currentError;
  }

  const statusCode = (currentError as { statusCode?: number })?.statusCode;
  const isRateLimit = statusCode === 429 || /\b429\b/.test(lastError);
  throw new OpenRouterError(`OpenRouter call failed: ${lastError}`, statusCode, isRateLimit);
}
