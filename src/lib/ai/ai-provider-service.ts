import { getDb } from '@/db';
import { aiProviderState } from '@/db/schema';
import { eq, sql } from 'drizzle-orm';
import { globalGeminiLimiter } from './gemini-client';
import { geminiPool } from './gemini-pool';
import { isOpenRouterConfigured, getOpenRouterModel } from './openrouter-client';

export type AiProviderStatusType = 'gemini' | 'openrouter' | 'waiting';

export interface PersistentAiProviderState {
  activeProvider: AiProviderStatusType;
  geminiCooldownUntil: string | null;
  geminiLastError: string | null;
  openrouterCooldownUntil: string | null;
  openrouterLastError: string | null;
  totalDispatches: number;
  geminiSuccesses: number;
  geminiFailures: number;
  gemini429Count: number;
  openrouterDispatches: number;
  openrouterSuccesses: number;
  openrouterFailures: number;
  fallbackCount: number;
  lastFallbackAt: string | null;
  updatedAt: string;
}

export class AiProviderUnavailableError extends Error {
  public readonly isProviderUnavailable = true as const;
  public readonly waitRemainingMs: number;
  public readonly provider: 'both';

  constructor(message: string, waitRemainingMs: number = 60000) {
    super(message);
    this.name = 'AiProviderUnavailableError';
    this.waitRemainingMs = Math.max(1000, waitRemainingMs);
    this.provider = 'both';
    Object.setPrototypeOf(this, AiProviderUnavailableError.prototype);
  }
}

export function isAiProviderUnavailableError(error: unknown): error is AiProviderUnavailableError {
  return (
    error instanceof AiProviderUnavailableError ||
    (typeof error === 'object' &&
      error !== null &&
      'isProviderUnavailable' in error &&
      (error as { isProviderUnavailable: unknown }).isProviderUnavailable === true)
  );
}

/**
 * Returns the singleton persistent AI provider state from SQLite.
 * Initializes default row if absent.
 */
