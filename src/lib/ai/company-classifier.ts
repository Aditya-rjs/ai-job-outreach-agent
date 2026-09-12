import { getDb } from '@/db';
import { companyClassifications } from '@/db/schema';
import { inArray, eq } from 'drizzle-orm';
import { callGemini, getGeminiClient, categorizeGeminiError, sanitizeSecretText, GEMINI_PRIORITIES, globalGeminiLimiter, type CategorizedGeminiError } from './gemini-client';
import { callAi, type AiCallResult } from './ai-dispatcher';
import { geminiPool } from './gemini-pool';
import { isOpenRouterConfigured, isOpenRouterError } from './openrouter-client';

import { normalizeCompanyName, formatCompanyDisplayName } from '@/lib/utils/company';
import { env } from '@/lib/config/env';
import { searchCompanyDatabaseBatch, resolveCanonicalAndPersist } from '@/lib/kb/relevant-companies-kb';
import { generateCanonicalCompanyNames } from './canonical-name-generator';

export type ClassificationStatus = 'RELEVANT' | 'IRRELEVANT' | 'NEEDS_REVIEW' | 'PENDING' | 'RETRY_WAITING' | 'FAILED';
export type ClassificationSource = 'gemini' | 'openrouter';

export interface CompanyEvaluationInput {
  companyName: string;
  normalizedName: string;
  website?: string;
  location?: string;
  designationContext?: string;
}

export interface CompanyClassificationResult {
  companyName: string;
  normalizedName: string;
  relevant: boolean | null; // true = RELEVANT, false = IRRELEVANT, null = NEEDS_REVIEW / PENDING / RETRY_WAITING
  confidence: number | null;
  reason: string;
  status: ClassificationStatus;
  source: ClassificationSource;
  geminiModel: string;
  retryRound?: number;
  retryCount: number;
  lastErrorCategory?: string | null;
  nextRetryAt?: string | null;
}

// In-memory cache for fast lookup within the current process/batch
const memoryCache = new Map<string, CompanyClassificationResult>();

export function resetClassificationMemoryCache(): void {
  memoryCache.clear();
}


/**
 * Loads cached classifications from SQLite database.
 * Only returns confident final classifications (RELEVANT, IRRELEVANT, NEEDS_REVIEW) that came from Gemini.
 * Ignores old heuristic entries and pending entries so they can be processed appropriately.
 */
export function getCachedFromDb(normalizedNames: string[]): Map<string, CompanyClassificationResult> {
  const db = getDb();
  const cachedMap = new Map<string, CompanyClassificationResult>();

  if (normalizedNames.length === 0) return cachedMap;

  try {
    const records = db
      .select()
      .from(companyClassifications)
      .where(inArray(companyClassifications.normalizedName, normalizedNames))
      .all();

    for (const r of records) {
      // Only reuse authoritative, completed Gemini evaluations
      if (
        r.classificationResult !== 'RELEVANT' &&
        r.classificationResult !== 'IRRELEVANT' &&
        r.classificationResult !== 'NEEDS_REVIEW'
      ) {
        continue;
      }

      const item: CompanyClassificationResult = {
        companyName: r.companyName,
        normalizedName: r.normalizedName,
        relevant: r.isRelevant,
        confidence: r.confidence,
        reason: r.reason,
        status: r.classificationResult as ClassificationStatus,
        source: 'gemini',
        geminiModel: r.geminiModel,
        retryRound: r.retryRound ?? 0,
        retryCount: r.retryCount,
        lastErrorCategory: r.lastErrorCategory,
        nextRetryAt: r.nextRetryAt,
      };
      cachedMap.set(r.normalizedName, item);
      memoryCache.set(r.normalizedName, item);
    }
  } catch (err) {
    console.warn('Error reading company classifications from db:', err);
  }

  return cachedMap;
}

/**
 * Saves or updates company classifications in SQLite.
 */
