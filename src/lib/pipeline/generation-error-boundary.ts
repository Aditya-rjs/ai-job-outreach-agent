/**
 * Universal Generation Error Boundary & Semantic Normalizer
 *
 * Implements Phase 3 permanent self-healing error boundary for email generation.
 * Replaces naive JavaScript error constructor inspection (TypeError, SyntaxError, RangeError)
 * with a semantic precedence pipeline that accurately classifies:
 *   - Network & Transport errors (e.g. Node.js native `TypeError: fetch failed`, ENOTFOUND, ECONNRESET)
 *   - Provider Rate Limits & Quotas (HTTP 429, RESOURCE_EXHAUSTED)
 *   - Provider Outages & Gateway Drops (HTTP 5xx, Bad Gateway, Service Unavailable)
 *   - Provider Authentication & Permission (HTTP 401, 403)
 *   - Model Safety & Content Refusals (SAFETY_BLOCKED)
 *   - Malformed AI Output (unparseable JSON, missing required fields)
 *   - SQLite Database Contention (SQLITE_BUSY, database is locked)
 *   - Verified Deterministic Defects (strictly positive evidence of invalid/missing invariants)
 *   - Universal Safe Harbor for Unanticipated Runtime Errors (safe retry by default)
 */

import {
  categorizeGeminiError,
  sanitizeSecretText,
  type CategorizedGeminiError,
} from '../ai/gemini-client';
import { isOpenRouterError } from '../ai/openrouter-client';
import { isAiOutputInvalidError } from '../ai/json-parser';
import { isAiProviderUnavailableError } from '../ai/ai-provider-service';

export type GenerationErrorCategory =
  | 'NETWORK_TRANSPORT_ERROR'
  | 'PROVIDER_RATE_LIMIT'
  | 'PROVIDER_OUTAGE_5XX'
  | 'PROVIDER_AUTH_ERROR'
  | 'PROVIDER_SAFETY_REFUSAL'
  | 'AI_OUTPUT_MALFORMED'
  | 'DATABASE_TRANSIENT_ERROR'
  | 'UNANTICIPATED_RUNTIME_ERROR'
  | 'DETERMINISTIC_DEFECT';

export type GenerationProvider = 'gemini' | 'openrouter' | 'none' | 'unknown';

export interface NormalizedGenerationDiagnostic {
  category: GenerationErrorCategory;
  isRetryable: boolean;
  isDeterministicDefect: boolean;
  failoverEligible: boolean;
  provider: GenerationProvider;
  statusCode?: number;
  errorCode?: string;
  safeMessage: string;
  originalErrorName: string;
  suggestedAction:
    | 'retry_circular_queue'
    | 'quarantine_failed'
    | 'pause_provider_waiting';
  timestamp: string;
}

export interface GenerationErrorContext {
  provider?: string;
  contactEmail?: string;
}

/**
 * Dedicated error class thrown when an invariant or data defect is deterministically permanent.
 * Only errors of this class (or errors with positive evidence of corrupt data)
 * are permitted to produce DETERMINISTIC_DEFECT / GENERATION_FAILED.
 */
export class DeterministicDefectError extends Error {
  public readonly isDeterministicDefect = true as const;
  public readonly code = 'DETERMINISTIC_DEFECT' as const;

  constructor(message: string, public readonly originalError?: unknown) {
    super(message);
    this.name = 'DeterministicDefectError';
    Object.setPrototypeOf(this, DeterministicDefectError.prototype);
  }
}

export function isDeterministicDefectError(err: unknown): err is DeterministicDefectError {
  if (err instanceof DeterministicDefectError) {
    return true;
  }
  return (
    typeof err === 'object' &&
    err !== null &&
    Boolean((err as { isDeterministicDefect?: boolean }).isDeterministicDefect)
  );
}

interface ErrorFrame {
  message: string;
  name: string;
  code?: string;
  statusCode?: number;
  status?: number;
}

/**
 * Traverses an error chain (including .cause and AggregateError .errors)
 * to inspect all underlying runtime frames.
 */
