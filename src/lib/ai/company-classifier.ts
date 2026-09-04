import { getDb } from '@/db';
import { companyClassifications } from '@/db/schema';
import { inArray } from 'drizzle-orm';
import { callGemini, getGeminiClient } from './gemini-client';
import { normalizeCompanyName, formatCompanyDisplayName } from '@/lib/utils/company';

export type ClassificationStatus = 'RELEVANT' | 'IRRELEVANT' | 'UNVERIFIED';
export type ClassificationSource = 'gemini' | 'heuristic' | 'unverified';

export interface CompanyClassificationResult {
  companyName: string;
  normalizedName: string;
  relevant: boolean | null; // true = RELEVANT, false = IRRELEVANT, null = UNVERIFIED
  confidence: number;
  reason: string;
  status: ClassificationStatus;
  source: ClassificationSource;
}

export type GeminiFailureCode =
  | 'API_KEY_MISSING'
  | 'AUTH_REJECTED'
  | 'RATE_LIMIT_EXCEEDED'
  | 'TIMEOUT'
  | 'NETWORK_FAILURE'
  | 'SERVICE_ERROR'
  | 'INVALID_OUTPUT';

export interface GeminiFailureDiagnostic {
  code: GeminiFailureCode;
  explanation: string;
  safeDetail: string;
}

// In-memory cache for ultra-fast lookup within the current process/batch
const memoryCache = new Map<string, CompanyClassificationResult>();

/**
 * Resets the in-memory cache. Useful for test suites and isolation.
 */
export function resetClassificationMemoryCache(): void {
  memoryCache.clear();
}

/**
 * Sanitizes error strings to prevent leaking API keys, OAuth tokens, secrets, or sensitive data.
 */
export function sanitizeDiagnostic(str: string): string {
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
 * Diagnoses Gemini failures into distinct categories without falsely claiming the API key is missing.
 */
export function diagnoseGeminiFailure(err: unknown): GeminiFailureDiagnostic {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    return {
      code: 'API_KEY_MISSING',
      explanation: 'Gemini classification unavailable: GEMINI_API_KEY is not configured.',
      safeDetail: 'GEMINI_API_KEY environment variable is empty or missing.',
    };
  }

  const errStr = err instanceof Error ? err.message : String(err || '');
  const sanitized = sanitizeDiagnostic(errStr);

  // 1. Authentication / Invalid API Key
  if (
    /API_KEY_INVALID/i.test(errStr) ||
    /api key not valid/i.test(errStr) ||
    /PERMISSION_DENIED/i.test(errStr) ||
    /\b401\b/.test(errStr) ||
    /\b403\b/.test(errStr) ||
    /invalid api key/i.test(errStr) ||
    /unauthorized/i.test(errStr)
  ) {
    return {
      code: 'AUTH_REJECTED',
      explanation: 'Gemini classification unavailable: API key rejected or unauthorized.',
      safeDetail: sanitized,
    };
  }

  // 2. Rate Limit / Quota Exceeded
  if (
    /RESOURCE_EXHAUSTED/i.test(errStr) ||
    /\b429\b/.test(errStr) ||
    /quota exceeded/i.test(errStr) ||
    /rate limit/i.test(errStr)
  ) {
    return {
      code: 'RATE_LIMIT_EXCEEDED',
      explanation: 'Gemini classification unavailable: Rate limit or quota exceeded.',
      safeDetail: sanitized,
    };
  }

  // 3. Timeout
  if (
    /timed out/i.test(errStr) ||
    /AbortError/i.test(errStr) ||
    /ETIMEDOUT/i.test(errStr) ||
    /ESOCKETTIMEDOUT/i.test(errStr)
  ) {
    return {
      code: 'TIMEOUT',
      explanation: 'Gemini classification unavailable: Network connection timed out.',
      safeDetail: sanitized,
    };
  }

  // 4. Network / Connectivity Error
  if (
    /fetch failed/i.test(errStr) ||
    /ECONNREFUSED/i.test(errStr) ||
    /ENOTFOUND/i.test(errStr) ||
    /ECONNRESET/i.test(errStr)
  ) {
    return {
      code: 'NETWORK_FAILURE',
      explanation: 'Gemini classification unavailable: Network connection error.',
      safeDetail: sanitized,
    };
  }

  // 5. Invalid / Unusable Model Response
  if (
    /Gemini response is not an array/i.test(errStr) ||
    /Empty response from Gemini/i.test(errStr) ||
    /Unexpected token/i.test(errStr) ||
    /JSON at position/i.test(errStr) ||
    /SyntaxError/i.test(errStr)
  ) {
    return {
      code: 'INVALID_OUTPUT',
      explanation: 'Gemini classification unavailable: Invalid response format received from model.',
      safeDetail: sanitized,
    };
  }

  // 6. Generic Service Error
  return {
    code: 'SERVICE_ERROR',
    explanation: 'Gemini classification unavailable: Gemini service temporarily unavailable.',
    safeDetail: sanitized,
  };
}

