import { getDb } from '@/db';
import { companyClassifications } from '@/db/schema';
import { inArray, eq } from 'drizzle-orm';
import { callGemini, getGeminiClient, categorizeGeminiError, sanitizeSecretText, type CategorizedGeminiError } from './gemini-client';
import { normalizeCompanyName, formatCompanyDisplayName } from '@/lib/utils/company';

export type ClassificationStatus = 'RELEVANT' | 'IRRELEVANT' | 'NEEDS_REVIEW' | 'PENDING' | 'FAILED';
export type ClassificationSource = 'gemini';

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
  relevant: boolean | null; // true = RELEVANT, false = IRRELEVANT, null = NEEDS_REVIEW / PENDING
  confidence: number | null;
  reason: string;
  status: ClassificationStatus;
  source: ClassificationSource;
  geminiModel: string;
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
 * Computes exponential backoff retry time:
 * Failure 1: 2 minutes
 * Failure 2: 4 minutes
 * Failure 3: 8 minutes
 * Failure 4: 15 minutes
 * Failure 5+: 15 minutes
 */
export function computeNextRetryTime(retryCount: number, fromDate: Date = new Date()): string {
  let delayMinutes: number;
  if (retryCount <= 1) {
    delayMinutes = 2;
  } else if (retryCount === 2) {
    delayMinutes = 4;
  } else if (retryCount === 3) {
    delayMinutes = 8;
  } else {
    delayMinutes = 15;
  }
  return new Date(fromDate.getTime() + delayMinutes * 60 * 1000).toISOString();
}

/**
 * Loads cached classifications from SQLite database.
 * Only returns confident final classifications (RELEVANT, IRRELEVANT, NEEDS_REVIEW) that came from Gemini.
 * Ignores old heuristic entries and pending entries so they can be processed appropriately.
 */