function extractErrorChain(err: unknown, maxDepth = 6): ErrorFrame[] {
  const chain: ErrorFrame[] = [];
  let current: any = err;
  let depth = 0;

  while (current && depth < maxDepth) {
    if (typeof current === 'object') {
      const msg = typeof current.message === 'string' ? current.message : String(current);
      const name =
        typeof current.name === 'string'
          ? current.name
          : current.constructor?.name || 'Object';
      const code = typeof current.code === 'string' ? current.code : undefined;
      const statusCode =
        typeof current.statusCode === 'number'
          ? current.statusCode
          : typeof current.status === 'number'
            ? current.status
            : undefined;

      chain.push({ message: msg, name, code, statusCode, status: statusCode });

      if (Array.isArray(current.errors)) {
        for (const subErr of current.errors) {
          if (subErr && typeof subErr === 'object') {
            chain.push({
              message: typeof subErr.message === 'string' ? subErr.message : String(subErr),
              name: typeof subErr.name === 'string' ? subErr.name : subErr.constructor?.name || 'Object',
              code: typeof subErr.code === 'string' ? subErr.code : undefined,
            });
          }
        }
      }
      current = current.cause;
    } else {
      chain.push({ message: String(current), name: typeof current });
      break;
    }
    depth++;
  }
  return chain;
}

const NETWORK_ERROR_CODES = new Set([
  'ENOTFOUND',
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'ENETUNREACH',
  'ENETDOWN',
  'EPIPE',
  'ECONNABORTED',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_INFO',
  'UND_ERR_RESPONSE_STATUS_CODE',
]);

const NETWORK_PATTERNS = [
  /fetch failed/i,
  /connect ECONNREFUSED/i,
  /connect ECONNRESET/i,
  /connect ENOTFOUND/i,
  /connect ETIMEDOUT/i,
  /getaddrinfo ENOTFOUND/i,
  /socket hang up/i,
  /client network socket disconnected/i,
  /network error/i,
  /network timeout/i,
  /UND_ERR_/i,
  /EAI_AGAIN/i,
  /TLS handshake timeout/i,
  /connection closed/i,
  /premature close/i,
];

function isNetworkTransportError(chain: ErrorFrame[], diag?: CategorizedGeminiError): boolean {
  if (diag && diag.code === 'NETWORK_FAILURE') {
    return true;
  }
  for (const frame of chain) {
    if (frame.code && NETWORK_ERROR_CODES.has(frame.code)) {
      return true;
    }
    for (const pattern of NETWORK_PATTERNS) {
      if (pattern.test(frame.message) || (frame.code && pattern.test(frame.code))) {
        return true;
      }
    }
  }
  return false;
}

const TIMEOUT_PATTERNS = [
  /timed out/i,
  /timeout/i,
  /AbortError/i,
  /ESOCKETTIMEDOUT/i,
  /ETIMEDOUT/i,
];

function isTimeoutError(chain: ErrorFrame[], diag?: CategorizedGeminiError): boolean {
  if (diag && diag.code === 'TIMEOUT') {
    return true;
  }
  for (const frame of chain) {
    if (frame.name === 'AbortError' || frame.code === 'ETIMEDOUT' || frame.code === 'ESOCKETTIMEDOUT') {
      return true;
    }
    for (const pattern of TIMEOUT_PATTERNS) {
      if (pattern.test(frame.message)) {
        return true;
      }
    }
  }
  return false;
}

function extractStatusCode(err: unknown, chain: ErrorFrame[]): number | undefined {
  if (typeof err === 'object' && err !== null) {
    const candidate = err as {
      statusCode?: unknown;
      status?: unknown;
      response?: { status?: unknown };
    };
    if (typeof candidate.statusCode === 'number') return candidate.statusCode;
    if (typeof candidate.status === 'number') return candidate.status;
    if (typeof candidate.response?.status === 'number') return candidate.response.status;
  }
  for (const frame of chain) {
    if (frame.statusCode) return frame.statusCode;
    if (frame.status) return frame.status;
    const match = frame.message.match(/\b(429|500|502|503|504|401|403|404|400)\b/);
    if (match) {
      return parseInt(match[1], 10);
    }
  }
  return undefined;
}

function buildSafeMessage(rawMessage: string): string {
  let cleaned = sanitizeSecretText(rawMessage);
  cleaned = cleaned.replace(/Bearer\s+[A-Za-z0-9_\-\.]+/gi, 'Bearer [REDACTED]');
  return cleaned;
}

function resolveProvider(err: unknown, context?: GenerationErrorContext): GenerationProvider {
  if (context?.provider === 'gemini' || context?.provider === 'openrouter') {
    return context.provider;
  }
  if (
    isOpenRouterError(err) ||
    (typeof err === 'object' &&
      err !== null &&
      (err as { provider?: unknown }).provider === 'openrouter')
  ) {
    return 'openrouter';
  }
  if (
    typeof err === 'object' &&
    err !== null &&
    (err as { provider?: unknown }).provider === 'gemini'
  ) {
    return 'gemini';
  }
  return 'unknown';
}

