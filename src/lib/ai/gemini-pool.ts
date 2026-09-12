import type { GoogleGenAI } from '@google/genai';
import { extractRetryAfterMs } from './gemini-client';

export const APPROVED_GEMINI_CANDIDATES = [
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3-flash-preview',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
] as const;

export type GeminiCandidateModel = typeof APPROVED_GEMINI_CANDIDATES[number];

export interface ModelHealthState {
  modelName: string;
  isAccessible: boolean;
  isPermanentlyDisabled: boolean;
  disableReason?: string;
  consecutive429Count: number;
  consecutive5xxCount: number;
  cooldownUntil: number; // epoch ms
  lastUsedAt: number;
  totalRequests: number;
  totalSuccesses: number;
  total429s: number;
  total5xx: number;
}

export interface GeminiPoolTelemetry {
  mode: 'ALLMODELS' | 'single';
  modelDisplay: string;
  totalCandidates: number;
  accessibleCount: number;
  healthyCount: number;
  cooldownCount: number;
  disabledCount: number;
  healthyModels: string[];
  cooldownModels: Array<{ model: string; remainingSeconds: number }>;
  disabledModels: Array<{ model: string; reason: string }>;
  isDiscoveryCompleted: boolean;
  discoveryError: string | null;
  lastDispatchedModel: string | null;
}

export class GeminiModelPool {
  private mode: 'ALLMODELS' | 'single' = 'ALLMODELS';
  private configuredSingleModel: string = '';
  private models: Map<string, ModelHealthState> = new Map();
  private roundRobinCursor: number = 0;
  private isDiscoveryCompleted: boolean = false;
  private discoveryPromise: Promise<void> | null = null;
  private discoveryError: string | null = null;
  private lastDispatchedModel: string | null = null;
  private lastConfiguredEnv: string | undefined = undefined;

  constructor() {
    this.initializePool();
  }

  /**
   * Initializes or resets the candidate models map.
   */
  private initializePool(): void {
    this.models.clear();
    for (const modelName of APPROVED_GEMINI_CANDIDATES) {
      this.models.set(modelName, {
        modelName,
        isAccessible: true,
        isPermanentlyDisabled: false,
        consecutive429Count: 0,
        consecutive5xxCount: 0,
        cooldownUntil: 0,
        lastUsedAt: 0,
        totalRequests: 0,
        totalSuccesses: 0,
        total429s: 0,
        total5xx: 0,
      });
    }

    const envModel = process.env.GEMINI_MODEL?.trim();
    this.lastConfiguredEnv = envModel;
    if (!envModel || envModel.toUpperCase() === 'ALLMODELS') {
      this.mode = 'ALLMODELS';
      this.configuredSingleModel = '';
    } else {
      this.mode = 'single';
      this.configuredSingleModel = envModel;
      if (!this.models.has(envModel)) {
        this.models.set(envModel, {
          modelName: envModel,
          isAccessible: true,
          isPermanentlyDisabled: false,
          consecutive429Count: 0,
          consecutive5xxCount: 0,
          cooldownUntil: 0,
          lastUsedAt: 0,
          totalRequests: 0,
          totalSuccesses: 0,
          total429s: 0,
          total5xx: 0,
        });
      } else {
        const entry = this.models.get(envModel)!;
        entry.isAccessible = true;
      }
      this.isDiscoveryCompleted = true;
    }
  }

  /**
   * Re-configures the pool from an explicit model string or environment.
   */
  public configure(rawModelEnv?: string): void {
    const target = (rawModelEnv !== undefined ? rawModelEnv : process.env.GEMINI_MODEL)?.trim();
    this.lastConfiguredEnv = target;
    if (!target || target.toUpperCase() === 'ALLMODELS') {
      if (this.mode !== 'ALLMODELS') {
        this.isDiscoveryCompleted = false;
        this.discoveryError = null;
        for (const state of this.models.values()) {
          state.isAccessible = false;
        }
      }
      this.mode = 'ALLMODELS';
      this.configuredSingleModel = '';
    } else {
      this.mode = 'single';
      this.configuredSingleModel = target;
      if (!this.models.has(target)) {
        this.models.set(target, {
          modelName: target,
          isAccessible: true,
          isPermanentlyDisabled: false,
          consecutive429Count: 0,
          consecutive5xxCount: 0,
          cooldownUntil: 0,
          lastUsedAt: 0,
          totalRequests: 0,
          totalSuccesses: 0,
          total429s: 0,
          total5xx: 0,
        });
      } else {
        const entry = this.models.get(target)!;
        entry.isAccessible = true;
      }
      this.isDiscoveryCompleted = true;
    }
  }

