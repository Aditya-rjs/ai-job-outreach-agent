/**
 * Escapes all regular expression metacharacters in a string to safely use in dynamic RegExp construction.
 * Characters escaped: . * + ? ^ $ { } ( ) [ ] | \
 */
export function escapeRegExp(str: string): string {
  if (!str) return '';
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Normalizes email text by stripping greetings, signatures, and variable proper nouns
 * to compare the underlying structural sentences and phrasing.
 */
export function normalizeForComparison(text: string, dynamicWords: string[] = []): string[] {
  let cleaned = text.toLowerCase();

  // Strip greetings and sign-offs
  cleaned = cleaned.replace(/^(dear|hello|hi|good morning|good afternoon)[^\n,]*,?/gi, '');
  cleaned = cleaned.replace(/(best regards|sincerely|warm regards|cheers|thanks|thank you)[^\n]*/gi, '');

  // Strip known dynamic words like recipient name or company name safely
  for (const word of dynamicWords) {
    if (typeof word === 'string') {
      const trimmed = word.trim().toLowerCase();
      if (trimmed.length > 2) {
        const escaped = escapeRegExp(trimmed);
        const prefix = /^\w/.test(trimmed) ? '\\b' : '';
        const suffix = /\w$/.test(trimmed) ? '\\b' : '';
        try {
          const regex = new RegExp(`${prefix}${escaped}${suffix}`, 'gi');
          cleaned = cleaned.replace(regex, ' ');
        } catch {
          // Absolute fallback if regex engine still rejects
          cleaned = cleaned.split(trimmed).join(' ');
        }
      }
    }
  }

  // Remove punctuation and digits
  cleaned = cleaned.replace(/[^a-z\s]/g, ' ');

  // Split into non-trivial word tokens (words > 2 characters)
  const tokens = cleaned
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 2);

  return tokens;
}

/**
 * Creates word n-grams (default bigrams) from token list.
 */
function getBigrams(tokens: string[]): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i < tokens.length - 1; i++) {
    set.add(`${tokens[i]} ${tokens[i + 1]}`);
  }
  return set;
}

/**
 * Calculates Jaccard similarity between two sets of strings.
 * Result is between 0.0 (completely distinct) and 1.0 (identical).
 */
export function calculateJaccardSimilarity(setA: Set<string>, setB: Set<string>): number {
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersectionSize = 0;
  for (const item of setA) {
    if (setB.has(item)) {
      intersectionSize++;
    }
  }

  const unionSize = setA.size + setB.size - intersectionSize;
  return unionSize === 0 ? 0 : intersectionSize / unionSize;
}

/**
 * Evaluates whether a new email body is excessively similar to any previously generated email.
 * Threshold defaults to 0.65 (65% bigram structural overlap).
 */
export function checkEmailSimilarity(
  newEmailBody: string,
  existingEmailBodies: string[],
  dynamicWordsToIgnore: string[] = [],
  threshold: number = 0.65
): { isTooSimilar: boolean; maxSimilarity: number } {
  if (existingEmailBodies.length === 0) {
    return { isTooSimilar: false, maxSimilarity: 0 };
  }

  const newTokens = normalizeForComparison(newEmailBody, dynamicWordsToIgnore);
  const newBigrams = getBigrams(newTokens);

  let maxSimilarity = 0;

  for (const existing of existingEmailBodies) {
    if (!existing || existing.trim().length === 0) continue;

    const existingTokens = normalizeForComparison(existing, dynamicWordsToIgnore);
    const existingBigrams = getBigrams(existingTokens);

    const sim = calculateJaccardSimilarity(newBigrams, existingBigrams);
    if (sim > maxSimilarity) {
      maxSimilarity = sim;
    }

    if (maxSimilarity >= threshold) {
      return { isTooSimilar: true, maxSimilarity };
    }
  }

  return { isTooSimilar: false, maxSimilarity };
}