function getCachedFromDb(normalizedNames: string[]): Map<string, CompanyClassificationResult> {
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
          classificationSource: 'gemini',
          geminiModel: res.geminiModel,
          classificationResult: res.status,
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
            classificationSource: 'gemini',
            geminiModel: res.geminiModel,
            classificationResult: res.status,
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
 * Constructs the rigorous, authoritative classification prompt for Gemini.
 */
function buildClassificationPrompt(companies: CompanyEvaluationInput[]): string {
  const descriptions = companies
    .map((c, i) => {
      const parts = [`${i + 1}. Company: "${c.companyName}"`];
      if (c.website) parts.push(`Website: ${c.website}`);
      if (c.location) parts.push(`Location: ${c.location}`);
      if (c.designationContext) parts.push(`Contact/Role Context: ${c.designationContext}`);
      return parts.join(' | ');
    })
    .join('\n');

  return `You are an expert technical recruitment evaluator assessing companies to determine if they are relevant employment targets for a Computer Science, Information Technology, and Software Engineering graduate candidate.

=== CRITICAL EVALUATION RULES ===
1. SOLE OBJECTIVE: Determine whether each company offers meaningful Computer Science, Information Technology, or Software Engineering employment opportunities.
2. What is RELEVANT (relevant = true):
   - Companies whose primary business is software development, cloud computing, IT services, cybersecurity, AI/ML, data platforms, SaaS, fintech, or digital products.
   - Major enterprise organizations with substantial in-house software engineering divisions, Global Capability Centers (GCCs), or technical captive units (e.g., major financial institutions, telecom software divisions, e-commerce tech, automotive software labs).
3. What is IRRELEVANT (relevant = false):
   - Companies that merely *use* software or off-the-shelf IT internally as an end user (e.g., civil construction, residential real estate brokerages, local retail stores, bakeries, dental clinics, traditional manufacturing without digital engineering). Using computers, email, or buying SaaS does NOT make a company a CS/IT employer.
4. What is NEEDS REVIEW (relevant = null):
   - Set relevant = null ONLY when public factual information about the company is genuinely too ambiguous or insufficient to determine whether it employs software/IT professionals.
   - If the company is a known brand or tech organization (e.g. HCL, TCS, Infosys, LoanTap, InfoEdge, TutorBin, Microsoft, Google), evaluate based on your authoritative industry knowledge.

=== COMPANIES TO EVALUATE ===
${descriptions}

=== OUTPUT FORMAT ===
Respond ONLY with a valid JSON array of objects matching this exact schema:
[
  {
    "company": "Exact input company name",
    "relevant": true | false | null,
    "confidence": number between 0.0 and 1.0,
    "reason": "1-sentence factual justification"
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
  geminiCaller?: (prompt: string) => Promise<string>
): Promise<CompanyClassificationResult[]> {
  const configuredModel = process.env.GEMINI_MODEL?.trim() || 'gemini-3.8-flash';
  const prompt = buildClassificationPrompt(companies);

  const responseText = typeof geminiCaller === 'function'
    ? await geminiCaller(prompt)
    : await callGemini(prompt, { model: configuredModel, temperature: 0.1 });

  const cleaned = responseText.replace(/```json/gi, '').replace(/```/g, '').trim();
  const parsed = JSON.parse(cleaned);

  if (!Array.isArray(parsed)) {
    throw new Error('Gemini response is not an array');
  }

  const resultMap = new Map<string, { relevant: boolean | null; confidence: number; reason: string }>();
  for (const item of parsed) {
    if (item && typeof item.company === 'string') {
      const norm = normalizeCompanyName(item.company);
      const isRel = typeof item.relevant === 'boolean' ? item.relevant : null;
      const conf = typeof item.confidence === 'number' ? Math.min(Math.max(item.confidence, 0), 1) : 0.9;
      const cleanReason = typeof item.reason === 'string' && item.reason.trim() ? item.reason.trim() : '';

      resultMap.set(norm, {
        relevant: isRel,
        confidence: conf,
        reason: cleanReason,
      });
    }
  }

  const results: CompanyClassificationResult[] = [];
  for (const c of companies) {
    const ai = resultMap.get(c.normalizedName) || resultMap.get(normalizeCompanyName(c.companyName));

    if (ai) {
      if (ai.relevant === true) {
        results.push({
          companyName: c.companyName,
          normalizedName: c.normalizedName,
          relevant: true,
          confidence: ai.confidence,
          status: 'RELEVANT',
          source: 'gemini',
          geminiModel: configuredModel,
          retryCount: 0,
          reason: ai.reason ? `Relevant — Gemini: ${ai.reason}` : 'Relevant — Gemini',
        });
      } else if (ai.relevant === false) {
        results.push({
          companyName: c.companyName,
          normalizedName: c.normalizedName,
          relevant: false,
          confidence: ai.confidence,
          status: 'IRRELEVANT',
          source: 'gemini',
          geminiModel: configuredModel,
          retryCount: 0,
          reason: ai.reason ? `Not Relevant — Gemini: ${ai.reason}` : 'Not Relevant — Gemini',
        });
      } else {
        // Genuine ambiguity from Gemini
        results.push({
          companyName: c.companyName,
          normalizedName: c.normalizedName,
          relevant: null,
          confidence: ai.confidence,
          status: 'NEEDS_REVIEW',
          source: 'gemini',
          geminiModel: configuredModel,
          retryCount: 0,
          reason: ai.reason
            ? `Needs Review — Gemini could not confidently determine relevance: ${ai.reason}`
            : 'Needs Review — Gemini could not confidently determine relevance.',
        });
      }
    } else {
      // Model omitted this company from the array -> mark NEEDS_REVIEW
      results.push({
        companyName: c.companyName,
        normalizedName: c.normalizedName,
        relevant: null,
        confidence: 0.5,
        status: 'NEEDS_REVIEW',
        source: 'gemini',
        geminiModel: configuredModel,
        retryCount: 0,
        reason: 'Needs Review — Gemini could not confidently determine relevance.',
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

  // 1. Check in-memory cache
  for (const c of companies) {
    const normalized = c.normalizedName ? c.normalizedName.toLowerCase().trim() : normalizeCompanyName(c.companyName);
    if (!normalized) continue;

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

  // 3. Classify uncached companies via Gemini in controlled batches
  const configuredModel = process.env.GEMINI_MODEL?.trim() || 'gemini-3.8-flash';
  const hasGemini = Boolean(geminiClientOverride !== null && (geminiClientOverride !== undefined || getGeminiClient()));

  // Controlled batch size of 10 to respect Gemini rate limits
  const BATCH_SIZE = 10;

  for (let i = 0; i < toClassify.length; i += BATCH_SIZE) {
    const chunk = toClassify.slice(i, i + BATCH_SIZE);

    if (hasGemini) {
      try {
        const aiResults = await classifyWithGeminiBatch(chunk, geminiClientOverride || undefined);
        for (const res of aiResults) {
          finalMap.set(res.normalizedName, res);
          memoryCache.set(res.normalizedName, res);
          newlyClassified.push(res);
        }
        // Small pacing delay between batches to protect against burst rate limits
        if (i + BATCH_SIZE < toClassify.length) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        continue;
      } catch (err: unknown) {
        const diag = categorizeGeminiError(err);
        console.warn(`[CompanyClassifier] Gemini batch classification failed (${diag.code}): ${diag.safeDetail}`);

        // Handle failure for every company in this chunk
        for (const item of chunk) {
          if (diag.isTransient) {
            // Transient failure -> PENDING with 2-minute initial retry
            const retryCount = 1;
            const nextRetryAt = computeNextRetryTime(retryCount);
            const pendingResult: CompanyClassificationResult = {
              companyName: item.companyName,
              normalizedName: item.normalizedName,
              relevant: null,
              confidence: null,
              status: 'PENDING',
              source: 'gemini',
              geminiModel: configuredModel,
              retryCount,
              lastErrorCategory: diag.code,
              nextRetryAt,
              reason: 'Classification Pending — Gemini temporarily unavailable. Will retry automatically.',
            };
            finalMap.set(item.normalizedName, pendingResult);
            memoryCache.set(item.normalizedName, pendingResult);
            newlyClassified.push(pendingResult);
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
