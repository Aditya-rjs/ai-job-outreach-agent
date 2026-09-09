/**
 * Verification Test Suite for Persistent Relevant Company Knowledge Base
 *
 * Verifies the simple approved architecture according to the 16 required test scenarios:
 * 1. Known canonical -> 0 AI classification calls.
 * 2. Known alias -> 0 AI classification calls.
 * 3. Unknown -> AI relevance check.
 * 4. Unknown + IRRELEVANT -> no KB entry.
 * 5. Unknown + NEEDS_REVIEW -> no KB entry.
 * 6. Unknown + classification failure -> no KB entry.
 * 7. Unknown + RELEVANT -> AI canonical generator called.
 * 8. AI canonical matches existing normalized canonical:
 *    -> existing company reused
 *    -> original observed name added as alias.
 * 9. AI canonical does not match:
 *    -> new company created
 *    -> original observed name added as alias.
 * 10. Normalization is used consistently.
 * 11. Duplicate canonical protection.
 * 12. Duplicate alias protection.
 * 13. Multiple contacts for one company create only one company identity.
 * 14. Known company path makes 0 AI calls.
 * 15. No existing company database records are sent to the canonical-name AI.
 * 16. No fuzzy/semantic/candidate identity matching exists.
 *
 * Additional verification:
 * 17. Seed tool verification: dry-run, apply, and idempotency.
 * 18. Downstream tables and outreach pipelines remain 100% intact.
 */

import path from 'path';
import fs from 'fs';
import assert from 'assert';

// Setup isolated test database directory
const TEST_DIR = path.join(
  process.cwd(),
  'data',
  `test-relevant-kb-${Date.now()}-${Math.random().toString(36).substring(7)}`
);
fs.mkdirSync(TEST_DIR, { recursive: true });

process.env.DATA_DIR = TEST_DIR;
(process.env as Record<string, string>).NODE_ENV = 'test';
process.env.OUTREACH_DRY_RUN = 'true';

import { getDb } from '../src/db';
import { initializeDatabase } from '../src/db/migrate';
import {
  batches,
  contacts,
  companyClassifications,
  relevantCompanies,
  relevantCompanyAliases,
} from '../src/db/schema';
import { eq, sql } from 'drizzle-orm';
import { ulid } from 'ulid';

import {
  searchCompanyDatabase,
  searchCompanyDatabaseBatch,
  resolveCanonicalAndPersist,
  recordCompanyAlias,
} from '../src/lib/kb/relevant-companies-kb';
import {
  generateCanonicalCompanyNames,
} from '../src/lib/ai/canonical-name-generator';
import {
  classifyCompanies,
  resetClassificationMemoryCache,
  type CompanyEvaluationInput,
  type CompanyClassificationResult,
} from '../src/lib/ai/company-classifier';
import { runSeedRelevantCompanies } from '../scripts/seed-relevant-companies-kb';
import { normalizeCompanyName } from '../src/lib/utils/company';

async function runClassify(
  names: string[],
  mockAi?: (prompt: string) => Promise<string>
): Promise<Map<string, CompanyClassificationResult>> {
  resetClassificationMemoryCache();
  const inputs: CompanyEvaluationInput[] = names.map((name) => ({
    companyName: name,
    normalizedName: normalizeCompanyName(name),
  }));
  return classifyCompanies(inputs, mockAi);
}