export function saveClassificationsToDb(results: CompanyClassificationResult[]): void {
  const db = getDb();
  if (results.length === 0) return;

  const now = new Date().toISOString();
  for (const res of results) {
    try {
      db.insert(companyClassifications)
        .values({
          normalizedName: res.normalizedName,
          companyName: res.companyName,
          isRelevant: res.relevant,
          confidence: res.confidence,
          reason: res.reason,
          classificationSource: res.source || 'gemini',
          geminiModel: res.geminiModel,
          classificationResult: res.status,
          retryRound: res.retryRound ?? 0,
          retryCount: res.retryCount,
          lastErrorCategory: res.lastErrorCategory || null,
          nextRetryAt: res.nextRetryAt || null,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: companyClassifications.normalizedName,
          set: {
            companyName: res.companyName,
            isRelevant: res.relevant,
            confidence: res.confidence,
            reason: res.reason,
            classificationSource: res.source || 'gemini',
            geminiModel: res.geminiModel,
            classificationResult: res.status,
            retryRound: res.retryRound ?? 0,
            retryCount: res.retryCount,
            lastErrorCategory: res.lastErrorCategory || null,
            nextRetryAt: res.nextRetryAt || null,
            updatedAt: now,
          },
        })
        .run();
    } catch (err) {
      console.warn(`Failed to persist company classification for ${res.normalizedName}:`, err);
    }
  }
}

/**
 * Constructs the minimal, fast classification prompt for Gemini / OpenRouter.
 * Only sends company name and website, omitting personal recruiter info.
 */
function buildClassificationPrompt(companies: CompanyEvaluationInput[]): string {
  const descriptions = companies
    .map((c, i) => {
      const parts = [`${i + 1}. Company: "${c.companyName}"`];
      if (c.website) parts.push(`Website: ${c.website}`);
      return parts.join(' | ');
    })
    .join('\n');

  return `Determine whether each company is relevant for Computer Science, Information Technology, Software Engineering, Cloud, Data, AI/ML, Cybersecurity, or SaaS/digital technology roles.

Evaluate based on:
- relevant = true: Software development, IT services/consulting, SaaS, cloud, data, AI, cybersecurity, fintech, or companies with dedicated software/technology engineering operations.
- relevant = false: Companies that only use standard end-user software (e.g., civil construction, real estate brokerage, retail stores, local services, traditional manufacturing without tech products/engineering).
- relevant = null: Genuine ambiguity where company domain cannot be identified.

COMPANIES TO EVALUATE:
${descriptions}

OUTPUT FORMAT:
Respond ONLY with a valid JSON array of objects matching this exact schema:
[
  {
    "company": "Exact input company name",
    "relevant": true | false | null
  }
]
Do not include markdown code fences or any explanatory text outside the JSON array.`;
}

/**
 * Calls Gemini to classify a batch of companies for CS/IT/Software relevance.
 * Gemini is the sole authority for this evaluation.
 */