// Known technology and enterprise engineering organizations
const KNOWN_TECH_COMPANIES = new Set([
  // Global Big Tech & Cloud
  'google', 'microsoft', 'amazon', 'apple', 'meta', 'facebook', 'netflix', 'adobe',
  'salesforce', 'oracle', 'ibm', 'intel', 'cisco', 'nvidia', 'uber', 'airbnb', 'spotify',
  'stripe', 'palantir', 'datadog', 'snowflake', 'atlassian', 'autodesk', 'servicenow',
  'vmware', 'amd', 'qualcomm', 'broadcom', 'dell', 'hp', 'lenovo', 'sap', 'workday',
  'twilio', 'cloudflare', 'crowdstrike', 'okta', 'zoom', 'dropbox', 'box', 'mongodb',
  'confluent', 'elastic', 'dynatrace', 'splunk', 'databricks', 'openai', 'anthropic',

  // Major IT Services & Consultancies
  'tcs', 'tata consultancy', 'tata consultancy services', 'infosys', 'wipro', 'hcl',
  'hcltech', 'hcl technologies', 'cognizant', 'accenture', 'capgemini', 'deloitte',
  'tech mahindra', 'lti', 'ltimindtree', 'mindtree', 'mphasis', 'persistent',
  'persistent systems', 'kpit', 'hexaware', 'cyient', 'sonata software', 'birlasoft',
  'l&t technology services', 'ltts', 'tata elxsi', 'zensar',

  // Travel Technology, Enterprise Products & GCCs
  'sabre', 'sabre corporation', 'sabre global capability center', 'sabre gcc',
  'sabre travel technologies', 'amadeus', 'travelport',
  'zoho', 'freshworks', 'browserstack', 'postman', 'chargebee', 'hasura', 'druva',

  // FinTech & Digital Products
  'jpmorgan', 'jpmorgan chase', 'goldman sachs', 'morgan stanley', 'barclays', 'hsbc',
  'wells fargo', 'bny mellon', 'fidelity', 'visa', 'mastercard', 'paypal', 'razorpay',
  'phonepe', 'paytm', 'cred', 'swiggy', 'zomato', 'flipkart', 'meesho', 'zepto',
  'blinkit', 'ola'
]);

// Patterns that strongly indicate Global Capability Centers (GCCs), Technical Captives, or Engineering Centers
const GCC_AND_CENTER_PATTERNS = [
  /\bglobal capability center\b/i,
  /\bcapability center\b/i,
  /\bgcc\b/i,
  /\btechnology center\b/i,
  /\btech center\b/i,
  /\bsoftware center\b/i,
  /\bengineering center\b/i,
  /\bdigital center\b/i,
  /\bdigital lab(?:s)?\b/i,
  /\bsoftware lab(?:s)?\b/i,
  /\br&d center\b/i,
  /\bresearch (?:&|and) development\b/i,
  /\btechnology solutions\b/i,
  /\bsoftware solutions\b/i,
  /\bcloud solutions\b/i,
  /\bit services\b/i,
  /\bsoftware services\b/i,
  /\bdigital solutions\b/i,
  /\bengineering solutions\b/i,
];

// Strong, unambiguous tech keyword patterns (with word boundaries to avoid false positives)
const STRONG_TECH_PATTERNS = [
  /\btech\b/i,
  /\btechnology\b/i,
  /\btechnologies\b/i,
  /\bsoftware\b/i,
  /\bsystems\b/i,
  /\bcloud\b/i,
  /\bdevops\b/i,
  /\bcybersecurity\b/i,
  /\bcyber\b/i,
  /\binfosec\b/i,
  /\bdata analytics\b/i,
  /\bdata engineering\b/i,
  /\bdata science\b/i,
  /\bartificial intelligence\b/i,
  /\bmachine learning\b/i,
  /\bcomputing\b/i,
  /\binformatics\b/i,
  /\bdeveloper\b/i,
  /\bdevelopment\b/i,
  /\bsaas\b/i,
  /\binformation technology\b/i,
  /\binfrastructure\b/i,
  /\btelecom(?:munications)?\b/i,
  /\binteractive\b/i,
  /\bdigital\b/i,
  /\bai\b/i,
  /\bit\b/i,
];

