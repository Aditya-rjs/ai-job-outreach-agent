import { getDb } from '@/db';
import { companyClassifications } from '@/db/schema';
import { inArray } from 'drizzle-orm';
import { callGemini, getGeminiClient } from './gemini-client';
import { normalizeCompanyName, formatCompanyDisplayName } from '@/lib/utils/company';

export interface CompanyClassificationResult {
  companyName: string;
  normalizedName: string;
  relevant: boolean;
  confidence: number;
  reason: string;
}

// In-memory cache for ultra-fast lookup within current batch process
const memoryCache = new Map<string, CompanyClassificationResult>();

// Known tech and enterprise tech keyword heuristics for fallback when Gemini API key is not configured
const KNOWN_TECH_KEYWORDS = [
  'tech', 'technology', 'technologies', 'software', 'systems', 'cloud', 'devops',
  'data', 'ai', 'analytics', 'cyber', 'security', 'digital', 'saas', 'informatics',
  'solutions', 'labs', 'computing', 'interactive', 'networks', 'web', 'app', 'media'
];

const KNOWN_TECH_COMPANIES = new Set([
  'google', 'microsoft', 'amazon', 'apple', 'meta', 'facebook', 'netflix', 'adobe',
  'salesforce', 'oracle', 'ibm', 'intel', 'cisco', 'nvidia', 'uber', 'airbnb', 'spotify',
  'tcs', 'tata consultancy', 'tata consultancy services', 'infosys', 'wipro', 'hcl', 'cognizant', 'accenture',
  'capgemini', 'deloitte', 'tech mahindra', 'persistent', 'zoho', 'freshworks', 'swiggy',
  'zomato', 'flipkart', 'paytm', 'phonepe', 'razorpay', 'cred', 'jpmorgan', 'jpmorgan chase', 'goldman sachs',
  'morgan stanley', 'barclays', 'hsbc', 'stripe', 'palantir', 'datadog', 'snowflake'
]);

const KNOWN_NON_TECH_KEYWORDS = [
  'construction', 'cement', 'plumbing', 'real estate', 'realty', 'builders',
  'furniture', 'textiles', 'bakery', 'restaurant', 'cafe', 'laundry', 'salon',
  'mining', 'drilling', 'carpentry', 'farming', 'poultry', 'dairy'
];

/**
 * Heuristic fallback classification when Gemini API is unavailable.
 */
function heuristicClassify(companyName: string, normalizedName: string): CompanyClassificationResult {
  if (KNOWN_TECH_COMPANIES.has(normalizedName)) {
    return {
      companyName,
      normalizedName,
      relevant: true,
      confidence: 0.95,
      reason: 'Known major technology company or engineering enterprise (heuristic match).',
    };
  }

  for (const kw of KNOWN_TECH_KEYWORDS) {
    if (normalizedName.includes(kw)) {
      return {
        companyName,
        normalizedName,
        relevant: true,
        confidence: 0.85,
        reason: `Company name indicates software/IT/technology operations matching keyword "${kw}".`,
      };
    }
  }

  for (const nkw of KNOWN_NON_TECH_KEYWORDS) {
    if (normalizedName.includes(nkw)) {
      return {
        companyName,
        normalizedName,
        relevant: false,
        confidence: 0.90,
        reason: `Traditional non-technology industry indicated by keyword "${nkw}".`,
      };
    }
  }

  // If unknown and no Gemini key, do not assume relevant (safe default)
  return {
    companyName,
    normalizedName,
    relevant: false,
    confidence: 0.50,
    reason: 'Unable to verify CS/IT relevance without Gemini API key configured.',
  };
}

/**
 * Loads cached classifications from SQLite database.
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
      const item: CompanyClassificationResult = {
        companyName: r.companyName,
        normalizedName: r.normalizedName,
        relevant: Boolean(r.isRelevant),
        confidence: r.confidence,
        reason: r.reason,
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
 */
function saveClassificationsToDb(results: CompanyClassificationResult[]): void {
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
  companies: { companyName: string; normalizedName: string }[]
): Promise<CompanyClassificationResult[]> {
  const prompt = `You are an expert technical recruiter evaluating companies for Computer Science, Information Technology, and Software Engineering outreach.

Target Domains:
- Computer Science / Software Engineering / IT
- Web & Mobile Development
- Cloud, DevOps, Infrastructure
- Data Engineering, AI/ML, Data Science
- Cybersecurity, Information Security
- SaaS & B2B/B2C Technology Products
- FinTech & Digital Banking with substantial in-house software teams
- Modern enterprises (e.g. automotive, logistics, healthcare, retail) with significant in-house software engineering operations

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

  const responseText = await callGemini(prompt, { temperature: 0.1 });
  const cleaned = responseText.replace(/```json/gi, '').replace(/```/g, '').trim();
  const parsed = JSON.parse(cleaned);

  if (!Array.isArray(parsed)) {
    throw new Error('Gemini response is not an array');
  }

  const resultMap = new Map<string, { relevant: boolean; confidence: number; reason: string }>();
  for (const item of parsed) {
    if (item && typeof item.company === 'string' && typeof item.relevant === 'boolean') {
      const norm = normalizeCompanyName(item.company);
      resultMap.set(norm, {
        relevant: item.relevant,
        confidence: typeof item.confidence === 'number' ? Math.min(Math.max(item.confidence, 0), 1) : 0.8,
        reason: typeof item.reason === 'string' && item.reason.trim() ? item.reason.trim() : 'Classified by Gemini AI.',
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
        reason: aiResult.reason,
      });
    } else {
      // Fallback heuristic if one was omitted
      results.push(heuristicClassify(c.companyName, c.normalizedName));
    }
  }

  return results;
}

/**
 * Main classification entry point.
 * Classifies a list of unique companies, checking memory cache and database cache first.
 */
export async function classifyCompanies(
  companies: { rawName: string }[]
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
  const toClassifyWithAI: { companyName: string; normalizedName: string }[] = [];

  for (const c of toLookupInDb) {
    if (dbCached.has(c.normalizedName)) {
      const cached = dbCached.get(c.normalizedName)!;
      finalMap.set(c.normalizedName, cached);
      memoryCache.set(c.normalizedName, cached);
    } else {
      toClassifyWithAI.push(c);
    }
  }

  if (toClassifyWithAI.length === 0) {
    return finalMap;
  }

  // 3. Classify uncached companies
  const newlyClassified: CompanyClassificationResult[] = [];
  const hasGemini = Boolean(getGeminiClient());

  // Batch process in chunks of 10 to avoid token limits and respect Gemini rate limits
  const BATCH_SIZE = 10;
  for (let i = 0; i < toClassifyWithAI.length; i += BATCH_SIZE) {
    const chunk = toClassifyWithAI.slice(i, i + BATCH_SIZE);

    if (hasGemini) {
      try {
        const aiResults = await classifyWithGeminiBatch(chunk);
        for (const res of aiResults) {
          finalMap.set(res.normalizedName, res);
          memoryCache.set(res.normalizedName, res);
          newlyClassified.push(res);
        }
        continue;
      } catch (err) {
        console.warn('Gemini batch classification failed, applying heuristic fallback:', err);
      }
    }

    // Fallback heuristic if no Gemini or on failure
    for (const item of chunk) {
      const fallback = heuristicClassify(item.companyName, item.normalizedName);
      finalMap.set(item.normalizedName, fallback);
      memoryCache.set(item.normalizedName, fallback);
      newlyClassified.push(fallback);
    }
  }

  // 4. Save newly classified companies to database
  if (newlyClassified.length > 0) {
    saveClassificationsToDb(newlyClassified);
  }

  return finalMap;
}
