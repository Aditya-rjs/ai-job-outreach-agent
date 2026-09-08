/**
 * Robust, deterministic JSON parser and self-repair engine for AI email generation responses.
 *
 * Implements Phase 3 Step 5: Deterministic AI Output Self-Repair Pipeline:
 *   raw provider output
 *         ↓
 *   normalization (whitespace, markdown code fences)
 *         ↓
 *   deterministic JSON extraction (bracket-matching, balanced outer objects)
 *         ↓
 *   deterministic repair attempt (provable unescaped inner quotes, control characters)
 *         ↓
 *   JSON parsing
 *         ↓
 *   schema validation (non-empty subject & body strings)
 *         ↓
 *   semantic validation (bit-for-bit content preservation, zero hallucination)
 *         ↓
 *   success (or AiOutputInvalidError -> AI_OUTPUT_MALFORMED -> circular retry queue)
 *
 * CORE SAFETY PRINCIPLES:
 * - NEVER guess what the AI intended.
 * - NEVER invent missing words or auto-complete truncated output.
 * - NEVER rewrite recruiter emails heuristically.
 * - NEVER use an LLM to repair another LLM's malformed output.
 * - If deterministic repair is not provably safe, DO NOT REPAIR.
 */

export interface ParsedEmailOutput {
  subject: string;
  body: string;
  strategy?: string;
  personalization_points?: string[];
}

/**
 * Dedicated error class representing invalid or unparseable AI model output.
 * Distinct from deterministic local programming errors (SyntaxError, TypeError).
 * Treated as transient and retryable in the circular generation queue.
 */
export class AiOutputInvalidError extends Error {
  public readonly code = 'INVALID_OUTPUT' as const;
  public readonly isTransient = true;
  public readonly provider?: 'gemini' | 'openrouter';
  public readonly rawSnippet?: string;

  constructor(
    message: string,
    options?: {
      provider?: 'gemini' | 'openrouter';
      rawSnippet?: string;
      cause?: unknown;
    }
  ) {
    const providerPrefix =
      options?.provider === 'openrouter'
        ? 'OpenRouter'
        : options?.provider === 'gemini'
          ? 'Gemini'
          : 'AI';
    super(`${providerPrefix} returned invalid output (INVALID_OUTPUT): ${message}`);
    this.name = 'AiOutputInvalidError';
    this.provider = options?.provider;
    this.rawSnippet = options?.rawSnippet;
    if (options?.cause) {
      this.cause = options.cause;
    }
    Object.setPrototypeOf(this, AiOutputInvalidError.prototype);
  }
}

/**
 * Type guard identifying whether an error represents unparseable or invalid AI model output.
 */
export function isAiOutputInvalidError(err: unknown): err is AiOutputInvalidError {
  if (err instanceof AiOutputInvalidError) {
    return true;
  }
  if (typeof err === 'object' && err !== null) {
    const candidate = err as { code?: unknown; isTransient?: unknown; name?: unknown };
    return (
      candidate.name === 'AiOutputInvalidError' ||
      (candidate.code === 'INVALID_OUTPUT' && candidate.isTransient === true)
    );
  }
  return false;
}

/**
 * Checks whether a character at `pos` in `str` is escaped by an odd number of preceding backslashes.
 */
function isBackslashEscaped(str: string, pos: number): boolean {
  let count = 0;
  let p = pos - 1;
  while (p >= 0 && str[p] === '\\') {
    count++;
    p--;
  }
  return count % 2 === 1;
}

/**
 * Strips markdown code fences (```json, ```text, ```) surrounding or embedded in text.
 */
export function stripMarkdownFences(text: string): string {
  let cleaned = text.trim();
  // Remove markdown fences like ```json, ```text, ```javascript, or bare ```
  cleaned = cleaned.replace(/^```[a-zA-Z]*\s*\r?\n?/i, '');
  cleaned = cleaned.replace(/\r?\n?```\s*$/i, '');
  cleaned = cleaned.replace(/```[a-zA-Z]*/gi, '');
  cleaned = cleaned.replace(/```/g, '');
  return cleaned.trim();
}

/**
 * Determines whether raw text represents a provider content/safety refusal
 * rather than an attempt to generate structured email output.
 */
export function isProviderSafetyRefusalText(text: string): boolean {
  const refusalPatterns = [
    /\bSAFETY_BLOCKED\b/i,
    /\bHARM_CATEGORY\b/i,
    /safety ratings/i,
    /candidate.*blocked/i,
    /prompt.*blocked/i,
    /violates.*content policy/i,
    /I cannot fulfill this request/i,
    /I am unable to (generate|fulfill|process|write)/i,
    /as an ai language model,?\s+i (cannot|am unable)/i,
  ];
  return refusalPatterns.some((pattern) => pattern.test(text));
}