// Known non-technology industries
const NON_TECH_PATTERNS = [
  /\bconstruction\b/i,
  /\bcement\b/i,
  /\bplumbing\b/i,
  /\breal estate\b/i,
  /\brealty\b/i,
  /\bbuilders\b/i,
  /\bfurniture\b/i,
  /\btextiles\b/i,
  /\bbakery\b/i,
  /\brestaurant\b/i,
  /\bcafe\b/i,
  /\blaundry\b/i,
  /\bsalon\b/i,
  /\bspa\b/i,
  /\bmining\b/i,
  /\bdrilling\b/i,
  /\bcarpentry\b/i,
  /\bfarming\b/i,
  /\bpoultry\b/i,
  /\bdairy\b/i,
];

/**
 * Robust heuristic classifier used as a controlled fallback when Gemini is unavailable.
 * Distinguishes RELEVANT, IRRELEVANT, and UNVERIFIED/NEEDS_REVIEW without falsely claiming
 * that unverified companies are irrelevant or misdiagnosing the Gemini failure cause.
 */
export function heuristicClassify(
  companyName: string,
  normalizedName: string,
  geminiFailure?: GeminiFailureDiagnostic
): CompanyClassificationResult {
  const cleanNorm = normalizeCompanyName(companyName) || normalizedName;

  // 1. Check known technology companies database (exact, cleanNorm, and word boundaries)
  if (KNOWN_TECH_COMPANIES.has(normalizedName) || KNOWN_TECH_COMPANIES.has(cleanNorm)) {
    return {
      companyName,
      normalizedName,
      relevant: true,
      confidence: 0.95,
      status: 'RELEVANT',
      source: 'heuristic',
      reason: 'Heuristic match: recognized technology/engineering company.',
    };
  }

  // Check if any recognized technology giant appears as a distinct word in the company name
  for (const techName of KNOWN_TECH_COMPANIES) {
    if (techName.length >= 3) {
      const regex = new RegExp(`\\b${techName}\\b`, 'i');
      if (regex.test(normalizedName) || regex.test(companyName)) {
        return {
          companyName,
          normalizedName,
          relevant: true,
          confidence: 0.95,
          status: 'RELEVANT',
          source: 'heuristic',
          reason: 'Heuristic match: recognized technology/engineering company.',
        };
      }
    }
  }

  // 2. Check GCC and Engineering Center patterns
  for (const pat of GCC_AND_CENTER_PATTERNS) {
    if (pat.test(normalizedName) || pat.test(companyName)) {
      return {
        companyName,
        normalizedName,
        relevant: true,
        confidence: 0.90,
        status: 'RELEVANT',
        source: 'heuristic',
        reason: 'Heuristic match: recognized technology/engineering company (capability center or technical operations).',
      };
    }
  }

  // 3. Check strong technology keywords with word boundaries
  for (const pat of STRONG_TECH_PATTERNS) {
    if (pat.test(normalizedName) || pat.test(companyName)) {
      return {
        companyName,
        normalizedName,
        relevant: true,
        confidence: 0.85,
        status: 'RELEVANT',
        source: 'heuristic',
        reason: 'Heuristic match: recognized technology/engineering company.',
      };
    }
  }

  // 4. Check known non-technology industries
  for (const pat of NON_TECH_PATTERNS) {
    if (pat.test(normalizedName) || pat.test(companyName)) {
      return {
        companyName,
        normalizedName,
        relevant: false,
        confidence: 0.90,
        status: 'IRRELEVANT',
        source: 'heuristic',
        reason: 'Heuristic match: recognized non-technology industry.',
      };
    }
  }

  // 5. Unknown / Ambiguous Company
  // If Gemini is unavailable and no confident heuristic match exists, mark as UNVERIFIED.
  // Never falsely mark an unverified company as IRRELEVANT.
  let unverifiedReason = 'Unable to verify CS/IT relevance: Gemini classification unavailable and no confident heuristic match.';

  if (geminiFailure) {
    if (geminiFailure.code === 'API_KEY_MISSING') {
      unverifiedReason = 'Gemini classification unavailable: GEMINI_API_KEY is not configured.';
    } else {
      unverifiedReason = `Unable to verify CS/IT relevance: ${geminiFailure.explanation.replace('Gemini classification unavailable: ', '')} and no confident heuristic match.`;
    }
  }

  return {
    companyName,
    normalizedName,
    relevant: null,
    confidence: 0.0,
    status: 'UNVERIFIED',
    source: 'unverified',
    reason: unverifiedReason,
  };
}