export async function classifyWithGeminiBatch(
  companies: CompanyEvaluationInput[],
  geminiCaller?: ((prompt: string) => Promise<string | AiCallResult>) | ((prompt: string) => Promise<string>),
  options?: { isRetry?: boolean }
): Promise<CompanyClassificationResult[]> {
  const configuredModel = env.geminiModel();
  const prompt = buildClassificationPrompt(companies);
  const priority = options?.isRetry
    ? GEMINI_PRIORITIES.CLASSIFICATION_RETRY
    : GEMINI_PRIORITIES.COMPANY_CLASSIFICATION;

  let responseText: string;
  let activeProvider: ClassificationSource = 'gemini';
  const defaultModel = configuredModel === 'ALLMODELS' ? geminiPool.getCandidateModels()[0] : configuredModel;
  let activeModel: string = defaultModel;

  if (typeof geminiCaller === 'function') {
    const raw = await geminiCaller(prompt);
    if (typeof raw === 'object' && raw !== null && 'text' in raw) {
      responseText = raw.text;
      activeProvider = (raw.provider as ClassificationSource) || 'gemini';
      activeModel = raw.model || defaultModel;
    } else {
      responseText = String(raw);
    }
  } else {
    const aiRes = await callAi(prompt, {
      priority,
      temperature: 0.1,
      taskName: `company-classification-${companies.length}`,
    });
    responseText = aiRes.text;
    activeProvider = aiRes.provider;
    activeModel = aiRes.model;
  }

  const cleaned = responseText.replace(/```json/gi, '').replace(/```/g, '').trim();
  const parsed = JSON.parse(cleaned);

  if (!Array.isArray(parsed)) {
    throw new Error('AI response is not an array');
  }

  const resultMap = new Map<string, { relevant: boolean | null; confidence: number | null; reason?: string }>();
  for (const item of parsed) {
    if (item && typeof item.company === 'string') {
      const norm = normalizeCompanyName(item.company);
      const isRel = typeof item.relevant === 'boolean' ? item.relevant : null;
      const conf = typeof item.confidence === 'number' ? Math.min(Math.max(item.confidence, 0), 1) : null;
      const cleanReason = typeof item.reason === 'string' && item.reason.trim() ? item.reason.trim() : undefined;

      resultMap.set(norm, {
        relevant: isRel,
        confidence: conf,
        reason: cleanReason,
      });
    }
  }

  const results: CompanyClassificationResult[] = [];
  const providerLabel = activeProvider === 'openrouter' ? 'OpenRouter' : 'Gemini';

  for (const c of companies) {
    const ai = resultMap.get(c.normalizedName) || resultMap.get(normalizeCompanyName(c.companyName));

    if (ai) {
      if (ai.relevant === true) {
        results.push({
          companyName: c.companyName,
          normalizedName: c.normalizedName,
          relevant: true,
          confidence: ai.confidence ?? null,
          status: 'RELEVANT',
          source: activeProvider,
          geminiModel: activeModel,
          retryCount: 0,
          reason: ai.reason
            ? `Relevant — ${providerLabel}: ${ai.reason}`
            : `Relevant — ${providerLabel}: Software/IT/Technology Employer`,
        });
      } else if (ai.relevant === false) {
        results.push({
          companyName: c.companyName,
          normalizedName: c.normalizedName,
          relevant: false,
          confidence: ai.confidence ?? null,
          status: 'IRRELEVANT',
          source: activeProvider,
          geminiModel: activeModel,
          retryCount: 0,
          reason: ai.reason
            ? `Not Relevant — ${providerLabel}: ${ai.reason}`
            : `Not Relevant — ${providerLabel}: Non-Tech Employment Target`,
        });
      } else {
        // Genuine ambiguity from AI
        results.push({
          companyName: c.companyName,
          normalizedName: c.normalizedName,
          relevant: null,
          confidence: ai.confidence ?? null,
          status: 'NEEDS_REVIEW',
          source: activeProvider,
          geminiModel: activeModel,
          retryCount: 0,
          reason: ai.reason
            ? `Needs Review — ${providerLabel}: ${ai.reason}`
            : `Needs Review — ${providerLabel} could not determine relevance.`,
        });
      }
    } else {
      // Model omitted this company from the array -> mark NEEDS_REVIEW
      results.push({
        companyName: c.companyName,
        normalizedName: c.normalizedName,
        relevant: null,
        confidence: null,
        status: 'NEEDS_REVIEW',
        source: activeProvider,
        geminiModel: activeModel,
        retryCount: 0,
        reason: `Needs Review — ${providerLabel} could not determine relevance.`,
      });
    }
  }

  return results;
}

/**
 * Main company classification entry point.
 * Gemini is the sole authority for all company relevance decisions.
 *
 * If Gemini fails temporarily (rate limits, timeouts, service errors), records are marked
 * PENDING with an exponential retry schedule starting at 2 minutes.
 *
 * If Gemini fails permanently (invalid key, bad request, model not found), records are marked
 * FAILED with the exact configuration diagnostic.
 */
