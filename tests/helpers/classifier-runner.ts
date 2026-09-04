import fs from 'fs';
import {
  heuristicClassify,
  diagnoseGeminiFailure,
  sanitizeDiagnostic,
  classifyCompanies,
  resetClassificationMemoryCache,
  type CompanyClassificationResult,
} from '../../src/lib/ai/company-classifier';

const action = process.argv[2];
const inputRaw = fs.readFileSync(0, 'utf-8');

if (action === 'diagnose') {
  const { errorString, apiKeyEnv } = JSON.parse(inputRaw);
  if (apiKeyEnv !== undefined) {
    process.env.GEMINI_API_KEY = apiKeyEnv;
  }
  const result = diagnoseGeminiFailure(new Error(errorString));
  console.log('OUTPUT:' + JSON.stringify(result));
} else if (action === 'heuristic') {
  const { companyName, normalizedName, geminiError, apiKeyEnv } = JSON.parse(inputRaw);
  if (apiKeyEnv !== undefined) {
    process.env.GEMINI_API_KEY = apiKeyEnv;
  } else if (geminiError && !process.env.GEMINI_API_KEY) {
    // If testing an active Gemini runtime error, simulate that the key was configured
    process.env.GEMINI_API_KEY = 'test-key-configured';
  }
  const diag = geminiError ? diagnoseGeminiFailure(new Error(geminiError)) : undefined;
  const result = heuristicClassify(companyName, normalizedName, diag);
  console.log('OUTPUT:' + JSON.stringify(result));
} else if (action === 'sanitize') {
  const { text } = JSON.parse(inputRaw);
  const result = sanitizeDiagnostic(text);
  console.log('OUTPUT:' + JSON.stringify(result));
} else if (action === 'classify') {
  const { companies, geminiMockResponse, geminiThrows } = JSON.parse(inputRaw);
  resetClassificationMemoryCache();

  let overrideClient: ((prompt: string) => Promise<string>) | undefined = undefined;
  if (geminiThrows) {
    overrideClient = async () => {
      throw new Error(geminiThrows);
    };
  } else if (geminiMockResponse) {
    overrideClient = async () => {
      return JSON.stringify(geminiMockResponse);
    };
  }

  classifyCompanies(companies, overrideClient)
    .then((map) => {
      const obj: Record<string, CompanyClassificationResult> = {};
      for (const [k, v] of map.entries()) {
        obj[k] = v;
      }
      console.log('OUTPUT:' + JSON.stringify(obj));
    })
    .catch((err) => {
      console.error('ERROR:' + (err?.message || err));
      process.exit(1);
    });
} else {
  console.error('Unknown action');
  process.exit(1);
}
