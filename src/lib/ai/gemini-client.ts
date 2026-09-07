import { GoogleGenAI } from '@google/genai';

let clientInstance: GoogleGenAI | null = null;

export function getGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    return null;
  }
  if (!clientInstance) {
    clientInstance = new GoogleGenAI({ apiKey });
  }
  return clientInstance;
}

export function resetGeminiClient(): void {
  clientInstance = null;
}

export interface CategorizedGeminiError {
  code:
    | 'API_KEY_MISSING'
    | 'AUTH_REJECTED'
    | 'PERMISSION_DENIED'
    | 'MODEL_NOT_FOUND'
    | 'BAD_REQUEST'
    | 'RATE_LIMIT_EXCEEDED'
    | 'INTERNAL_ERROR'
    | 'BAD_GATEWAY'
    | 'SERVICE_UNAVAILABLE'
    | 'GATEWAY_TIMEOUT'
    | 'TIMEOUT'
    | 'NETWORK_FAILURE'
    | 'INVALID_OUTPUT'
    | 'SERVICE_ERROR';
  isTransient: boolean;
  safeDetail: string;
  explanation: string;
}

/**
 * Sanitizes error strings to prevent leaking API keys, OAuth tokens, secrets, or sensitive credentials.
 */
export function sanitizeSecretText(str: string): string {
  if (!str) return '';
  return str
    .replace(/AIza[0-9A-Za-z-_]+/g, '[REDACTED_API_KEY]')
    .replace(/ya29\.[0-9A-Za-z-_]+/g, '[REDACTED_ACCESS_TOKEN]')
    .replace(/1\/\/[0-9A-Za-z-_]+/g, '[REDACTED_REFRESH_TOKEN]')
    .replace(/(?:key|secret|token|password|auth|authorization)=[^&\s]+/gi, '$1=[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]')
    .slice(0, 300);
}

/**
 * Categorizes errors returned by the Gemini API or network layer.
 * Strictly separates permanent configuration errors from transient retryable failures.
 */