export async function classifyCompanies(
  companies: CompanyEvaluationInput[],
  geminiClientOverride?: ((prompt: string) => Promise<string>) | null
): Promise<Map<string, CompanyClassificationResult>> {
  const finalMap = new Map<string, CompanyClassificationResult>();
  const toLookupInDb: CompanyEvaluationInput[] = [];

  // 0. Search Relevant Company Knowledge Base (FOUND -> RELEVANT -> 0 AI calls)
  const kbMatches = searchCompanyDatabaseBatch(companies.map((c) => c.companyName));
  for (const c of companies) {
    const normalized = c.normalizedName ? c.normalizedName.toLowerCase().trim() : normalizeCompanyName(c.companyName);
    if (normalized && kbMatches.has(normalized)) {
      const match = kbMatches.get(normalized)!;
      const kbResult: CompanyClassificationResult = {
        companyName: c.companyName,
        normalizedName: normalized,
        relevant: true,
        confidence: 1.0,
        status: 'RELEVANT',
        source: 'gemini',
        geminiModel: 'knowledge-base',
        retryCount: 0,
        reason: `Relevant — Known Company Knowledge Base: ${match.canonicalName}`,
      };
      finalMap.set(normalized, kbResult);
      memoryCache.set(normalized, kbResult);
    }
  }

  // 1. Check in-memory cache
  for (const c of companies) {
    const normalized = c.normalizedName ? c.normalizedName.toLowerCase().trim() : normalizeCompanyName(c.companyName);
    if (!normalized) continue;

    if (finalMap.has(normalized)) {
      // Already satisfied by Relevant Company Knowledge Base
      continue;
    }

    const display = formatCompanyDisplayName(c.companyName);
    const item: CompanyEvaluationInput = {
      ...c,
      companyName: display,
      normalizedName: normalized,
    };

    if (memoryCache.has(normalized)) {
      finalMap.set(normalized, memoryCache.get(normalized)!);
    } else {
      toLookupInDb.push(item);
    }
  }

  if (toLookupInDb.length === 0) {
    return finalMap;
  }

  // 2. Check SQLite database cache for authoritative Gemini evaluations
  const dbCached = getCachedFromDb(toLookupInDb.map((c) => c.normalizedName));
  const toClassify: CompanyEvaluationInput[] = [];
  const newlyClassified: CompanyClassificationResult[] = [];

  for (const c of toLookupInDb) {
    if (dbCached.has(c.normalizedName)) {
      const cached = dbCached.get(c.normalizedName)!;
      finalMap.set(c.normalizedName, cached);
      memoryCache.set(c.normalizedName, cached);
    } else {
      toClassify.push(c);
    }
  }

  if (toClassify.length === 0) {
    return finalMap;
  }

  // 3. Classify uncached companies via Gemini/OpenRouter in controlled batches
  const configuredModel = env.geminiModel();
  const fallbackModel = configuredModel === 'ALLMODELS' ? geminiPool.getCandidateModels()[0] : configuredModel;
  const hasAi = Boolean(geminiClientOverride !== null && (geminiClientOverride !== undefined || getGeminiClient() || isOpenRouterConfigured()));

  // Controlled batch size of 20 to balance throughput and token limits
  const BATCH_SIZE = 20;

  for (let i = 0; i < toClassify.length; i += BATCH_SIZE) {
    const chunk = toClassify.slice(i, i + BATCH_SIZE);

    if (hasAi) {
      try {
        const aiResults = await classifyWithGeminiBatch(chunk, geminiClientOverride || undefined);
        for (const res of aiResults) {
          finalMap.set(res.normalizedName, res);
          memoryCache.set(res.normalizedName, res);
          newlyClassified.push(res);
        }

        // For newly confirmed RELEVANT companies: generate canonical name & persist to KB
        const relevantResults = aiResults.filter((r) => r.status === 'RELEVANT');
        if (relevantResults.length > 0) {
          try {
            const canonicalMap = await generateCanonicalCompanyNames(
              relevantResults.map((r) => r.companyName),
              geminiClientOverride || undefined
            );
            for (const rel of relevantResults) {
              const canonical = canonicalMap.get(formatCompanyDisplayName(rel.companyName)) || rel.companyName;
              const persisted = resolveCanonicalAndPersist(canonical, rel.companyName);
              rel.reason += ` (KB Canonical: ${persisted.canonicalName})`;
            }
          } catch (kbErr) {
            console.warn('[CompanyClassifier] Notice during KB persistence:', kbErr);
          }
        }
        continue;
      } catch (err: unknown) {
        const diag = categorizeGeminiError(err);
        console.warn(`[CompanyClassifier] Gemini batch classification failed (${diag.code}): ${diag.safeDetail}`);

        const isFromOpenRouter = isOpenRouterError(err);
        const isRateLimit =
          diag.code === 'RATE_LIMIT_EXCEEDED' ||
          /\b429\b/.test(diag.safeDetail) ||
          /RESOURCE_EXHAUSTED/i.test(diag.safeDetail) ||
          Boolean((err as { isRateLimit?: boolean })?.isRateLimit);

        if (isRateLimit) {
          if (!isFromOpenRouter) {
            globalGeminiLimiter.recordError(err);
          }

          // 1. Mark attempted chunk as RETRY_WAITING with retryCount: 1, retryRound: 0 (waiting for current round to drain)
          for (const item of chunk) {
            const waitingResult: CompanyClassificationResult = {
              companyName: item.companyName,
              normalizedName: item.normalizedName,
              relevant: null,
              confidence: null,
              status: 'RETRY_WAITING',
              source: 'gemini',
              geminiModel: fallbackModel,
              retryRound: 0,
              retryCount: 1,
              lastErrorCategory: diag.code,
              nextRetryAt: null,
              reason: 'Classification Retry Waiting — Rate limit encountered. Waiting for current round to drain before next retry round.',
            };
            finalMap.set(item.normalizedName, waitingResult);
            memoryCache.set(item.normalizedName, waitingResult);
            newlyClassified.push(waitingResult);
          }

          // 2. Mark remaining UNATTEMPTED companies as PENDING with retryCount: 0, retryRound: 0
          const remainingCompanies = toClassify.slice(i + BATCH_SIZE);
          for (const item of remainingCompanies) {
            const unattemptedResult: CompanyClassificationResult = {
              companyName: item.companyName,
              normalizedName: item.normalizedName,
              relevant: null,
              confidence: null,
              status: 'PENDING',
              source: 'gemini',
              geminiModel: fallbackModel,
              retryRound: 0,
              retryCount: 0,
              lastErrorCategory: null,
              nextRetryAt: null,
              reason: 'Classification Pending — Queued for First Pass classification.',
            };
            finalMap.set(item.normalizedName, unattemptedResult);
            memoryCache.set(item.normalizedName, unattemptedResult);
            newlyClassified.push(unattemptedResult);
          }

          console.warn(
            `[CompanyClassifier] Rate limit encountered. Marked ${chunk.length} attempted companies as RETRY_WAITING (retry #1) and ${remainingCompanies.length} unattempted companies as PENDING (retry #0).`
          );
          // STOP chunk loop immediately to protect quota
          break;
        }

        // Handle failure for non-429 error
        for (const item of chunk) {
          if (diag.isTransient) {
            // Transient failure -> RETRY_WAITING (waiting for current round to drain)
            const waitingResult: CompanyClassificationResult = {
              companyName: item.companyName,
              normalizedName: item.normalizedName,
              relevant: null,
              confidence: null,
              status: 'RETRY_WAITING',
              source: 'gemini',
              geminiModel: fallbackModel,
              retryRound: 0,
              retryCount: 1,
              lastErrorCategory: diag.code,
              nextRetryAt: null,
              reason: 'Classification Retry Waiting — Transient error encountered. Waiting for current round to drain before next retry round.',
            };
            finalMap.set(item.normalizedName, waitingResult);
            memoryCache.set(item.normalizedName, waitingResult);
            newlyClassified.push(waitingResult);
          } else {
            // Permanent configuration/auth/model error -> FAILED
            const failedResult: CompanyClassificationResult = {
              companyName: item.companyName,
              normalizedName: item.normalizedName,
              relevant: null,
              confidence: null,
              status: 'FAILED',
              source: 'gemini',
              geminiModel: configuredModel,
              retryRound: 0,
              retryCount: 0,
              lastErrorCategory: diag.code,
              nextRetryAt: null,
              reason: `Gemini configuration error: ${diag.explanation}`,
            };
            finalMap.set(item.normalizedName, failedResult);
            memoryCache.set(item.normalizedName, failedResult);
            newlyClassified.push(failedResult);
          }
        }
      }

    } else {
      // GEMINI_API_KEY is not configured
      const diag = categorizeGeminiError(new Error('GEMINI_API_KEY is not configured in the environment.'));
      for (const item of chunk) {
        const missingKeyResult: CompanyClassificationResult = {
          companyName: item.companyName,
          normalizedName: item.normalizedName,
          relevant: null,
          confidence: null,
          status: 'FAILED',
          source: 'gemini',
          geminiModel: configuredModel,
          retryRound: 0,
          retryCount: 0,
          lastErrorCategory: diag.code,
          nextRetryAt: null,
          reason: `Gemini configuration error: ${diag.explanation}`,
        };
        finalMap.set(item.normalizedName, missingKeyResult);
        memoryCache.set(item.normalizedName, missingKeyResult);
        newlyClassified.push(missingKeyResult);
      }
    }
  }

  // 4. Persist all newly evaluated and pending records in SQLite
  if (newlyClassified.length > 0) {
    saveClassificationsToDb(newlyClassified);
  }

  return finalMap;
}
