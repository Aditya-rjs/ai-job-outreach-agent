/**
 * Robust JSON parser and error classification for AI email generation responses.
 *
 * Replaces naive regex fence replacement with deterministic bracket matching.
 * Safely extracts valid outer JSON objects amidst preambles (e.g. "User Safety: safe"),
 * markdown code fences, and ignores braces/escaped quotes inside JSON string literals.
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
 * Treated as transient and retryable up to MAX_GENERATION_RETRIES.
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
 * Extracts and parses a valid email JSON object from an AI model response.
 *
 * Uses deterministic bracket matching:
 * - Scans for opening '{'
 * - Tracks '{' and '}' nesting depth outside string literals
 * - Ignores braces occurring inside JSON string literals
 * - Properly handles escaped quotes (\") and backslashes (\\)
 * - Validates required string fields: subject and body
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
  const candidates: string[] = [];

  // Deterministic scanner to identify all balanced outer { ... } blocks
  let i = 0;
  while (i < text.length) {
    if (text[i] === '{') {
      const startIndex = i;
      let depth = 0;
      let inString = false;
      let escaped = false;
      let endIndex = -1;

      for (let j = startIndex; j < text.length; j++) {
        const char = text[j];

        if (inString) {
          if (char === '\\') {
            escaped = !escaped;
          } else {
            if (char === '"' && !escaped) {
              inString = false;
            }
            escaped = false;
          }
        } else {
          if (char === '"') {
            inString = true;
            escaped = false;
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
        candidates.push(text.substring(startIndex, endIndex + 1));
        // Advance past this opening brace to find next block if this candidate fails validation
        i = startIndex + 1;
      } else {
        // Unclosed brace
        i = startIndex + 1;
      }
    } else {
      i++;
    }
  }

  // Also test markdown-stripped string as a fallback candidate if bracket matching didn't catch it
  const cleanedMarkdown = text
    .replace(/```(?:json)?/gi, '')
    .replace(/```/g, '')
    .trim();
  if (
    cleanedMarkdown.startsWith('{') &&
    cleanedMarkdown.endsWith('}') &&
    !candidates.includes(cleanedMarkdown)
  ) {
    candidates.push(cleanedMarkdown);
  }

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
    try {
      const parsed = JSON.parse(candidate);

      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const hasValidSubject =
          typeof parsed.subject === 'string' && parsed.subject.trim().length > 0;
        const hasValidBody =
          typeof parsed.body === 'string' && parsed.body.trim().length > 0;

        if (hasValidSubject && hasValidBody) {
          return {
            subject: parsed.subject.trim(),
            body: parsed.body.trim(),
            strategy:
              typeof parsed.strategy === 'string' && parsed.strategy.trim().length > 0
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
    } catch (err) {
      lastParseError = err instanceof Error ? err : new Error(String(err));
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