export function categorizeGeminiError(err: unknown): CategorizedGeminiError {
  const errStr = err instanceof Error ? err.message : String(err || '');
  const sanitized = sanitizeSecretText(errStr);

  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey && (!errStr || /api.*key.*missing/i.test(errStr) || /not configured in the environment/i.test(errStr))) {
    return {
      code: 'API_KEY_MISSING',
      isTransient: false,
      explanation: 'GEMINI_API_KEY is not configured in the environment.',
      safeDetail: 'GEMINI_API_KEY environment variable is missing or empty.',
    };
  }

  // 1. Authentication / Invalid API Key (Permanent)
  if (
    /API_KEY_INVALID/i.test(errStr) ||
    /api key not valid/i.test(errStr) ||
    /\b401\b/.test(errStr) ||
    /invalid api key/i.test(errStr) ||
    /unauthorized/i.test(errStr)
  ) {
    return {
      code: 'AUTH_REJECTED',
      isTransient: false,
      explanation: 'Gemini API key was rejected or is invalid.',
      safeDetail: sanitized,
    };
  }

  // 2. Permission Denied / Project Issue (Permanent)
  if (/PERMISSION_DENIED/i.test(errStr) || /\b403\b/.test(errStr)) {
    return {
      code: 'PERMISSION_DENIED',
      isTransient: false,
      explanation: 'Permission denied for Gemini API. Check Google Cloud project permissions.',
      safeDetail: sanitized,
    };
  }

  // 3. Model Not Found / Invalid Model (Permanent)
  if (
    /\b404\b/.test(errStr) ||
    /NOT_FOUND/i.test(errStr) ||
    /is not found for API version/i.test(errStr) ||
    /model.*not found/i.test(errStr)
  ) {
    return {
      code: 'MODEL_NOT_FOUND',
      isTransient: false,
      explanation: 'Specified Gemini model identifier is not recognized or not available.',
      safeDetail: sanitized,
    };
  }

  // 4. Bad Request / Invalid Arguments (Permanent)
  if (/\b400\b/.test(errStr) || /INVALID_ARGUMENT/i.test(errStr)) {
    return {
      code: 'BAD_REQUEST',
      isTransient: false,
      explanation: 'Malformed Gemini request or incompatible model arguments.',
      safeDetail: sanitized,
    };
  }

  // 5. Rate Limit / Quota Exceeded (Transient)
  if (
    /\b429\b/.test(errStr) ||
    /RESOURCE_EXHAUSTED/i.test(errStr) ||
    /quota exceeded/i.test(errStr) ||
    /rate limit/i.test(errStr)
  ) {
    return {
      code: 'RATE_LIMIT_EXCEEDED',
      isTransient: true,
      explanation: 'Gemini API rate limit or quota exceeded.',
      safeDetail: sanitized,
    };
  }

  // 6. Server Unavailable / Gateway Errors (Transient)
  if (/\b503\b/.test(errStr) || /UNAVAILABLE/i.test(errStr)) {
    return {
      code: 'SERVICE_UNAVAILABLE',
      isTransient: true,
      explanation: 'Gemini service is temporarily unavailable (503).',
      safeDetail: sanitized,
    };
  }

  if (/\b502\b/.test(errStr) || /BAD_GATEWAY/i.test(errStr)) {
    return {
      code: 'BAD_GATEWAY',
      isTransient: true,
      explanation: 'Gemini service bad gateway (502).',
      safeDetail: sanitized,
    };
  }

  if (/\b504\b/.test(errStr) || /GATEWAY_TIMEOUT/i.test(errStr)) {
    return {
      code: 'GATEWAY_TIMEOUT',
      isTransient: true,
      explanation: 'Gemini gateway timeout (504).',
      safeDetail: sanitized,
    };
  }

  if (/\b500\b/.test(errStr) || /INTERNAL/i.test(errStr)) {
    return {
      code: 'INTERNAL_ERROR',
      isTransient: true,
      explanation: 'Gemini internal server error (500).',
      safeDetail: sanitized,
    };
  }

  // 7. Timeout (Transient)
  if (
    /timed out/i.test(errStr) ||
    /AbortError/i.test(errStr) ||
    /ETIMEDOUT/i.test(errStr) ||
    /ESOCKETTIMEDOUT/i.test(errStr)
  ) {
    return {
      code: 'TIMEOUT',
      isTransient: true,
      explanation: 'Gemini request timed out.',
      safeDetail: sanitized,
    };
  }

  // 8. Network Failure (Transient)
  if (
    /fetch failed/i.test(errStr) ||
    /ECONNREFUSED/i.test(errStr) ||
    /ENOTFOUND/i.test(errStr) ||
    /ECONNRESET/i.test(errStr)
  ) {
    return {
      code: 'NETWORK_FAILURE',
      isTransient: true,
      explanation: 'Network connectivity failure connecting to Gemini.',
      safeDetail: sanitized,
    };
  }

  // 9. Invalid Output (Transient / Parse)
  if (
    /Empty response from Gemini/i.test(errStr) ||
    /Unexpected token/i.test(errStr) ||
    /JSON at position/i.test(errStr) ||
    /SyntaxError/i.test(errStr)
  ) {
    return {
      code: 'INVALID_OUTPUT',
      isTransient: true,
      explanation: 'Gemini returned an empty or unparseable response.',
      safeDetail: sanitized,
    };
  }

  // Default: Generic Transient Service Error
  return {
    code: 'SERVICE_ERROR',
    isTransient: true,
    explanation: 'Gemini request encountered an unexpected service error.',
    safeDetail: sanitized,
  };
}

export interface GeminiTelemetry {
  currentModel: string;
  maxConcurrency: number;
  minDispatchGapMs: number;
  effectivePacingMs: number;
  inFlightRequests: number;
  queuedRequests: number;
  queueDepth: number;
  totalRequests: number;
  requestsStarted: number;
  requestsSucceeded: number;
  requestsFailed: number;
  recent429Count: number;
  rateLimit429Count: number;
  consecutive429Count: number;
  isCooldownActive: boolean;
  cooldownUntil: string | null;
  cooldownRemainingSeconds: number;
  recentTransientErrorCount: number;
  last429At: string | null;
  lastTransientErrorAt: string | null;
}

export const GEMINI_PRIORITIES = {
  COMPANY_CLASSIFICATION: 1,
  CLASSIFICATION_RETRY: 2,
  EMAIL_GENERATION: 3,
  GENERATION_RETRY: 4,
} as const;

