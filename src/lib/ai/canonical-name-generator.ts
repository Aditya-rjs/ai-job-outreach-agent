import { callAi } from './ai-dispatcher';
import { GEMINI_PRIORITIES } from './gemini-client';
import { formatCompanyDisplayName } from '@/lib/utils/company';

/**
 * Generates standard canonical company names for observed relevant companies.
 *
 * Requirements:
 * - Receives ONLY the observed company name(s).
 * - Does NOT receive or search the existing database.
 * - Does NOT receive existing company lists or aliases.
 * - Asks AI to provide the standard/clean canonical company name for each observed entity.
 */

export async function generateCanonicalCompanyNames(
  observedCompanyNames: string[],
  aiCallerOverride?: ((prompt: string) => Promise<string>) | null
): Promise<Map<string, string>> {
  const canonicalMap = new Map<string, string>();
  if (!observedCompanyNames || observedCompanyNames.length === 0) {
    return canonicalMap;
  }

  // Deduplicate observed names
  const uniqueNames = Array.from(
    new Set(observedCompanyNames.map((n) => formatCompanyDisplayName(n)).filter(Boolean))
  );

  if (uniqueNames.length === 0) {
    return canonicalMap;
  }

  const prompt = `You are an expert entity normalizer for a job outreach system.

Given the following list of observed company names, determine the standard, clean canonical company name for each.

Guidelines:
- Return the standard, clean canonical company name.
- Remove extraneous legal suffixes (such as Inc., LLC, Ltd., Pvt. Ltd.) and web domains (.com, etc.) where appropriate.
- Do not invent information.

Respond ONLY with a JSON array of objects in this exact format:
[
  { "observed": "Exact input name", "canonical": "Canonical Company Name" }
]

Observed companies:
${JSON.stringify(uniqueNames, null, 2)}`;

  try {
    let responseText = '';
    if (typeof aiCallerOverride === 'function') {
      const raw = await aiCallerOverride(prompt);
      responseText = typeof raw === 'object' && raw !== null && 'text' in raw ? (raw as any).text : String(raw);
    } else {
      const aiRes = await callAi(prompt, {
        priority: GEMINI_PRIORITIES.COMPANY_CLASSIFICATION,
        temperature: 0.1,
        taskName: `canonical-name-generation-${uniqueNames.length}`,
      });
      responseText = aiRes.text;
    }

    const cleaned = responseText.replace(/```json/gi, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleaned);

    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (item && typeof item.observed === 'string' && typeof item.canonical === 'string') {
          const canonical = formatCompanyDisplayName(item.canonical);
          if (canonical) {
            canonicalMap.set(item.observed.trim(), canonical);
          }
        }
      }
    }
  } catch (err) {
    console.warn('[CanonicalNameGenerator] AI canonical generation failed:', err);
  }

  // Fallback: If AI failed or omitted any company, use clean display name as canonical
  for (const name of uniqueNames) {
    if (!canonicalMap.has(name)) {
      canonicalMap.set(name, name);
    }
  }

  return canonicalMap;
}

/**
 * Single-company convenience wrapper.
 */
export async function generateCanonicalCompanyName(
  observedCompanyName: string,
  aiCallerOverride?: ((prompt: string) => Promise<string>) | null
): Promise<string> {
  const map = await generateCanonicalCompanyNames([observedCompanyName], aiCallerOverride);
  return map.get(formatCompanyDisplayName(observedCompanyName)) || formatCompanyDisplayName(observedCompanyName);
}
