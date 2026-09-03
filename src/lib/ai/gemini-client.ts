import { GoogleGenAI } from '@google/genai';

let clientInstance: GoogleGenAI | null = null;

export function getGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    return null;
  }
  if (!clientInstance) {
    clientInstance = new GoogleGenAI({ apiKey });
  }
  return clientInstance;
}

/**
 * Calls Gemini with automatic retries and exponential backoff.
 */
export async function callGemini(
  prompt: string,
  options: {
    model?: string;
    temperature?: number;
    maxRetries?: number;
    timeoutMs?: number;
  } = {}
): Promise<string> {
  const client = getGeminiClient();
  if (!client) {
    throw new Error('GEMINI_API_KEY is not configured in the environment.');
  }

  const model = options.model || 'gemini-2.5-flash';
  const maxRetries = options.maxRetries ?? 3;
  const timeoutMs = options.timeoutMs ?? 15000;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const abortController = new AbortController();
      const timeoutId = setTimeout(() => abortController.abort(), timeoutMs);

      const response = await Promise.race([
        client.models.generateContent({
          model,
          contents: prompt,
          config: {
            temperature: options.temperature ?? 0.2,
          },
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Gemini request timed out after ${timeoutMs}ms`)), timeoutMs)
        ),
      ]);

      clearTimeout(timeoutId);

      const text = response.text;
      if (!text) {
        throw new Error('Empty response from Gemini');
      }

      return text.trim();
    } catch (err: unknown) {
      lastError = err;
      const isRateLimit = String(err).includes('429') || String(err).includes('RESOURCE_EXHAUSTED');
      const isTimeout = String(err).includes('timed out');

      if (attempt < maxRetries && (isRateLimit || isTimeout || String(err).includes('fetch failed'))) {
        const delay = Math.pow(2, attempt) * 1000 + Math.random() * 500;
        await new Promise((res) => setTimeout(res, delay));
        continue;
      }
      break;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