export function getPersistentAiProviderState(): PersistentAiProviderState {
  const db = getDb();
  let row;
  try {
    row = db
      .select()
      .from(aiProviderState)
      .where(eq(aiProviderState.id, 'singleton'))
      .get();
  } catch (err) {
    // If table doesn't exist yet, lazily create it and retry
    db.run(sql`
      CREATE TABLE IF NOT EXISTS ai_provider_state (
        id TEXT PRIMARY KEY DEFAULT 'singleton',
        active_provider TEXT NOT NULL DEFAULT 'gemini',
        gemini_cooldown_until TEXT,
        gemini_last_error TEXT,
        openrouter_cooldown_until TEXT,
        openrouter_last_error TEXT,
        total_dispatches INTEGER NOT NULL DEFAULT 0,
        gemini_successes INTEGER NOT NULL DEFAULT 0,
        gemini_failures INTEGER NOT NULL DEFAULT 0,
        gemini_429_count INTEGER NOT NULL DEFAULT 0,
        openrouter_dispatches INTEGER NOT NULL DEFAULT 0,
        openrouter_successes INTEGER NOT NULL DEFAULT 0,
        openrouter_failures INTEGER NOT NULL DEFAULT 0,
        fallback_count INTEGER NOT NULL DEFAULT 0,
        last_fallback_at TEXT,
        updated_at TEXT NOT NULL
      )
    `);
    row = db
      .select()
      .from(aiProviderState)
      .where(eq(aiProviderState.id, 'singleton'))
      .get();
  }

  if (!row) {
    const nowIso = new Date().toISOString();
    try {
      db.insert(aiProviderState)
        .values({
          id: 'singleton',
          activeProvider: 'gemini',
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
          updatedAt: nowIso,
        })
        .onConflictDoNothing()
        .run();

      row = db
        .select()
        .from(aiProviderState)
        .where(eq(aiProviderState.id, 'singleton'))
        .get();
    } catch {
      // Row might have been inserted concurrently
    }
  }

  // Reconcile stale persistent WAITING or cooldown state if Gemini pool currently has healthy models in ALLMODELS mode
  if (
    geminiPool.getMode() === 'ALLMODELS' &&
    !geminiPool.isPoolExhausted() &&
    (row?.activeProvider === 'waiting' || (row?.geminiCooldownUntil && new Date(row.geminiCooldownUntil).getTime() > Date.now()))
  ) {
    try {
      db.update(aiProviderState)
        .set({
          activeProvider: 'gemini',
          geminiCooldownUntil: null,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(aiProviderState.id, 'singleton'))
        .run();
      if (row) {
        row.activeProvider = 'gemini';
        row.geminiCooldownUntil = null;
      }
    } catch {}
  }

  return {
    activeProvider: (row?.activeProvider as AiProviderStatusType) || 'gemini',
    geminiCooldownUntil: row?.geminiCooldownUntil || null,
    geminiLastError: row?.geminiLastError || null,
    openrouterCooldownUntil: row?.openrouterCooldownUntil || null,
    openrouterLastError: row?.openrouterLastError || null,
    totalDispatches: row?.totalDispatches ?? 0,
    geminiSuccesses: row?.geminiSuccesses ?? 0,
    geminiFailures: row?.geminiFailures ?? 0,
    gemini429Count: row?.gemini429Count ?? 0,
    openrouterDispatches: row?.openrouterDispatches ?? 0,
    openrouterSuccesses: row?.openrouterSuccesses ?? 0,
    openrouterFailures: row?.openrouterFailures ?? 0,
    fallbackCount: row?.fallbackCount ?? 0,
    lastFallbackAt: row?.lastFallbackAt || null,
    updatedAt: row?.updatedAt || new Date().toISOString(),
  };
}

/**
 * Checks whether OpenRouter is currently in a 429 rate limit cooldown.
 */
export function isOpenRouterCooldownActive(
  state?: PersistentAiProviderState,
  nowMs: number = Date.now()
): boolean {
  const currentState = state || getPersistentAiProviderState();
  if (!currentState.openrouterCooldownUntil) return false;
  const expiry = new Date(currentState.openrouterCooldownUntil).getTime();
  return !isNaN(expiry) && expiry > nowMs;
}

/**
 * Returns remaining cooldown for OpenRouter in milliseconds.
 */
export function getOpenRouterCooldownRemainingMs(
  state?: PersistentAiProviderState,
  nowMs: number = Date.now()
): number {
  const currentState = state || getPersistentAiProviderState();
  if (!currentState.openrouterCooldownUntil) return 0;
  const expiry = new Date(currentState.openrouterCooldownUntil).getTime();
  return Math.max(0, expiry - nowMs);
}

/**
 * Checks whether Gemini is currently in cooldown (either in-memory or persisted in SQLite).
 */
export function isGeminiCooldownActive(
  state?: PersistentAiProviderState,
  nowMs: number = Date.now()
): boolean {
  if (geminiPool.getMode() === 'ALLMODELS') {
    // In ALLMODELS mode, Gemini provider is in cooldown ONLY IF all accessible pool models are exhausted
    if (geminiPool.isPoolExhausted(nowMs)) {
      return geminiPool.getEarliestRecoveryMs(nowMs) > 0;
    }
    return false;
  }

  // Single-model mode:
  if (globalGeminiLimiter.getCooldownUntilMs() > nowMs) {
    return true;
  }
  if (geminiPool.isPoolExhausted(nowMs) && geminiPool.getEarliestRecoveryMs(nowMs) > 0) {
    return true;
  }
  const currentState = state || getPersistentAiProviderState();
  if (!currentState.geminiCooldownUntil) return false;
  const expiry = new Date(currentState.geminiCooldownUntil).getTime();
  return !isNaN(expiry) && expiry > nowMs;
}

/**
 * Returns remaining cooldown for Gemini in milliseconds.
 */
export function getGeminiCooldownRemainingMs(
  state?: PersistentAiProviderState,
  nowMs: number = Date.now()
): number {
  if (geminiPool.getMode() === 'ALLMODELS') {
    return geminiPool.isPoolExhausted(nowMs)
      ? geminiPool.getEarliestRecoveryMs(nowMs)
      : 0;
  }

  const poolRecovery = geminiPool.isPoolExhausted(nowMs)
    ? geminiPool.getEarliestRecoveryMs(nowMs)
    : 0;
  let memRemaining = 0;
  const memUntil = globalGeminiLimiter.getCooldownUntilMs();
  if (memUntil > nowMs) {
    memRemaining = memUntil - nowMs;
  }
  const currentState = state || getPersistentAiProviderState();
  let dbRemaining = 0;
  if (currentState.geminiCooldownUntil) {
    const expiry = new Date(currentState.geminiCooldownUntil).getTime();
    if (!isNaN(expiry) && expiry > nowMs) {
      dbRemaining = expiry - nowMs;
    }
  }
  return Math.max(poolRecovery, memRemaining, dbRemaining);
}

/**
 * Computes the effective active provider based on strict priority:
 * 1. If Gemini is available -> 'gemini' (Gemini is always the primary provider)
 * 2. If Gemini is cooling down and OpenRouter is available -> 'openrouter' (Fallback)
 * 3. If both are cooling down / unavailable -> 'waiting'
 * 
 * Crucial recovery rules:
 * - If both were in WAITING and OpenRouter recovers FIRST -> 'openrouter' immediately
 * - If both were in WAITING and Gemini recovers FIRST -> 'gemini' immediately
 * - If both recover -> 'gemini' (Gemini wins as primary)
 * - If OpenRouter is active and Gemini recovers -> 'gemini' automatically
 */
export function computeEffectiveActiveProvider(
  state?: PersistentAiProviderState,
  nowMs: number = Date.now()
): AiProviderStatusType {
  const currentState = state || getPersistentAiProviderState();

  // Rule 1: Gemini is PRIMARY. If healthy, always use Gemini.
  const isGeminiCooled = isGeminiCooldownActive(currentState, nowMs);
  if (!isGeminiCooled) {
    return 'gemini';
  }

  // Rule 2: Gemini is cooling down. If OpenRouter is configured & healthy -> OPENROUTER ACTIVE.
  const isOrConfigured = isOpenRouterConfigured();
  const isOrCooled = isOpenRouterCooldownActive(currentState, nowMs);
  if (isOrConfigured && !isOrCooled) {
    return 'openrouter';
  }

  // Rule 3: Both are unavailable / cooling down -> WAITING.
  return 'waiting';
}

/**
 * Records an OpenRouter HTTP 429 rate limit event.
 * Strictly isolates OpenRouter: NEVER modifies Gemini limiter or Gemini cooldown.
 */
export function recordOpenRouter429(
  errorDetail: string,
  durationOrIso: number | string = 60000
): void {
  const db = getDb();
  const now = Date.now();
  let cooldownUntil: string;
  if (typeof durationOrIso === 'string') {
    cooldownUntil = durationOrIso;
  } else {
    cooldownUntil = new Date(now + Math.max(5000, durationOrIso)).toISOString();
  }
  const nowIso = new Date(now).toISOString();

  // Compute next active provider using current state with updated OpenRouter cooldown
  const currentState = getPersistentAiProviderState();
  const previewState: PersistentAiProviderState = {
    ...currentState,
    openrouterCooldownUntil: cooldownUntil,
  };
  const nextActive = computeEffectiveActiveProvider(previewState, now);

  db.update(aiProviderState)
    .set({
      activeProvider: nextActive,
      openrouterCooldownUntil: cooldownUntil,
      openrouterLastError: errorDetail.slice(0, 300),
      openrouterFailures: sql`${aiProviderState.openrouterFailures} + 1`,
      updatedAt: nowIso,
    })
    .where(eq(aiProviderState.id, 'singleton'))
    .run();
}

/**
 * Records a Gemini HTTP 429 rate limit event.
 */
export function recordGemini429(cooldownUntilIso: string, errorDetail: string): void {
  const db = getDb();
  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  const currentState = getPersistentAiProviderState();
  const previewState: PersistentAiProviderState = {
    ...currentState,
    geminiCooldownUntil: cooldownUntilIso,
  };
  const nextActive = computeEffectiveActiveProvider(previewState, now);

  db.update(aiProviderState)
    .set({
      activeProvider: nextActive,
      geminiCooldownUntil: cooldownUntilIso,
      geminiLastError: errorDetail.slice(0, 300),
      geminiFailures: sql`${aiProviderState.geminiFailures} + 1`,
      gemini429Count: sql`${aiProviderState.gemini429Count} + 1`,
      fallbackCount: nextActive === 'openrouter' ? sql`${aiProviderState.fallbackCount} + 1` : aiProviderState.fallbackCount,
      lastFallbackAt: nextActive === 'openrouter' ? nowIso : aiProviderState.lastFallbackAt,
      updatedAt: nowIso,
    })
    .where(eq(aiProviderState.id, 'singleton'))
    .run();
}

/**
 * Records a non-429 Gemini failure.
 * Does NOT set cooldown, does NOT trigger fallback.
 */
export function recordGeminiFailure(errorDetail: string): void {
  const db = getDb();
  const nowIso = new Date().toISOString();

  db.update(aiProviderState)
    .set({
      geminiFailures: sql`${aiProviderState.geminiFailures} + 1`,
      geminiLastError: errorDetail.slice(0, 300),
      updatedAt: nowIso,
    })
    .where(eq(aiProviderState.id, 'singleton'))
    .run();
}

/**
 * Records a transient Gemini failure (5xx, network, transport, timeout) that triggered
 * fallback to OpenRouter.
 * Sets a short transient outage cooldown (default 30s) in SQLite so subsequent requests
 * route immediately to OpenRouter without hammering a dead Gemini endpoint.
 * Accurately updates activeProvider, geminiCooldownUntil, geminiFailures, fallbackCount, lastFallbackAt, and geminiLastError.
 */
export function recordGeminiTransientFailure(
  errorDetail: string,
  fellBackToOpenRouter: boolean,
  durationMs: number = 30000
): void {
  const db = getDb();
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const cooldownUntilIso = new Date(now + Math.max(5000, durationMs)).toISOString();

  const currentState = getPersistentAiProviderState();
  const previewState: PersistentAiProviderState = {
    ...currentState,
    geminiCooldownUntil: cooldownUntilIso,
  };
  const nextActive = computeEffectiveActiveProvider(previewState, now);

  db.update(aiProviderState)
    .set({
      activeProvider: nextActive,
      geminiCooldownUntil: cooldownUntilIso,
      geminiFailures: sql`${aiProviderState.geminiFailures} + 1`,
      geminiLastError: errorDetail.slice(0, 300),
      fallbackCount: fellBackToOpenRouter ? sql`${aiProviderState.fallbackCount} + 1` : aiProviderState.fallbackCount,
      lastFallbackAt: fellBackToOpenRouter ? nowIso : aiProviderState.lastFallbackAt,
      updatedAt: nowIso,
    })
    .where(eq(aiProviderState.id, 'singleton'))
    .run();
}

/**
 * Records a successful Gemini dispatch.
 */
export function recordGeminiSuccess(): void {
  const db = getDb();
  const nowIso = new Date().toISOString();

  db.update(aiProviderState)
    .set({
      activeProvider: 'gemini',
      geminiCooldownUntil: null,
      geminiLastError: null,
      geminiSuccesses: sql`${aiProviderState.geminiSuccesses} + 1`,
      totalDispatches: sql`${aiProviderState.totalDispatches} + 1`,
      updatedAt: nowIso,
    })
    .where(eq(aiProviderState.id, 'singleton'))
    .run();
}

/**
 * Records a successful OpenRouter dispatch.
 */
export function recordOpenRouterSuccess(): void {
  const db = getDb();
  const nowIso = new Date().toISOString();

  db.update(aiProviderState)
    .set({
      activeProvider: 'openrouter',
      openrouterCooldownUntil: null,
      openrouterLastError: null,
      openrouterSuccesses: sql`${aiProviderState.openrouterSuccesses} + 1`,
      openrouterDispatches: sql`${aiProviderState.openrouterDispatches} + 1`,
      totalDispatches: sql`${aiProviderState.totalDispatches} + 1`,
      updatedAt: nowIso,
    })
    .where(eq(aiProviderState.id, 'singleton'))
    .run();
}

/**
 * Records a non-429 OpenRouter failure.
 */
export function recordOpenRouterNon429Failure(errorDetail: string): void {
  const db = getDb();
  const nowIso = new Date().toISOString();

  db.update(aiProviderState)
    .set({
      openrouterDispatches: sql`${aiProviderState.openrouterDispatches} + 1`,
      openrouterFailures: sql`${aiProviderState.openrouterFailures} + 1`,
      openrouterLastError: errorDetail.slice(0, 300),
      totalDispatches: sql`${aiProviderState.totalDispatches} + 1`,
      updatedAt: nowIso,
    })
    .where(eq(aiProviderState.id, 'singleton'))
    .run();
}

/**
 * Updates activeProvider in SQLite if it drifted from evaluated reality.
 */
export function setPersistentActiveProvider(activeProvider: AiProviderStatusType): void {
  const db = getDb();
  db.update(aiProviderState)
    .set({
      activeProvider,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(aiProviderState.id, 'singleton'))
    .run();
}

/**
 * Resets persisted state for testing environments.
 */
export function resetPersistentAiProviderStateForTesting(): void {
  const db = getDb();
  const nowIso = new Date().toISOString();

  db.update(aiProviderState)
    .set({
      activeProvider: 'gemini',
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
      updatedAt: nowIso,
    })
    .where(eq(aiProviderState.id, 'singleton'))
    .run();
}