interface QueuedItem<T = unknown> {
  id: string;
  priority: number;
  taskName: string;
  enqueuedAt: number;
  task: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

/**
 * Extracts Retry-After duration in milliseconds from Gemini / HTTP response or error metadata.
 * Returns null if no valid Retry-After specification is detected.
 */
export function extractRetryAfterMs(err: unknown): number | null {
  if (!err) return null;

  const anyErr = err as Record<string, any>;
  if (typeof anyErr.retryAfter === 'number' && anyErr.retryAfter > 0) {
    return Math.min(Math.max(anyErr.retryAfter * 1000, 1000), 3600000);
  }
  if (typeof anyErr.retryDelayMs === 'number' && anyErr.retryDelayMs > 0) {
    return Math.min(Math.max(anyErr.retryDelayMs, 1000), 3600000);
  }

  const headers = anyErr.response?.headers || anyErr.headers;
  if (headers) {
    const rawVal = typeof headers.get === 'function' ? headers.get('retry-after') : headers['retry-after'];
    if (rawVal) {
      const parsedSec = parseFloat(rawVal);
      if (!isNaN(parsedSec) && parsedSec > 0) {
        return Math.min(Math.max(parsedSec * 1000, 1000), 3600000);
      }
    }
  }

  const msg = anyErr.message ? String(anyErr.message) : String(err);
  const secMatch =
    msg.match(/retry(?:-after| in| after)?[:\s]+(\d+(?:\.\d+)?)\s*s(?:ec(?:ond)?s?)?/i) ||
    msg.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/i);
  if (secMatch && secMatch[1]) {
    const s = parseFloat(secMatch[1]);
    if (!isNaN(s) && s > 0) {
      return Math.min(Math.max(Math.round(s * 1000), 1000), 3600000);
    }
  }

  const minMatch = msg.match(/retry(?:-after| in| after)?[:\s]+(\d+(?:\.\d+)?)\s*m(?:in(?:ute)?s?)?/i);
  if (minMatch && minMatch[1]) {
    const m = parseFloat(minMatch[1]);
    if (!isNaN(m) && m > 0) {
      return Math.min(Math.max(Math.round(m * 60 * 1000), 1000), 3600000);
    }
  }

  return null;
}

export class GlobalGeminiRateLimiter {
  private inFlight = 0;
  private queue: QueuedItem<any>[] = [];
  private lastDispatchTime = 0;
  private totalRequests = 0;
  private requestsStarted = 0;
  private requestsSucceeded = 0;
  private requestsFailed = 0;
  private rateLimit429Count = 0;
  private consecutive429Count = 0;
  private recentTransientErrorCount = 0;
  private last429At: string | null = null;
  private lastTransientErrorAt: string | null = null;
  private cooldownUntil = 0;
  private cooldownTimer: NodeJS.Timeout | null = null;

  public getMaxConcurrency(): number {
    const configured = parseInt(process.env.GEMINI_MAX_CONCURRENCY || '', 10);
    return !isNaN(configured) && configured > 0 ? configured : 2;
  }

  public getMinDispatchGapMs(): number {
    const configured = parseInt(process.env.GEMINI_MIN_DISPATCH_GAP_MS || '', 10);
    return !isNaN(configured) && configured >= 0 ? configured : 1000;
  }

  public getBaseCooldownMs(): number {
    const configured = parseInt(process.env.GEMINI_COOLDOWN_BASE_MS || '', 10);
    return !isNaN(configured) && configured > 0 ? configured : 60000;
  }

  public getMaxCooldownMs(): number {
    const configured = parseInt(process.env.GEMINI_COOLDOWN_MAX_MS || '', 10);
    return !isNaN(configured) && configured > 0 ? configured : 900000;
  }

  public isCooldownActive(): boolean {
    return Date.now() < this.cooldownUntil;
  }

  public getCooldownRemainingMs(): number {
    return Math.max(0, this.cooldownUntil - Date.now());
  }

  public getCooldownUntilMs(): number {
    return this.cooldownUntil;
  }

  public getCooldownUntilIso(): string | null {
    return this.cooldownUntil > 0 ? new Date(this.cooldownUntil).toISOString() : null;
  }

  public resetCooldown(): void {
    if (this.cooldownTimer) {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
    }
    this.cooldownUntil = 0;
    this.consecutive429Count = 0;
  }

  public setCooldownUntilForTesting(cooldownUntilMs: number): void {
    this.cooldownUntil = cooldownUntilMs;
  }