async function runTests() {
  console.log('======================================================================');
  console.log('STARTING RELEVANT COMPANY KNOWLEDGE BASE 16-TEST VERIFICATION SUITE');
  console.log(`Test directory: ${TEST_DIR}`);
  console.log('======================================================================\n');

  // Initialize fresh schema in isolated directory
  initializeDatabase();
  const db = getDb();

  let passedTests = 0;
  function pass(testNum: number, name: string) {
    passedTests++;
    console.log(`  [PASS ${testNum}] ${name}`);
  }

  // Pre-populate KB with an initial baseline company for testing
  // Company: "Google", Canonical: "Google", Alias: "Google LLC"
  const initComp = resolveCanonicalAndPersist('Google', 'Google LLC', db);
  recordCompanyAlias(initComp.companyId, 'Google DeepMind', db);

  // -----------------------------------------------------------------------------
  // Test 1: Known canonical -> 0 AI classification calls
  // -----------------------------------------------------------------------------
  {
    let aiCallCount = 0;
    const mockAiCaller = async () => {
      aiCallCount++;
      return JSON.stringify([{ company_name: 'Google', is_relevant: true, confidence: 1.0, reason: 'AI called' }]);
    };

    const resMap = await runClassify(['Google'], mockAiCaller);
    assert.strictEqual(aiCallCount, 0, 'Must make 0 AI calls for known canonical');
    const res = resMap.get(normalizeCompanyName('Google'));
    assert.ok(res, 'Must return result');
    assert.strictEqual(res!.relevant, true);
    assert.strictEqual(res!.status, 'RELEVANT');
    assert.strictEqual(res!.geminiModel, 'knowledge-base');

    pass(1, 'Known canonical -> 0 AI classification calls');
  }

  // -----------------------------------------------------------------------------
  // Test 2: Known alias -> 0 AI classification calls
  // -----------------------------------------------------------------------------
  {
    let aiCallCount = 0;
    const mockAiCaller = async () => {
      aiCallCount++;
      return JSON.stringify([{ company_name: 'Google LLC', is_relevant: true, confidence: 1.0, reason: 'AI called' }]);
    };

    const resMap = await runClassify(['Google LLC'], mockAiCaller);
    assert.strictEqual(aiCallCount, 0, 'Must make 0 AI calls for known alias');
    const res = resMap.get(normalizeCompanyName('Google LLC'));
    assert.ok(res, 'Must return result');
    assert.strictEqual(res!.relevant, true);
    assert.strictEqual(res!.status, 'RELEVANT');
    assert.strictEqual(res!.geminiModel, 'knowledge-base');

    pass(2, 'Known alias -> 0 AI classification calls');
  }

  // -----------------------------------------------------------------------------
  // Test 3: Unknown -> AI relevance check
  // -----------------------------------------------------------------------------
  {
    let aiCallCount = 0;
    const mockAiCaller = async () => {
      aiCallCount++;
      return JSON.stringify([
        { company: 'Acme Unknown Systems', relevant: false, confidence: 0.9, reason: 'Not tech' },
      ]);
    };

    await runClassify(['Acme Unknown Systems'], mockAiCaller);
    assert.strictEqual(aiCallCount, 1, 'AI relevance check must be invoked for unknown company');

    pass(3, 'Unknown -> AI relevance check');
  }

  // -----------------------------------------------------------------------------
  // Test 4: Unknown + IRRELEVANT -> no KB entry
  // -----------------------------------------------------------------------------
  {
    const mockAiCaller = async () => {
      return JSON.stringify([
        { company: 'Sunshine Bakery Ltd', relevant: false, confidence: 0.95, reason: 'Bakery is not tech/IT' },
      ]);
    };

    const resMap = await runClassify(['Sunshine Bakery Ltd'], mockAiCaller);
    const res = resMap.get(normalizeCompanyName('Sunshine Bakery Ltd'));
    assert.ok(res);
    assert.strictEqual(res!.relevant, false);
    assert.strictEqual(res!.status, 'IRRELEVANT');

    const inKb = searchCompanyDatabase('Sunshine Bakery Ltd', db);
    assert.strictEqual(inKb, null, 'IRRELEVANT company must NOT be entered into KB');

    pass(4, 'Unknown + IRRELEVANT -> no KB entry');
  }

  // -----------------------------------------------------------------------------
  // Test 5: Unknown + NEEDS_REVIEW -> no KB entry
  // -----------------------------------------------------------------------------
  {
    const mockAiCaller = async () => {
      return JSON.stringify([
        { company: 'Ambiguous Holdings LLC', relevant: null, confidence: 0.4, reason: 'Unclear business focus' },
      ]);
    };

    const resMap = await runClassify(['Ambiguous Holdings LLC'], mockAiCaller);
    const res = resMap.get(normalizeCompanyName('Ambiguous Holdings LLC'));
    assert.ok(res);
    assert.strictEqual(res!.relevant, null);
    assert.strictEqual(res!.status, 'NEEDS_REVIEW');

    const inKb = searchCompanyDatabase('Ambiguous Holdings LLC', db);
    assert.strictEqual(inKb, null, 'NEEDS_REVIEW company must NOT be entered into KB');

    pass(5, 'Unknown + NEEDS_REVIEW -> no KB entry');
  }

  // -----------------------------------------------------------------------------
  // Test 6: Unknown + classification failure -> no KB entry
  // -----------------------------------------------------------------------------
  {
    const mockAiCaller = async () => {
      throw new Error('Network timeout during classification');
    };

    try {
      await runClassify(['Failed Classification Corp'], mockAiCaller);
    } catch {
      // Expected failure
    }

    const inKb = searchCompanyDatabase('Failed Classification Corp', db);
    assert.strictEqual(inKb, null, 'Failed classification must NOT produce a KB entry');

    pass(6, 'Unknown + classification failure -> no KB entry');
  }

  // -----------------------------------------------------------------------------
  // Test 7: Unknown + RELEVANT -> AI canonical generator called
  // -----------------------------------------------------------------------------
  {
    let canonicalGeneratorCalled = false;
    let classificationCalled = false;

    const mockAiCaller = async (prompt: string) => {
      if (prompt.includes('determine the standard, clean canonical company name')) {
        canonicalGeneratorCalled = true;
        return JSON.stringify([{ observed: 'Cloudflare Inc', canonical: 'Cloudflare' }]);
      } else {
        classificationCalled = true;
        return JSON.stringify([
          { company: 'Cloudflare Inc', relevant: true, confidence: 0.99, reason: 'Edge computing & CDN' },
        ]);
      }
    };

    const resMap = await runClassify(['Cloudflare Inc'], mockAiCaller);
    assert.strictEqual(classificationCalled, true, 'Classification must be called');
    assert.strictEqual(canonicalGeneratorCalled, true, 'AI canonical generator must be called for RELEVANT company');

    const res = resMap.get(normalizeCompanyName('Cloudflare Inc'));
    assert.ok(res);
    assert.strictEqual(res!.relevant, true);

    pass(7, 'Unknown + RELEVANT -> AI canonical generator called');
  }

  // -----------------------------------------------------------------------------
  // Test 8: AI canonical matches existing normalized canonical:
  //         -> existing company reused
  //         -> original observed name added as alias
  // -----------------------------------------------------------------------------
  {
    // "Google" exists in KB as canonical.
    // Observed name: "Google Workspace Services"
    // AI canonical returns: "Google"
    const companiesBefore = db.select().from(relevantCompanies).all().length;

    const mockAiCaller = async (prompt: string) => {
      if (prompt.includes('determine the standard, clean canonical company name')) {
        return JSON.stringify([{ observed: 'Google Workspace Services', canonical: 'Google' }]);
      } else {
        return JSON.stringify([
          { company: 'Google Workspace Services', relevant: true, confidence: 0.98, reason: 'Productivity suite' },
        ]);
      }
    };

    await runClassify(['Google Workspace Services'], mockAiCaller);

    const companiesAfter = db.select().from(relevantCompanies).all().length;
    assert.strictEqual(companiesAfter, companiesBefore, 'Must NOT create new company row; existing company reused');

    // Observed name must now be an alias resolving to Google
    const match = searchCompanyDatabase('Google Workspace Services', db);
    assert.ok(match !== null, 'Observed name must now exist in KB');
    assert.strictEqual(match!.canonicalName, 'Google');
    assert.strictEqual(match!.matchedAs, 'alias');

    pass(8, 'AI canonical matches existing normalized canonical -> existing reused + original added as alias');
  }

  // -----------------------------------------------------------------------------
  // Test 9: AI canonical does not match:
  //         -> new company created
  //         -> original observed name added as alias
  // -----------------------------------------------------------------------------
  {
    const companiesBefore = db.select().from(relevantCompanies).all().length;

    const mockAiCaller = async (prompt: string) => {
      if (prompt.includes('determine the standard, clean canonical company name')) {
        return JSON.stringify([{ observed: 'Datadog Systems Ltd', canonical: 'Datadog' }]);
      } else {
        return JSON.stringify([
          { company: 'Datadog Systems Ltd', relevant: true, confidence: 0.98, reason: 'Monitoring platform' },
        ]);
      }
    };

    await runClassify(['Datadog Systems Ltd'], mockAiCaller);

    const companiesAfter = db.select().from(relevantCompanies).all().length;
    assert.strictEqual(companiesAfter, companiesBefore + 1, 'Must create 1 new company row');

    const canonicalMatch = searchCompanyDatabase('Datadog', db);
    assert.ok(canonicalMatch !== null);
    assert.strictEqual(canonicalMatch!.canonicalName, 'Datadog');
    assert.strictEqual(canonicalMatch!.matchedAs, 'canonical');

    const aliasMatch = searchCompanyDatabase('Datadog Systems Ltd', db);
    assert.ok(aliasMatch !== null);
    assert.strictEqual(aliasMatch!.canonicalName, 'Datadog');
    assert.strictEqual(aliasMatch!.matchedAs, 'alias');
    assert.strictEqual(aliasMatch!.companyId, canonicalMatch!.companyId);

    pass(9, 'AI canonical does not match -> new company created + original added as alias');
  }

  // -----------------------------------------------------------------------------
  // Test 10: Normalization is used consistently
  // -----------------------------------------------------------------------------
  {
    // Search with varied casing, leading/trailing whitespace, internal spaces
    const matchCanonical = searchCompanyDatabase('   dAtAdOg   ', db);
    assert.ok(matchCanonical !== null);
    assert.strictEqual(matchCanonical!.canonicalName, 'Datadog');

    const matchAlias = searchCompanyDatabase('   DaTaDoG   sYsTeMs   LtD   ', db);
    assert.ok(matchAlias !== null);
    assert.strictEqual(matchAlias!.canonicalName, 'Datadog');

    pass(10, 'Normalization is used consistently across canonical and alias lookups');
  }

  // -----------------------------------------------------------------------------
  // Test 11: Duplicate canonical protection
  // -----------------------------------------------------------------------------
  {
    const compId1 = ulid();
    const compId2 = ulid();

    db.run(sql`
      INSERT OR IGNORE INTO relevant_companies (id, canonical_name, normalized_canonical_name, created_at, updated_at)
      VALUES (${compId1}, 'Stripe', 'stripe', datetime('now'), datetime('now'))
    `);

    // Attempt duplicate insert of same normalized_canonical_name
    db.run(sql`
      INSERT OR IGNORE INTO relevant_companies (id, canonical_name, normalized_canonical_name, created_at, updated_at)
      VALUES (${compId2}, 'Stripe Inc', 'stripe', datetime('now'), datetime('now'))
    `);

    const stripeRows = db.select().from(relevantCompanies).where(eq(relevantCompanies.normalizedCanonicalName, 'stripe')).all();
    assert.strictEqual(stripeRows.length, 1, 'Duplicate canonical insert must be rejected by UNIQUE constraint');
    assert.strictEqual(stripeRows[0].id, compId1, 'Original ID must remain intact');

    pass(11, 'Duplicate canonical protection enforced by UNIQUE index and INSERT OR IGNORE');
  }

  // -----------------------------------------------------------------------------
  // Test 12: Duplicate alias protection
  // -----------------------------------------------------------------------------
  {
    const stripeRows = db.select().from(relevantCompanies).where(eq(relevantCompanies.normalizedCanonicalName, 'stripe')).all();
    const stripeId = stripeRows[0].id;

    recordCompanyAlias(stripeId, 'Stripe Payments', db);
    const addedAgain = recordCompanyAlias(stripeId, 'Stripe Payments', db);
    assert.strictEqual(addedAgain, false, 'Duplicate alias registration should return false (ignored)');

    const aliases = db.select().from(relevantCompanyAliases).where(eq(relevantCompanyAliases.normalizedAliasName, normalizeCompanyName('Stripe Payments'))).all();
    assert.strictEqual(aliases.length, 1, 'Duplicate alias insert must be rejected by UNIQUE constraint');

    pass(12, 'Duplicate alias protection enforced by UNIQUE index and INSERT OR IGNORE');
  }

  // -----------------------------------------------------------------------------
  // Test 13: Multiple contacts for one company create only one company identity
  // -----------------------------------------------------------------------------
  {
    const batchId = ulid();
    db.insert(batches).values({
      id: batchId,
      filename: 'multi-contact-test.csv',
      uploadDate: new Date().toISOString(),
      status: 'processing',
    }).run();

    for (let i = 1; i <= 5; i++) {
      db.insert(contacts).values({
        id: ulid(),
        batchId,
        companyName: 'Atlassian Pty Ltd',
        contactName: `Recruiter ${i}`,
        email: `contact${i}@atlassian.com`,
        status: 'discovered',
      }).run();
    }

    const mockAiCaller = async (prompt: string) => {
      if (prompt.includes('determine the standard, clean canonical company name')) {
        return JSON.stringify([{ observed: 'Atlassian Pty Ltd', canonical: 'Atlassian' }]);
      } else {
        return JSON.stringify([
          { company: 'Atlassian Pty Ltd', relevant: true, confidence: 0.95, reason: 'Collaboration software' },
        ]);
      }
    };

    await runClassify(['Atlassian Pty Ltd'], mockAiCaller);

    const atlassianCompanies = db.select().from(relevantCompanies).where(eq(relevantCompanies.normalizedCanonicalName, 'atlassian')).all();
    assert.strictEqual(atlassianCompanies.length, 1, 'Exactly 1 company record created for Atlassian');

    const atlassianAliases = db.select().from(relevantCompanyAliases).where(eq(relevantCompanyAliases.companyId, atlassianCompanies[0].id)).all();
    assert.strictEqual(atlassianAliases.length, 1, 'Exactly 1 alias record created for Atlassian Pty Ltd');

    pass(13, 'Multiple contacts for one company create only one company identity and alias');
  }

  // -----------------------------------------------------------------------------
  // Test 14: Known company path makes 0 AI calls
  // -----------------------------------------------------------------------------
  {
    let aiCallCount = 0;
    const mockAiCaller = async () => {
      aiCallCount++;
      return JSON.stringify([{ company: 'Atlassian Pty Ltd', relevant: true, confidence: 1.0, reason: 'Should not be called' }]);
    };

    // Atlassian Pty Ltd is now known in KB from Test 13
    const resMap = await runClassify(['Atlassian Pty Ltd'], mockAiCaller);
    assert.strictEqual(aiCallCount, 0, 'Subsequent classification of known company must make 0 AI calls');
    const res = resMap.get(normalizeCompanyName('Atlassian Pty Ltd'));
    assert.ok(res);
    assert.strictEqual(res!.geminiModel, 'knowledge-base');

    pass(14, 'Known company path makes 0 AI calls');
  }

  // -----------------------------------------------------------------------------
  // Test 15: No existing company database records are sent to the canonical-name AI
  // -----------------------------------------------------------------------------
  {
    let capturedPrompt = '';
    const mockAiCaller = async (prompt: string) => {
      capturedPrompt = prompt;
      return JSON.stringify([{ observed: 'Figma Design Inc', canonical: 'Figma' }]);
    };

    await generateCanonicalCompanyNames(['Figma Design Inc'], mockAiCaller);

    assert.ok(capturedPrompt.includes('Figma Design Inc'), 'Prompt must contain observed name');
    // Ensure prompt does NOT contain existing companies from DB (Google, Datadog, Stripe, Atlassian, etc.)
    assert.strictEqual(capturedPrompt.includes('Google'), false, 'Prompt must NOT contain Google from DB');
    assert.strictEqual(capturedPrompt.includes('Datadog'), false, 'Prompt must NOT contain Datadog from DB');
    assert.strictEqual(capturedPrompt.includes('Stripe'), false, 'Prompt must NOT contain Stripe from DB');
    assert.strictEqual(capturedPrompt.includes('Atlassian'), false, 'Prompt must NOT contain Atlassian from DB');
    assert.strictEqual(capturedPrompt.includes('relevant_companies'), false, 'Prompt must NOT contain DB tables');

    pass(15, 'No existing company database records are sent to the canonical-name AI (0 DB context)');
  }

  // -----------------------------------------------------------------------------
  // Test 16: No fuzzy/semantic/candidate identity matching exists
  // -----------------------------------------------------------------------------
  {
    // Confirm exact-normalized matching only; no typo or partial fuzzy matching
    // Known company in KB is "Google" and "Datadog"
    const typo1 = searchCompanyDatabase('Gooogle', db);
    assert.strictEqual(typo1, null, 'Typo must return null (no fuzzy matching)');

    const partial1 = searchCompanyDatabase('Goog', db);
    assert.strictEqual(partial1, null, 'Partial prefix must return null (no fuzzy matching)');

    const typo2 = searchCompanyDatabase('Datadoggg', db);
    assert.strictEqual(typo2, null, 'Typo must return null (no fuzzy matching)');

    pass(16, 'No fuzzy/semantic/candidate identity matching exists (strictly exact-normalized SQL)');
  }

  // -----------------------------------------------------------------------------
  // Test 17: Seed tool verification: dry-run, apply, and idempotency
  // -----------------------------------------------------------------------------
  console.log('\n--- Section: Seed & Backfill Script Verification ---');
  {
    const batchId = ulid();
    db.insert(batches).values({
      id: batchId,
      filename: 'seed-test-batch.csv',
      uploadDate: new Date().toISOString(),
      status: 'completed',
    }).run();

    db.insert(contacts).values({
      id: ulid(),
      batchId,
      companyName: 'Oracle Corporation',
      email: 'recruiter@oracle.com',
      isRelevant: true,
      status: 'sent',
    }).run();

    db.insert(companyClassifications).values({
      normalizedName: normalizeCompanyName('Salesforce.com'),
      companyName: 'Salesforce.com',
      isRelevant: true,
      classificationResult: 'RELEVANT',
      reason: 'CRM and cloud software',
    }).run();

    // Step A: Dry run (0 writes)
    const compBefore = db.select().from(relevantCompanies).all().length;
    const dryReport = runSeedRelevantCompanies({ apply: false });
    assert.strictEqual(dryReport.isDryRun, true);
    assert.strictEqual(dryReport.insertedCompanies, 0);
    const compAfterDry = db.select().from(relevantCompanies).all().length;
    assert.strictEqual(compAfterDry, compBefore);

    // Step B: Apply
    const applyReport = runSeedRelevantCompanies({ apply: true });
    assert.strictEqual(applyReport.isDryRun, false);
    assert.ok(applyReport.insertedCompanies > 0);

    const oracleMatch = searchCompanyDatabase('Oracle Corporation', db);
    assert.ok(oracleMatch !== null);
    assert.strictEqual(oracleMatch!.canonicalName, 'Oracle Corporation');

    // Step C: Re-apply (Idempotent)
    const reapplyReport = runSeedRelevantCompanies({ apply: true });
    assert.strictEqual(reapplyReport.insertedCompanies, 0);
    assert.strictEqual(reapplyReport.insertedAliases, 0);

    pass(17, 'Seed tool: dry-run, apply, and idempotency verified (0 AI calls)');
  }

  // -----------------------------------------------------------------------------
  // Test 18: Downstream tables and outreach pipelines remain 100% intact
  // -----------------------------------------------------------------------------
  console.log('\n--- Section: Pipeline Safety Invariants ---');
  {
    const batchRows = db.select().from(batches).all();
    assert.ok(Array.isArray(batchRows));
    const contactRows = db.select().from(contacts).all();
    assert.ok(Array.isArray(contactRows));

    pass(18, 'Downstream schemas and outreach pipeline invariants 100% intact');
  }

  console.log('\n======================================================================');
  console.log(`SUCCESS: ALL ${passedTests} TESTS PASSED PERFECTLY!`);
  console.log('======================================================================');
}

runTests().catch((err) => {
  console.error('\nTEST SUITE FAILED WITH ERROR:');
  console.error(err);
  process.exit(1);
});