/**
 * Loads cached classifications from SQLite database.
 * Only returns confident classifications; ignores stale or unverified entries so they can be re-evaluated.
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
      // Ignore stale unverified fallback records from previous runs
      if (
        r.reason.includes('Unable to verify') ||
        r.reason.includes('without Gemini API key') ||
        r.confidence <= 0.5
      ) {
        continue;
      }

      const status: ClassificationStatus = r.isRelevant ? 'RELEVANT' : 'IRRELEVANT';
      const source: ClassificationSource = r.reason.startsWith('AI classification') ? 'gemini' : 'heuristic';

      const item: CompanyClassificationResult = {
        companyName: r.companyName,
        normalizedName: r.normalizedName,
        relevant: Boolean(r.isRelevant),
        confidence: r.confidence,
        reason: r.reason,
        status,
        source,
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
 * Saves newly classified companies to the SQLite database.
 * Only saves confident determinations (RELEVANT or IRRELEVANT).
 * Unverified companies are omitted from persistent DB cache to prevent locking transient failures permanently.
 */
function saveClassificationsToDb(results: CompanyClassificationResult[]): void {
  const db = getDb();
  if (results.length === 0) return;

  const now = new Date().toISOString();
  for (const res of results) {
    // Only persist confident, resolved classifications
    if (res.status !== 'RELEVANT' && res.status !== 'IRRELEVANT') {
      continue;
    }

    try {
      db.insert(companyClassifications)
        .values({
          normalizedName: res.normalizedName,
          companyName: res.companyName,
          isRelevant: Boolean(res.relevant),
          confidence: res.confidence,
          reason: res.reason,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: companyClassifications.normalizedName,
          set: {
            companyName: res.companyName,
            isRelevant: Boolean(res.relevant),
            confidence: res.confidence,
            reason: res.reason,
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
 * Calls Gemini to classify a batch of companies for CS/IT/Software relevance.
 */
async function classifyWithGeminiBatch(
  companies: { companyName: string; normalizedName: string }[],
  geminiCaller?: (prompt: string) => Promise<string>
): Promise<CompanyClassificationResult[]> {
  const prompt = `You are an expert technical recruiter evaluating companies for Computer Science, Information Technology, and Software Engineering outreach.

Target Domains (RELEVANT):
- Computer Science / Software Engineering / IT Services
- Web & Mobile Development
- Cloud, DevOps, Infrastructure
- Data Engineering, AI/ML, Data Science
- Cybersecurity, Information Security
- SaaS & B2B/B2C Technology Products
- Global Capability Centers (GCCs), Technical Captive Centers, and Engineering R&D Centers
- FinTech & Digital Banking with substantial in-house software teams
- Modern enterprises with significant in-house software engineering operations

Irrelevant:
- Purely non-technical companies with no meaningful in-house software engineering roles (e.g. local retail store, residential real estate brokerage, construction firm, local bakery, plumbing service).

Companies to evaluate:
${JSON.stringify(companies.map((c) => c.companyName), null, 2)}

Respond ONLY with a JSON array of objects matching this schema:
[
  {
    "company": "Exact input company name",
    "relevant": true or false,
    "confidence": number between 0.0 and 1.0,
    "reason": "Concise 1-sentence factual justification"
  }
]
Do not include markdown code fences or any other text.`;

  const responseText = typeof geminiCaller === 'function'
    ? await geminiCaller(prompt)
    : await callGemini(prompt, { temperature: 0.1 });
  const cleaned = responseText.replace(/```json/gi, '').replace(/```/g, '').trim();
  const parsed = JSON.parse(cleaned);

  if (!Array.isArray(parsed)) {
    throw new Error('Gemini response is not an array');
  }

  const resultMap = new Map<string, { relevant: boolean; confidence: number; reason: string }>();
  for (const item of parsed) {
    if (item && typeof item.company === 'string' && typeof item.relevant === 'boolean') {
      const norm = normalizeCompanyName(item.company);
      const category = item.relevant ? 'Technology/engineering company.' : 'Non-technology company.';
      const detail = typeof item.reason === 'string' && item.reason.trim() ? item.reason.trim() : '';
      const formattedReason = detail
        ? `AI classification: ${category} ${detail}`
        : `AI classification: ${category}`;

      resultMap.set(norm, {
        relevant: item.relevant,
        confidence: typeof item.confidence === 'number' ? Math.min(Math.max(item.confidence, 0), 1) : 0.9,
        reason: formattedReason,
      });
    }
  }

  const results: CompanyClassificationResult[] = [];
  for (const c of companies) {
    const aiResult = resultMap.get(c.normalizedName) || resultMap.get(normalizeCompanyName(c.companyName));
    if (aiResult) {
      results.push({
        companyName: c.companyName,
        normalizedName: c.normalizedName,
        relevant: aiResult.relevant,
        confidence: aiResult.confidence,
        status: aiResult.relevant ? 'RELEVANT' : 'IRRELEVANT',
        source: 'gemini',
        reason: aiResult.reason,
      });
    } else {
      // Fallback heuristic if a specific company was omitted from model array
      results.push(heuristicClassify(c.companyName, c.normalizedName));
    }
  }

  return results;
}

/**
 * Main company classification entry point.
 * Prioritizes Gemini AI when available, using robust heuristic classification as a controlled fallback.
 * Guarantees company-level classification shared by all contacts of that normalized company.
 */
export async function classifyCompanies(
  companies: { rawName: string }[],
  geminiClientOverride?: typeof callGemini | null
): Promise<Map<string, CompanyClassificationResult>> {
  const finalMap = new Map<string, CompanyClassificationResult>();
  const toLookupInDb: { companyName: string; normalizedName: string }[] = [];

  // 1. Check in-memory cache
  for (const c of companies) {
    const normalized = normalizeCompanyName(c.rawName);
    if (!normalized) continue;

    const display = formatCompanyDisplayName(c.rawName);
    if (memoryCache.has(normalized)) {
      finalMap.set(normalized, memoryCache.get(normalized)!);
    } else {
      toLookupInDb.push({ companyName: display, normalizedName: normalized });
    }
  }

  if (toLookupInDb.length === 0) {
    return finalMap;
  }

  // 2. Check SQLite database cache
  const dbCached = getCachedFromDb(toLookupInDb.map((c) => c.normalizedName));
  const toClassify: { companyName: string; normalizedName: string }[] = [];
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

  // 3. Classify uncached companies
  const hasGemini = Boolean(geminiClientOverride !== null && (geminiClientOverride !== undefined || getGeminiClient()));

  // Batch process in chunks of 10
  const BATCH_SIZE = 10;
  for (let i = 0; i < toClassify.length; i += BATCH_SIZE) {
    const chunk = toClassify.slice(i, i + BATCH_SIZE);
    let geminiFailureDiag: GeminiFailureDiagnostic | undefined;

    if (hasGemini) {
      try {
        const aiResults = await classifyWithGeminiBatch(chunk, geminiClientOverride || undefined);
        for (const res of aiResults) {
          finalMap.set(res.normalizedName, res);
          memoryCache.set(res.normalizedName, res);
          newlyClassified.push(res);
        }
        continue;
      } catch (err: unknown) {
        geminiFailureDiag = diagnoseGeminiFailure(err);
        console.warn(`[CompanyClassifier] Gemini batch classification failed: ${geminiFailureDiag.safeDetail}`);
      }
    } else {
      geminiFailureDiag = diagnoseGeminiFailure(new Error('GEMINI_API_KEY is not configured in the environment.'));
    }

    // Controlled heuristic fallback if Gemini is absent or failed
    for (const item of chunk) {
      const fallback = heuristicClassify(item.companyName, item.normalizedName, geminiFailureDiag);
      finalMap.set(item.normalizedName, fallback);
      memoryCache.set(item.normalizedName, fallback);
      newlyClassified.push(fallback);
    }
  }

  // 4. Save newly classified confident companies to database
  if (newlyClassified.length > 0) {
    saveClassificationsToDb(newlyClassified);
  }

  return finalMap;
}