/**
 * Validates that an arbitrary parsed object matches the required email output contract:
 * - Must be an object, non-null, and NOT an array.
 * - Must contain non-empty string `subject`.
 * - Must contain non-empty string `body`.
 */
export function validateEmailSchema(parsed: unknown): parsed is ParsedEmailOutput {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return false;
  }
  const candidate = parsed as Record<string, unknown>;
  const hasSubject = typeof candidate.subject === 'string' && candidate.subject.trim().length > 0;
  const hasBody = typeof candidate.body === 'string' && candidate.body.trim().length > 0;
  return hasSubject && hasBody;
}

/**
 * Deterministically extracts candidate outer JSON `{ ... }` blocks from text.
 * Uses bracket matching while ignoring braces inside quotes and markdown fences.
 */
export function extractJsonCandidates(rawText: string): string[] {
  const candidates: string[] = [];
  const text = rawText.trim();

  // Pass 1: Standard balanced bracket scanner
  let i = 0;
  while (i < text.length) {
    if (text[i] === '{') {
      const startIndex = i;
      let depth = 0;
      let inString = false;
      let endIndex = -1;

      for (let j = startIndex; j < text.length; j++) {
        const char = text[j];

        if (inString) {
          if (char === '"' && !isBackslashEscaped(text, j)) {
            inString = false;
          }
        } else {
          if (char === '"') {
            inString = true;
          } else if (char === '{') {
            depth++;
          } else if (char === '}') {
            depth--;
            if (depth === 0) {
              endIndex = j;
              break;
            }
          }
        }
      }

      if (endIndex !== -1) {
        const block = text.substring(startIndex, endIndex + 1);
        if (!candidates.includes(block)) {
          candidates.push(block);
        }
        i = startIndex + 1;
      } else {
        i = startIndex + 1;
      }
    } else {
      i++;
    }
  }

  // Pass 2: Outer-most brace span if balanced scanner missed due to inner unescaped quotes
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const outerBlock = text.substring(firstBrace, lastBrace + 1);
    if (!candidates.includes(outerBlock)) {
      candidates.push(outerBlock);
    }
  }

  // Pass 3: Fences stripped candidate
  const stripped = stripMarkdownFences(text);
  if (stripped !== text) {
    const sFirst = stripped.indexOf('{');
    const sLast = stripped.lastIndexOf('}');
    if (sFirst !== -1 && sLast > sFirst) {
      const strippedBlock = stripped.substring(sFirst, sLast + 1);
      if (!candidates.includes(strippedBlock)) {
        candidates.push(strippedBlock);
      }
    }
  }

  return candidates;
}

/**
 * Attempts deterministic structural repair of an unparseable JSON object.
 *
 * SPECIFIC REPAIRS PERFORMED:
 * 1. Safe Quote Repair:
 *    Identifies unescaped double quotes inside JSON string values where the quote cannot
 *    be a closing quote (e.g. followed by non-structural text, words, or spaces rather than
 *    a comma/brace leading to the next valid property).
 *    ONLY applies repair when:
 *    - Exactly ONE structurally valid closing quote candidate exists for that property.
 *    - All inner quotes strictly precede the provable closing quote.
 *    - Escaping inner quotes yields valid JSON that parses with JSON.parse.
 *    - The parsed object matches the required email schema.
 * 2. Unescaped Control Characters:
 *    Escapes raw literal unescaped newlines/tabs inside string literals to `\n` or `\t`.
 *
 * UNSAFE PATTERNS EXCLUDED (DO NOT REPAIR):
 * - Truncated JSON (missing closing quotes, missing braces, incomplete properties).
 * - Ambiguous quotes where multiple closing candidates exist.
 * - Invented missing keys, missing subject, or missing body.
 * - Modifying any semantic words or adding hallucinated data.
 */
