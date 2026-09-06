import fs from 'fs';
import {
  classifyCompanies,
  resetClassificationMemoryCache,
  type CompanyClassificationResult,
} from '../../src/lib/ai/company-classifier';
import { categorizeGeminiError, sanitizeSecretText } from '../../src/lib/ai/gemini-client';
import { reconcilePendingClassifications } from '../../src/lib/pipeline/classification-reconciler';

import { initializeDatabase } from '../../src/db/migrate';

initializeDatabase();

const action = process.argv[2];
const inputRaw = fs.readFileSync(0, 'utf-8');

if (action === 'init') {
  console.log('OUTPUT:' + JSON.stringify({ success: true }));
} else if (action === 'diagnose') {
  const { errorString, apiKeyEnv } = JSON.parse(inputRaw);
  if (apiKeyEnv !== undefined) {
    process.env.GEMINI_API_KEY = apiKeyEnv;
  }
  const result = categorizeGeminiError(new Error(errorString));
  console.log('OUTPUT:' + JSON.stringify(result));
} else if (action === 'sanitize') {
  const { text } = JSON.parse(inputRaw);
  const result = sanitizeSecretText(text);
  console.log('OUTPUT:' + JSON.stringify(result));
} else if (action === 'classify') {
  const { companies, geminiMockResponse, geminiThrows, apiKeyEnv } = JSON.parse(inputRaw);
  if (apiKeyEnv !== undefined) {
    process.env.GEMINI_API_KEY = apiKeyEnv;
  }
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
} else if (action === 'reconcile') {
  const { geminiMockResponse, geminiThrows } = JSON.parse(inputRaw);
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

  reconcilePendingClassifications(overrideClient)
    .then((result) => {
      console.log('OUTPUT:' + JSON.stringify(result));
    })
    .catch((err) => {
      console.error('ERROR:' + (err?.message || err));
      process.exit(1);
    });
} else {
  console.error('Unknown action');
  process.exit(1);
}