  public syncConfigFromEnv(): void {
    const envModel = process.env.GEMINI_MODEL?.trim();
    if (envModel === this.lastConfiguredEnv) {
      return;
    }
    this.lastConfiguredEnv = envModel;
    if (!envModel || envModel.toUpperCase() === 'ALLMODELS') {
      if (this.mode !== 'ALLMODELS') {
        this.configure('ALLMODELS');
      }
    } else {
      if (this.mode !== 'single' || this.configuredSingleModel !== envModel) {
        this.configure(envModel);
      }
    }
  }

  public isConfigured(): boolean {
    return true;
  }

  public getMode(): 'ALLMODELS' | 'single' {
    return this.mode;
  }

  public getConfiguredSingleModel(): string {
    return this.configuredSingleModel;
  }

  public getCandidateModels(): readonly string[] {
    return APPROVED_GEMINI_CANDIDATES;
  }

  public getDiscoveryError(): string | null {
    return this.discoveryError;
  }

  /**
   * Discovers accessible models using the GoogleGenAI client models.list().
   * Filters results against APPROVED_GEMINI_CANDIDATES.
   */
  public async ensureDiscovered(client?: GoogleGenAI | null): Promise<void> {
    if (this.mode === 'single') {
      this.isDiscoveryCompleted = true;
      return;
    }

    if (!client) {
      return;
    }

    const apiKey = process.env.GEMINI_API_KEY?.trim();
    if (apiKey?.startsWith('mock-')) {
      return;
    }

    if (this.isDiscoveryCompleted) {
      return;
    }

    if (this.discoveryPromise) {
      return this.discoveryPromise;
    }

    this.discoveryPromise = (async () => {
      try {
        const pager = await client.models.list();
        const candidateSet = new Set<string>(APPROVED_GEMINI_CANDIDATES);
        const discovered = new Set<string>();

        for await (const m of pager) {
          const rawName = m.name || '';
          const normalized = rawName.replace(/^models\//, '').trim();

          // Verify generateContent support if supportedActions is provided
          const actions = m.supportedActions;
          const supportsGenerate =
            !actions || actions.length === 0 || actions.includes('generateContent');

          if (supportsGenerate && candidateSet.has(normalized)) {
            discovered.add(normalized);
          }
        }

        // Mark accessible models
        for (const [modelName, state] of this.models.entries()) {
          state.isAccessible = discovered.has(modelName);
        }

        this.discoveryError = null;
        this.isDiscoveryCompleted = true;
        console.log(
          `[GeminiPool] Model discovery completed. ${discovered.size}/${APPROVED_GEMINI_CANDIDATES.length} candidate models accessible: [${Array.from(discovered).join(', ')}]`
        );
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.discoveryError = errMsg;
        this.isDiscoveryCompleted = true;

        // CRITICAL: Do NOT assume all 10 models are available on discovery failure!
        for (const state of this.models.values()) {
          state.isAccessible = false;
        }

        console.error(`[GeminiPool] Model discovery failed: ${errMsg}`);
      } finally {
        this.discoveryPromise = null;
      }
    })();

    return this.discoveryPromise;
  }

  /**
   * Manually sets the accessible models list (useful for testing or explicit injection).
   */
  public setAccessibleModelsForTesting(modelNames: string[]): void {
    const accessibleSet = new Set(modelNames);
    for (const [name, state] of this.models.entries()) {
      state.isAccessible = accessibleSet.has(name);
    }
    for (const name of modelNames) {
      if (!this.models.has(name)) {
        this.models.set(name, {
          modelName: name,
          isAccessible: true,
          isPermanentlyDisabled: false,
          consecutive429Count: 0,
          consecutive5xxCount: 0,
          cooldownUntil: 0,
          lastUsedAt: 0,
          totalRequests: 0,
          totalSuccesses: 0,
          total429s: 0,
          total5xx: 0,
        });
      }
    }
    this.isDiscoveryCompleted = true;
    this.discoveryError = null;
  }

  public resetCooldownsForTesting(): void {
    for (const model of this.models.values()) {
      model.cooldownUntil = 0;
      model.consecutive429Count = 0;
      model.consecutive5xxCount = 0;
    }
  }

  /**
   * Retrieves all currently healthy models:
   * Accessible, NOT permanently disabled, and NOT currently in cooldown.
   */
  public getHealthyModels(now: number = Date.now()): ModelHealthState[] {
    return Array.from(this.models.values()).filter(
      (m) => m.isAccessible && !m.isPermanentlyDisabled && m.cooldownUntil <= now
    );
  }

  /**
   * Fair Round-Robin lease of a healthy model.
   * If excludedModels is provided, models in that set will not be leased.
   */
  public leaseModel(
    excludedModels?: Set<string>,
    now: number = Date.now()
  ): { model: string } | null {
    this.syncConfigFromEnv();
    if (this.mode === 'single') {
      if (excludedModels && excludedModels.has(this.configuredSingleModel)) {
        return null;
      }
      const single = this.models.get(this.configuredSingleModel);
      if (!single || single.isPermanentlyDisabled || single.cooldownUntil > now) {
        return null;
      }
      single.lastUsedAt = now;
      single.totalRequests++;
      this.lastDispatchedModel = single.modelName;
      return { model: single.modelName };
    }

    let healthy = this.getHealthyModels(now);
    if (excludedModels && excludedModels.size > 0) {
      healthy = healthy.filter((m) => !excludedModels.has(m.modelName));
    }

    if (healthy.length === 0) {
      return null;
    }

    // Fair round-robin across healthy models
    const selected = healthy[this.roundRobinCursor % healthy.length];
    this.roundRobinCursor = (this.roundRobinCursor + 1) % healthy.length;

    selected.lastUsedAt = now;
    selected.totalRequests++;
    this.lastDispatchedModel = selected.modelName;

    return { model: selected.modelName };
  }

  /**
   * Records a successful request for a model, resetting consecutive error counts.
   */
  public recordSuccess(modelName: string): void {
    const model = this.models.get(modelName);
    if (!model) return;

    model.totalSuccesses++;
    model.consecutive429Count = 0;
    model.consecutive5xxCount = 0;
  }

  /**
   * Records an HTTP 429 rate-limit error for ONLY the specified model.
   * Calculates cooldown via Retry-After header or exponential backoff.
   */
  public record429(modelName: string, err?: unknown): number {
    const model = this.models.get(modelName);
    if (!model) return 60000;

    const now = Date.now();
    model.total429s++;
    model.consecutive429Count++;

    const retryAfterMs = extractRetryAfterMs(err);
    let cooldownMs: number;

    if (retryAfterMs !== null && retryAfterMs > 0) {
      cooldownMs = retryAfterMs;
      console.warn(
        `[GeminiPool] Model "${modelName}" 429 Rate Limit. Using Retry-After: ${Math.round(
          cooldownMs / 1000
        )}s.`
      );
    } else {
      const baseMs = 60000;
      const maxMs = 900000; // 15 min cap
      cooldownMs = Math.min(baseMs * Math.pow(2, model.consecutive429Count - 1), maxMs);
      console.warn(
        `[GeminiPool] Model "${modelName}" 429 Rate Limit (consecutive #${model.consecutive429Count}). Cooldown: ${Math.round(
          cooldownMs / 1000
        )}s.`
      );
    }

    model.cooldownUntil = now + cooldownMs;
    return cooldownMs;
  }

  /**
   * Records a transient 5xx or network transport error for ONLY the specified model.
   * Applies a short 30s transient cooldown.
   */
  public recordTransientError(modelName: string, _err?: unknown): number {
    const model = this.models.get(modelName);
    if (!model) return 30000;

    const now = Date.now();
    model.total5xx++;
    model.consecutive5xxCount++;

    const cooldownMs = 30000;
    model.cooldownUntil = Math.max(model.cooldownUntil, now + cooldownMs);
    console.warn(
      `[GeminiPool] Model "${modelName}" transient 5xx/network error. Cooldown: ${Math.round(
        cooldownMs / 1000
      )}s.`
    );
    return cooldownMs;
  }

  /**
   * Permanently marks a model as disabled (e.g. 404 NOT_FOUND or 403 PERMISSION_DENIED).
   * It will never be leased again for this process runtime.
   */
  public recordPermanentError(modelName: string, reason: string): void {
    const model = this.models.get(modelName);
    if (!model) return;

    model.isPermanentlyDisabled = true;
    model.disableReason = reason;
    console.error(
      `[GeminiPool] Model "${modelName}" permanently removed from active pool: ${reason}`
    );
  }

  /**
   * Checks if all accessible Gemini models are currently in cooldown or unavailable.
   */
  public isPoolExhausted(now: number = Date.now()): boolean {
    this.syncConfigFromEnv();
    if (this.mode === 'single') {
      const single = this.models.get(this.configuredSingleModel);
      return !single || single.isPermanentlyDisabled || single.cooldownUntil > now;
    }

    return this.getHealthyModels(now).length === 0;
  }

  /**
   * Calculates the remaining time in milliseconds until the earliest cooling model recovers.
   * Returns 0 if there are already healthy models available.
   */
  public getEarliestRecoveryMs(now: number = Date.now()): number {
    this.syncConfigFromEnv();
    if (this.mode === 'single') {
      const single = this.models.get(this.configuredSingleModel);
      if (!single || single.isPermanentlyDisabled) return 0;
      return Math.max(0, single.cooldownUntil - now);
    }

    const accessible = Array.from(this.models.values()).filter(
      (m) => m.isAccessible && !m.isPermanentlyDisabled
    );
    if (accessible.length === 0) {
      return 0;
    }

    const coolingDown = accessible.filter((m) => m.cooldownUntil > now);
    if (coolingDown.length === 0) {
      return 0; // No models are cooling down
    }

    const remainingTimes = coolingDown.map((m) => m.cooldownUntil - now);
    return Math.max(1000, Math.min(...remainingTimes));
  }

  /**
   * Returns complete telemetry and health status of the pool.
   */
  public getTelemetry(now: number = Date.now()): GeminiPoolTelemetry {
    this.syncConfigFromEnv();
    const modelsList = Array.from(this.models.values());
    const accessible = modelsList.filter((m) => m.isAccessible);
    const healthy = accessible.filter((m) => !m.isPermanentlyDisabled && m.cooldownUntil <= now);
    const inCooldown = accessible.filter((m) => !m.isPermanentlyDisabled && m.cooldownUntil > now);
    const disabled = modelsList.filter((m) => m.isPermanentlyDisabled);

    let modelDisplay: string;
    if (this.mode === 'single') {
      modelDisplay = this.configuredSingleModel;
    } else {
      modelDisplay = `ALLMODELS (${healthy.length}/${accessible.length} active)`;
    }

    return {
      mode: this.mode,
      modelDisplay,
      totalCandidates: APPROVED_GEMINI_CANDIDATES.length,
      accessibleCount: accessible.length,
      healthyCount: healthy.length,
      cooldownCount: inCooldown.length,
      disabledCount: disabled.length,
      healthyModels: healthy.map((m) => m.modelName),
      cooldownModels: inCooldown.map((m) => ({
        model: m.modelName,
        remainingSeconds: Math.ceil((m.cooldownUntil - now) / 1000),
      })),
      disabledModels: disabled.map((m) => ({
        model: m.modelName,
        reason: m.disableReason || 'Unavailable',
      })),
      isDiscoveryCompleted: this.isDiscoveryCompleted,
      discoveryError: this.discoveryError,
      lastDispatchedModel: this.lastDispatchedModel,
    };
  }

  /**
   * Resets all pool state for isolated unit testing.
   */
  public resetForTesting(): void {
    this.roundRobinCursor = 0;
    this.isDiscoveryCompleted = false;
    this.discoveryPromise = null;
    this.discoveryError = null;
    this.lastDispatchedModel = null;
    this.initializePool();
  }
}

// Global Singleton Instance
export const geminiPool = new GeminiModelPool();