  public resetForTesting(): void {
    this.resetCooldown();
    this.inFlight = 0;
    this.queue = [];
    this.lastDispatchTime = 0;
    this.totalRequests = 0;
    this.requestsStarted = 0;
    this.requestsSucceeded = 0;
    this.requestsFailed = 0;
    this.rateLimit429Count = 0;
    this.recentTransientErrorCount = 0;
    this.last429At = null;
    this.lastTransientErrorAt = null;
  }

  public getTelemetry(): GeminiTelemetry {
    const configuredModel = process.env.GEMINI_MODEL?.trim();
    const remainingMs = this.getCooldownRemainingMs();
    return {
      currentModel: configuredModel || 'gemini-3.8-flash',
      maxConcurrency: this.getMaxConcurrency(),
      minDispatchGapMs: this.getMinDispatchGapMs(),
      effectivePacingMs: this.getMinDispatchGapMs(),
      inFlightRequests: this.inFlight,
      queuedRequests: this.queue.length,
      queueDepth: this.queue.length,
      totalRequests: this.totalRequests,
      requestsStarted: this.requestsStarted,
      requestsSucceeded: this.requestsSucceeded,
      requestsFailed: this.requestsFailed,
      recent429Count: this.rateLimit429Count,
      rateLimit429Count: this.rateLimit429Count,
      consecutive429Count: this.consecutive429Count,
      isCooldownActive: this.isCooldownActive(),
      cooldownUntil: this.getCooldownUntilIso(),
      cooldownRemainingSeconds: Math.ceil(remainingMs / 1000),
      recentTransientErrorCount: this.recentTransientErrorCount,
      last429At: this.last429At,
      lastTransientErrorAt: this.lastTransientErrorAt,
    };
  }

  public handle429(err?: unknown): number {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    this.rateLimit429Count++;
    this.last429At = nowIso;
    this.consecutive429Count++;

    const retryAfterMs = extractRetryAfterMs(err);
    let cooldownMs: number;

    if (retryAfterMs !== null && retryAfterMs > 0) {
      cooldownMs = retryAfterMs;
      console.warn(`[GlobalGeminiRateLimiter] 429 Rate Limit Exceeded. Using Retry-After: ${Math.round(cooldownMs / 1000)}s`);
    } else {
      const baseMs = this.getBaseCooldownMs();
      const maxMs = this.getMaxCooldownMs();
      cooldownMs = Math.min(baseMs * Math.pow(2, this.consecutive429Count - 1), maxMs);
      console.warn(`[GlobalGeminiRateLimiter] 429 Rate Limit Exceeded (consecutive #${this.consecutive429Count}). Global cooldown: ${Math.round(cooldownMs / 1000)}s`);
    }

    const newCooldownUntil = now + cooldownMs;
    if (newCooldownUntil > this.cooldownUntil) {
      this.cooldownUntil = newCooldownUntil;
    }

    if (this.cooldownTimer) {
      clearTimeout(this.cooldownTimer);
    }
    const timerDelay = Math.max(50, this.cooldownUntil - Date.now());
    this.cooldownTimer = setTimeout(() => {
      this.cooldownTimer = null;
      this.processNext();
    }, timerDelay);
    if (typeof this.cooldownTimer?.unref === 'function') {
      this.cooldownTimer.unref();
    }

    return this.cooldownUntil;

  }

  public recordSuccess(): void {
    this.requestsSucceeded++;
    this.consecutive429Count = 0;
  }

  public recordError(err: unknown): void {
    const diag = categorizeGeminiError(err);
    const nowIso = new Date().toISOString();
    if (diag.code === 'RATE_LIMIT_EXCEEDED') {
      this.handle429(err);
    } else if (diag.isTransient) {
      this.recentTransientErrorCount++;
      this.lastTransientErrorAt = nowIso;
    }
  }