/**
 * Normalizes any generation exception into a deterministic, semantic diagnostic.
 * Follows strict semantic precedence to prevent JavaScript constructors (such as TypeError)
 * from triggering premature permanent failure.
 */
export function normalizeGenerationError(
  err: unknown,
  context?: GenerationErrorContext
): NormalizedGenerationDiagnostic {
  const timestamp = new Date().toISOString();
  const provider = resolveProvider(err, context);
  const chain = extractErrorChain(err);
  const rawMessage = chain[0]?.message || (typeof err === 'string' ? err : 'Unknown generation error');
  const originalErrorName = chain[0]?.name || (err instanceof Error ? err.name : 'UnknownError');
  const safeMessage = buildSafeMessage(rawMessage);
  const statusCode = extractStatusCode(err, chain);
  const errorCode = chain.find((f) => Boolean(f.code))?.code;

  // Check if AI provider service signaled WAITING state
  if (isAiProviderUnavailableError(err)) {
    return {
      category: 'PROVIDER_RATE_LIMIT',
      isRetryable: true,
      isDeterministicDefect: false,
      failoverEligible: false,
      provider,
      statusCode: 429,
      errorCode: 'AI_PROVIDERS_UNAVAILABLE',
      safeMessage,
      originalErrorName,
      suggestedAction: 'pause_provider_waiting',
      timestamp,
    };
  }

  // Get Gemini structured diagnosis if available
  const geminiDiag: CategorizedGeminiError = categorizeGeminiError(err);

  // ──────────────────────────────────────────────────────────
  // STAGE 1: Existing Structured Provider Diagnostics
  // ──────────────────────────────────────────────────────────
  // A. OpenRouter structured diagnostics
  if (isOpenRouterError(err)) {
    if (err.isRateLimit || err.statusCode === 429) {
      return {
        category: 'PROVIDER_RATE_LIMIT',
        isRetryable: true,
        isDeterministicDefect: false,
        failoverEligible: true,
        provider: 'openrouter',
        statusCode: 429,
        errorCode: 'RATE_LIMIT_EXCEEDED',
        safeMessage,
        originalErrorName,
        suggestedAction: 'retry_circular_queue',
        timestamp,
      };
    }
    if (err.statusCode && err.statusCode >= 500 && err.statusCode <= 599) {
      return {
        category: 'PROVIDER_OUTAGE_5XX',
        isRetryable: true,
        isDeterministicDefect: false,
        failoverEligible: true,
        provider: 'openrouter',
        statusCode: err.statusCode,
        errorCode: `HTTP_${err.statusCode}`,
        safeMessage,
        originalErrorName,
        suggestedAction: 'retry_circular_queue',
        timestamp,
      };
    }
    if (err.statusCode === 401 || err.statusCode === 403) {
      return {
        category: 'PROVIDER_AUTH_ERROR',
        isRetryable: true,
        isDeterministicDefect: false,
        failoverEligible: true,
        provider: 'openrouter',
        statusCode: err.statusCode,
        errorCode: err.statusCode === 401 ? 'AUTH_REJECTED' : 'PERMISSION_DENIED',
        safeMessage,
        originalErrorName,
        suggestedAction: 'retry_circular_queue',
        timestamp,
      };
    }
  }

  // B. Gemini structured diagnostics
  const isExplicitGeminiContext =
    provider === 'gemini' ||
    /gemini/i.test(rawMessage) ||
    /GoogleGenAI/i.test(rawMessage) ||
    /generativelanguage/i.test(rawMessage);

  if (
    geminiDiag.code === 'RATE_LIMIT_EXCEEDED' ||
    Boolean((err as { isRateLimit?: boolean })?.isRateLimit) ||
    statusCode === 429
  ) {
    return {
      category: 'PROVIDER_RATE_LIMIT',
      isRetryable: true,
      isDeterministicDefect: false,
      failoverEligible: true,
      provider: provider === 'unknown' ? 'gemini' : provider,
      statusCode: 429,
      errorCode: 'RATE_LIMIT_EXCEEDED',
      safeMessage,
      originalErrorName,
      suggestedAction: 'retry_circular_queue',
      timestamp,
    };
  }

  const isGemini5xx =
    (statusCode !== undefined && statusCode >= 500 && statusCode <= 599) ||
    /\b50[0-9]\b/.test(rawMessage) ||
    /\b(SERVICE_UNAVAILABLE|BAD_GATEWAY|GATEWAY_TIMEOUT)\b/i.test(rawMessage) ||
    /\bINTERNAL_ERROR\b/i.test(rawMessage) ||
    (isExplicitGeminiContext &&
      (geminiDiag.code === 'SERVICE_UNAVAILABLE' ||
        geminiDiag.code === 'BAD_GATEWAY' ||
        geminiDiag.code === 'GATEWAY_TIMEOUT' ||
        geminiDiag.code === 'INTERNAL_ERROR'));

  if (isGemini5xx) {
    return {
      category: 'PROVIDER_OUTAGE_5XX',
      isRetryable: true,
      isDeterministicDefect: false,
      failoverEligible: true,
      provider: provider === 'unknown' ? 'gemini' : provider,
      statusCode: statusCode || (geminiDiag.code === 'SERVICE_UNAVAILABLE' ? 503 : 500),
      errorCode:
        geminiDiag.code !== 'SERVICE_ERROR' ? geminiDiag.code : `HTTP_${statusCode || 500}`,
      safeMessage,
      originalErrorName,
      suggestedAction: 'retry_circular_queue',
      timestamp,
    };
  }

  const isGeminiAuth =
    statusCode === 401 ||
    statusCode === 403 ||
    /\b40[13]\b/.test(rawMessage) ||
    /\bAPI_KEY_INVALID\b/i.test(rawMessage) ||
    /\bPERMISSION_DENIED\b/i.test(rawMessage) ||
    (isExplicitGeminiContext &&
      (geminiDiag.code === 'AUTH_REJECTED' || geminiDiag.code === 'PERMISSION_DENIED'));

  if (isGeminiAuth) {
    return {
      category: 'PROVIDER_AUTH_ERROR',
      isRetryable: true,
      isDeterministicDefect: false,
      failoverEligible: true,
      provider: provider === 'unknown' ? 'gemini' : provider,
      statusCode:
        statusCode || (geminiDiag.code === 'AUTH_REJECTED' || statusCode === 401 ? 401 : 403),
      errorCode:
        geminiDiag.code !== 'SERVICE_ERROR'
          ? geminiDiag.code
          : statusCode === 401
            ? 'AUTH_REJECTED'
            : 'PERMISSION_DENIED',
      safeMessage,
      originalErrorName,
      suggestedAction: 'retry_circular_queue',
      timestamp,
    };
  }

  // ──────────────────────────────────────────────────────────
  // STAGE 2: Network / Transport Diagnostics
  // ──────────────────────────────────────────────────────────
  // Catches Node.js native `TypeError: fetch failed`, ENOTFOUND, ECONNRESET, etc.
  if (isNetworkTransportError(chain, geminiDiag)) {
    return {
      category: 'NETWORK_TRANSPORT_ERROR',
      isRetryable: true,
      isDeterministicDefect: false,
      failoverEligible: true,
      provider,
      statusCode: undefined,
      errorCode: errorCode || 'NETWORK_FAILURE',
      safeMessage,
      originalErrorName,
      suggestedAction: 'retry_circular_queue',
      timestamp,
    };
  }

  // ──────────────────────────────────────────────────────────
  // STAGE 3: Timeout Diagnostics
  // ──────────────────────────────────────────────────────────
  if (isTimeoutError(chain, geminiDiag)) {
    return {
      category: 'NETWORK_TRANSPORT_ERROR',
      isRetryable: true,
      isDeterministicDefect: false,
      failoverEligible: true,
      provider,
      statusCode: 408,
      errorCode: 'TIMEOUT',
      safeMessage,
      originalErrorName,
      suggestedAction: 'retry_circular_queue',
      timestamp,
    };
  }

  // ──────────────────────────────────────────────────────────
  // STAGE 4: HTTP / Provider Status Information (Safety Refusals)
  // ──────────────────────────────────────────────────────────
  const isSafetyRefusal =
    /SAFETY_BLOCKED/i.test(safeMessage) ||
    /HARM_CATEGORY/i.test(safeMessage) ||
    /safety ratings/i.test(safeMessage) ||
    /candidate.*blocked/i.test(safeMessage) ||
    /prompt.*blocked/i.test(safeMessage) ||
    /content policy/i.test(safeMessage);

  if (isSafetyRefusal) {
    return {
      category: 'PROVIDER_SAFETY_REFUSAL',
      isRetryable: true,
      isDeterministicDefect: false,
      failoverEligible: false,
      provider,
      errorCode: 'SAFETY_BLOCKED',
      safeMessage,
      originalErrorName,
      suggestedAction: 'retry_circular_queue',
      timestamp,
    };
  }

  // ──────────────────────────────────────────────────────────
  // STAGE 5: AI Output Validation Errors
  // ──────────────────────────────────────────────────────────
  const isExplicitJsonParseError =
    (err instanceof SyntaxError || originalErrorName === 'SyntaxError') &&
    (/in JSON at position/i.test(safeMessage) ||
      /is not valid JSON/i.test(safeMessage) ||
      /Expected ',' or '}' after property value in JSON/i.test(safeMessage) ||
      /JSON\.parse/i.test(safeMessage));

  if (
    isAiOutputInvalidError(err) ||
    (isExplicitGeminiContext && geminiDiag.code === 'INVALID_OUTPUT') ||
    /\bINVALID_OUTPUT\b/i.test(safeMessage) ||
    isExplicitJsonParseError
  ) {
    return {
      category: 'AI_OUTPUT_MALFORMED',
      isRetryable: true,
      isDeterministicDefect: false,
      failoverEligible: false,
      provider,
      errorCode: 'INVALID_OUTPUT',
      safeMessage,
      originalErrorName,
      suggestedAction: 'retry_circular_queue',
      timestamp,
    };
  }

  // ──────────────────────────────────────────────────────────
  // STAGE 6: Database-Specific Transient Errors
  // ──────────────────────────────────────────────────────────
  const isSqliteBusy =
    errorCode === 'SQLITE_BUSY' ||
    errorCode === 'SQLITE_LOCKED' ||
    /SQLITE_BUSY/i.test(safeMessage) ||
    /SQLITE_LOCKED/i.test(safeMessage) ||
    /database is locked/i.test(safeMessage) ||
    /busy timeout/i.test(safeMessage);

  if (isSqliteBusy) {
    return {
      category: 'DATABASE_TRANSIENT_ERROR',
      isRetryable: true,
      isDeterministicDefect: false,
      failoverEligible: false,
      provider: 'none',
      errorCode: errorCode || 'SQLITE_BUSY',
      safeMessage,
      originalErrorName,
      suggestedAction: 'retry_circular_queue',
      timestamp,
    };
  }

  // ──────────────────────────────────────────────────────────
  // STAGE 7: Verified Deterministic Application/Data Defects
  // ──────────────────────────────────────────────────────────
  // CRITICAL:
  // TypeError, SyntaxError, and RangeError alone ARE NOT deterministic defects.
  // Deterministic defects require POSITIVE evidence of corrupt or missing invariant data.
  const isExplicitDefect =
    isDeterministicDefectError(err) ||
    /missing required contact email/i.test(safeMessage) ||
    /empty recipient email/i.test(safeMessage) ||
    /corrupt contact record/i.test(safeMessage);

  if (isExplicitDefect) {
    return {
      category: 'DETERMINISTIC_DEFECT',
      isRetryable: false,
      isDeterministicDefect: true,
      failoverEligible: false,
      provider,
      errorCode: 'DETERMINISTIC_DEFECT',
      safeMessage,
      originalErrorName,
      suggestedAction: 'quarantine_failed',
      timestamp,
    };
  }

  // ──────────────────────────────────────────────────────────
  // STAGE 8: Universal Safe Harbor Default (Unknown / Unmatched)
  // ──────────────────────────────────────────────────────────
  // Unknown != permanent failure.
  // Unknown TypeError, SyntaxError, RangeError, or custom Error classes
  // are safely normalized to UNANTICIPATED_RUNTIME_ERROR and remain retryable.
  return {
    category: 'UNANTICIPATED_RUNTIME_ERROR',
    isRetryable: true,
    isDeterministicDefect: false,
    failoverEligible: false,
    provider,
    statusCode,
    errorCode,
    safeMessage,
    originalErrorName,
    suggestedAction: 'retry_circular_queue',
    timestamp,
  };
}

export interface GenerationSuccessResult<T> {
  success: true;
  result: T;
}

export interface GenerationFailureResult {
  success: false;
  diagnostic: NormalizedGenerationDiagnostic;
  error: unknown;
}

export type GenerationBoundaryResult<T> =
  | GenerationSuccessResult<T>
  | GenerationFailureResult;

/**
 * Executes an email generation action within the universal error boundary.
 * Catches all runtime exceptions, normalizes them into structured diagnostics,
 * and returns a typed outcome.
 * Prevents any unexpected generation exception from escaping or crashing the worker.
 */
export async function safeExecuteGeneration<T>(
  action: () => Promise<T>,
  context?: GenerationErrorContext
): Promise<GenerationBoundaryResult<T>> {
  try {
    const result = await action();
    return { success: true, result };
  } catch (err: unknown) {
    const diagnostic = normalizeGenerationError(err, context);
    return { success: false, diagnostic, error: err };
  }
}