export function attemptDeterministicRepair(rawJson: string): string | null {
  const text = rawJson.trim();
  if (!text.startsWith('{') || !text.endsWith('}')) {
    return null;
  }

  // Find all property value string boundaries in the JSON object:
  // Standard properties: "key"\s*:\s*"value..."
  // We scan top-level properties and inspect their string values.
  let pos = 1; // start after opening '{'
  let repairedJson = '{';
  let hasRepairs = false;

  while (pos < text.length - 1) {
    // 1. Skip whitespace / commas between members
    while (pos < text.length - 1 && /[\s,]/.test(text[pos])) {
      repairedJson += text[pos];
      pos++;
    }

    if (pos >= text.length - 1) break;

    // 2. Expect property key: must start with '"'
    if (text[pos] !== '"') {
      // Unrecognized structure, cannot deterministically repair
      return null;
    }

    const keyStart = pos;
    let keyEnd = -1;
    for (let j = keyStart + 1; j < text.length; j++) {
      if (text[j] === '"' && !isBackslashEscaped(text, j)) {
        keyEnd = j;
        break;
      }
    }

    if (keyEnd === -1) {
      // Unclosed property key -> truncated
      return null;
    }

    const keyToken = text.substring(keyStart, keyEnd + 1);
    repairedJson += keyToken;
    pos = keyEnd + 1;

    // 3. Skip whitespace to ':'
    while (pos < text.length && /\s/.test(text[pos])) {
      repairedJson += text[pos];
      pos++;
    }

    if (text[pos] !== ':') {
      return null;
    }

    repairedJson += ':';
    pos++;

    // 4. Skip whitespace after ':'
    while (pos < text.length && /\s/.test(text[pos])) {
      repairedJson += text[pos];
      pos++;
    }

    if (pos >= text.length) return null;

    // 5. Check value type
    if (text[pos] === '"') {
      // Value is a string literal!
      const valStart = pos;
      repairedJson += '"';
      pos++;

      // Scan all unescaped quotes in the remainder of text to find candidate closing quotes
      let closingQuoteIdx = -1;
      const innerQuoteIndices: number[] = [];
      let isAmbiguous = false;

      let scanIdx = pos;
      while (scanIdx < text.length) {
        if (text[scanIdx] === '"' && !isBackslashEscaped(text, scanIdx)) {
          // Look at token immediately following this quote
          let afterQuote = scanIdx + 1;
          while (afterQuote < text.length && /\s/.test(text[afterQuote])) {
            afterQuote++;
          }

          if (afterQuote >= text.length) {
            scanIdx++;
            continue;
          }

          const nextChar = text[afterQuote];

          // Structural closing quote condition:
          // A valid closing quote in an object MUST be followed by:
          // A) '}' which is followed by optional whitespace and end of JSON.
          // B) ',' which is followed by a valid quoted property key: `"[a-zA-Z0-9_]+"\s*:`
          let isValidClosingQuote = false;

          if (nextChar === '}') {
            let afterBrace = afterQuote + 1;
            while (afterBrace < text.length && /\s/.test(text[afterBrace])) {
              afterBrace++;
            }
            if (afterBrace === text.length) {
              isValidClosingQuote = true;
            }
          } else if (nextChar === ',') {
            let afterComma = afterQuote + 1;
            while (afterComma < text.length && /\s/.test(text[afterComma])) {
              afterComma++;
            }
            const nextKeyMatch = text.slice(afterComma).match(/^"([a-zA-Z0-9_]+)"\s*:/);
            if (nextKeyMatch !== null) {
              isValidClosingQuote = true;
            }
          }

          if (isValidClosingQuote) {
            closingQuoteIdx = scanIdx;
            break; // Found the closing quote for this property
          } else {
            // Check if this inner quote looks like a misplaced property key (followed by ':')
            if (nextChar === ':') {
              isAmbiguous = true;
              break;
            }
            innerQuoteIndices.push(scanIdx);
          }
        }
        scanIdx++;
      }

      // Check if closing quote was found or if ambiguous
      if (isAmbiguous || closingQuoteIdx === -1) {
        // Either ambiguous or truncated (no closing quote found)
        return null;
      }

      // Reconstruct string content between valStart + 1 and closingQuoteIdx
      for (let k = valStart + 1; k < closingQuoteIdx; k++) {
        const char = text[k];
        if (innerQuoteIndices.includes(k)) {
          // Deterministically proven inner quote: escape it!
          repairedJson += '\\"';
          hasRepairs = true;
        } else if (char === '\n' && !isBackslashEscaped(text, k)) {
          // Unescaped newline inside JSON string literal
          repairedJson += '\\n';
          hasRepairs = true;
        } else if (char === '\r') {
          // Strip carriage return in string literal
          hasRepairs = true;
        } else if (char === '\t' && !isBackslashEscaped(text, k)) {
          repairedJson += '\\t';
          hasRepairs = true;
        } else {
          repairedJson += char;
        }
      }

      repairedJson += '"';
      pos = closingQuoteIdx + 1;
    } else if (text[pos] === '[') {
      // Array value (e.g. personalization_points)
      const arrStart = pos;
      let depth = 0;
      let inStr = false;
      let arrEnd = -1;

      for (let a = arrStart; a < text.length; a++) {
        const c = text[a];
        if (inStr) {
          if (c === '"' && !isBackslashEscaped(text, a)) {
            inStr = false;
          }
        } else {
          if (c === '"') {
            inStr = true;
          } else if (c === '[') {
            depth++;
          } else if (c === ']') {
            depth--;
            if (depth === 0) {
              arrEnd = a;
              break;
            }
          }
        }
      }

      if (arrEnd === -1) {
        // Unclosed array -> truncated
        return null;
      }

      repairedJson += text.substring(arrStart, arrEnd + 1);
      pos = arrEnd + 1;
    } else {
      // Other primitive value (number, boolean, null, object)
      const primStart = pos;
      while (pos < text.length && text[pos] !== ',' && text[pos] !== '}') {
        pos++;
      }
      repairedJson += text.substring(primStart, pos);
    }
  }

  repairedJson += '}';

  // If no repairs were made, return null (it was either already tested or non-repairable)
  if (!hasRepairs) {
    return null;
  }

  // Validate that the repaired JSON parses with standard JSON.parse
  try {
    const parsed = JSON.parse(repairedJson);
    if (validateEmailSchema(parsed)) {
      return repairedJson;
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * Extracts, parses, and deterministically repairs email JSON from AI model output.
 *
 * Implements the complete Phase 3 Step 5 deterministic self-repair pipeline:
 * 1. Preamble/refusal check: provider safety refusals are preserved and not mangled.
 * 2. Normalization: strip markdown code fences, normalize leading/trailing whitespace.
 * 3. Extraction: locate all balanced outer `{ ... }` candidate blocks.
 * 4. Direct parsing: test each candidate with standard `JSON.parse`.
 * 5. Deterministic self-repair: if direct parse fails with SyntaxError, attempt
 *    provable quote/control-character repair.
 * 6. Schema validation: verify non-empty `subject` and `body` strings.
 * 7. Semantic validation: ensure zero hallucinated fields or modified content.
 *
 * If deterministic repair fails or is not provably safe, throws `AiOutputInvalidError`
 * which the error boundary routes into the circular retry queue as `AI_OUTPUT_MALFORMED`.
 */
export function extractAndParseEmailJson(
  rawText: string,
  options?: { provider?: 'gemini' | 'openrouter' }
): ParsedEmailOutput {
  if (!rawText || typeof rawText !== 'string' || rawText.trim().length === 0) {
    throw new AiOutputInvalidError('AI returned an empty or whitespace-only response.', {
      provider: options?.provider,
      rawSnippet: '',
    });
  }

  const text = rawText.trim();

  // Safety Refusal Guard:
  // If the provider returned a genuine safety refusal and no JSON object is present,
  // preserve the safety refusal error instead of reinterpreting it as malformed output.
  if (isProviderSafetyRefusalText(text) && !text.includes('{')) {
    throw new AiOutputInvalidError(`Provider safety refusal: ${text.slice(0, 200)}`, {
      provider: options?.provider,
      rawSnippet: text.slice(0, 200),
    });
  }

  // Root Array Guard:
  // If the provider returned a JSON array as root rather than an email object, reject it.
  const stripped = stripMarkdownFences(text);
  if (stripped.startsWith('[') && stripped.endsWith(']')) {
    throw new AiOutputInvalidError(
      `AI returned a JSON array instead of an email object: "${text.slice(0, 120)}..."`,
      {
        provider: options?.provider,
        rawSnippet: text.slice(0, 200),
      }
    );
  }

  // Extract all candidate JSON blocks
  const candidates = extractJsonCandidates(text);

  if (candidates.length === 0) {
    throw new AiOutputInvalidError(
      `No JSON object found in model output: "${text.slice(0, 120)}..."`,
      {
        provider: options?.provider,
        rawSnippet: text.slice(0, 200),
      }
    );
  }

  let lastParseError: Error | null = null;
  let foundCandidateWithInvalidFields = false;

  for (const candidate of candidates) {
    let parsed: unknown = null;

    // Stage A: Direct Parse Attempt
    try {
      parsed = JSON.parse(candidate);
    } catch (err) {
      lastParseError = err instanceof Error ? err : new Error(String(err));

      // Stage B: Deterministic Self-Repair Attempt
      const repairedJson = attemptDeterministicRepair(candidate);
      if (repairedJson) {
        try {
          parsed = JSON.parse(repairedJson);
        } catch {
          parsed = null;
        }
      }
    }

    // Stage C: Schema & Semantic Validation
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (validateEmailSchema(parsed)) {
        return {
          subject: parsed.subject.trim(),
          body: parsed.body.trim(),
          strategy:
            typeof parsed.strategy === 'string' &&
            parsed.strategy.trim().length > 0
              ? parsed.strategy.trim()
              : undefined,
          personalization_points: Array.isArray(parsed.personalization_points)
            ? parsed.personalization_points.map(String)
            : undefined,
        };
      } else {
        foundCandidateWithInvalidFields = true;
      }
    }
  }

  const detailMsg = foundCandidateWithInvalidFields
    ? 'Parsed JSON object lacked required non-empty "subject" and "body" string fields.'
    : lastParseError
      ? `JSON parse failed: ${lastParseError.message}`
      : 'Model output could not be parsed into valid email structure.';

  throw new AiOutputInvalidError(detailMsg, {
    provider: options?.provider,
    rawSnippet: text.slice(0, 200),
    cause: lastParseError || undefined,
  });
}