  public enqueue<T>(
    task: () => Promise<T>,
    priority: number = GEMINI_PRIORITIES.EMAIL_GENERATION,
    taskName: string = 'unnamed-gemini-task'
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const item: QueuedItem<T> = {
        id: Math.random().toString(36).substring(2, 9),
        priority,
        taskName,
        enqueuedAt: Date.now(),
        task,
        resolve,
        reject,
      };

      this.queue.push(item);
      // Priority queue ordering: lower number = higher priority; FIFO within same priority
      this.queue.sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        return a.enqueuedAt - b.enqueuedAt;
      });

      this.processNext();
    });
  }

  private async processNext() {
    // If global 429 cooldown is active, pause queue processing completely
    if (this.isCooldownActive()) {
      const remainingMs = this.getCooldownRemainingMs();
      if (!this.cooldownTimer) {
        this.cooldownTimer = setTimeout(() => {
          this.cooldownTimer = null;
          this.processNext();
        }, Math.max(50, remainingMs));
        if (typeof this.cooldownTimer?.unref === 'function') {
          this.cooldownTimer.unref();
        }
      }
      return;

    }

    if (this.inFlight >= this.getMaxConcurrency() || this.queue.length === 0) {
      return;
    }

    const now = Date.now();
    const timeSinceLast = now - this.lastDispatchTime;
    const gap = this.getMinDispatchGapMs();

    if (timeSinceLast < gap) {
      setTimeout(() => this.processNext(), gap - timeSinceLast);
      return;
    }

    const item = this.queue.shift();
    if (!item) return;

    this.inFlight++;
    this.totalRequests++;
    this.requestsStarted++;
    this.lastDispatchTime = Date.now();

    try {
      const result = await item.task();
      this.recordSuccess();
      item.resolve(result);
    } catch (err) {
      this.requestsFailed++;
      const diag = categorizeGeminiError(err);
      if (diag.code === 'RATE_LIMIT_EXCEEDED') {
        this.handle429(err);
      } else {
        this.recordError(err);
      }
      item.reject(err);
    } finally {
      this.inFlight--;
      if (this.isCooldownActive()) {
        // Cooldown was activated by this failure; do not immediately dispatch next
      } else {
        setTimeout(() => this.processNext(), 50);
      }
    }
  }
}

export const globalGeminiLimiter = new GlobalGeminiRateLimiter();

export function getGeminiTelemetry(): GeminiTelemetry {
  return globalGeminiLimiter.getTelemetry();
}


/**
 * Calls Gemini with automatic retries for transient errors.
 * Routes all traffic through the GlobalGeminiRateLimiter with strict priority management.
 * Uses gemini-3.8-flash as the sole stable default model.
 */
export async function callGemini(
  prompt: string,
  options: {
    model?: string;
    temperature?: number;
    maxRetries?: number;
    timeoutMs?: number;
    priority?: number;
    taskName?: string;
  } = {}
): Promise<string> {
  const priority = options.priority ?? GEMINI_PRIORITIES.EMAIL_GENERATION;
  const taskName = options.taskName ?? 'gemini-call';

  return globalGeminiLimiter.enqueue(async () => {
    const client = getGeminiClient();
    if (!client) {
      throw new Error('GEMINI_API_KEY is not configured in the environment.');
    }

    const configuredModel = process.env.GEMINI_MODEL?.trim();
    const model = options.model || configuredModel || 'gemini-3.8-flash';
    const maxRetries = options.maxRetries ?? 3;
    const timeoutMs = options.timeoutMs ?? 15000;

    let lastError: unknown;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const abortController = new AbortController();
        const timeoutId = setTimeout(() => abortController.abort(), timeoutMs);

        const response = await Promise.race([
          client.models.generateContent({
            model,
            contents: prompt,
            config: {
              temperature: options.temperature ?? 0.1,
            },
          }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Gemini request timed out after ${timeoutMs}ms`)), timeoutMs)
          ),
        ]);

        clearTimeout(timeoutId);

        const text = response.text;
        if (!text) {
          throw new Error('Empty response from Gemini');
        }

        return text.trim();
      } catch (err: unknown) {
        lastError = err;
        const diag = categorizeGeminiError(err);

        // Do NOT retry permanent errors (auth, model not found, bad request, missing key)
        if (!diag.isTransient) {
          break;
        }

        // Do NOT blindly retry 429 / RATE_LIMIT_EXCEEDED inside callGemini!
        // A single 429 must propagate immediately into the global rate-limit circuit breaker.
        if (diag.code === 'RATE_LIMIT_EXCEEDED') {
          break;
        }

        // Retry other transient errors (timeouts, network glitches) with backoff
        if (attempt < maxRetries) {
          const delay = Math.pow(2, attempt) * 1000 + Math.random() * 500;
          await new Promise((res) => setTimeout(res, delay));
          continue;
        }
        break;

      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }, priority, taskName);
}

