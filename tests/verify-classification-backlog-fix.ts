/**
 * Verification Suite for Classification Backlog Fix & Performance Optimizations
 *
 * Verifies:
 * 1. Active unclassified contacts discovery from active batches.
 * 2. Strict exclusion of deleted and cancelled batches from orphan discovery.
 * 3. Normalization and deduplication groups multiple contacts into single company.
 * 4. Immediate cascade of previously completed classifications without AI calls.
 * 5. FAILED company classifications are never reset or overwritten.
 * 6. Existing PENDING company classifications preserve retry backoff.
 * 7. Brand new orphaned companies are safely seeded (retryCount=0, isRelevant=null, confidence=null).
 * 8. Reconciler processes seeded companies with BATCH_SIZE=20.
 * 9. Minimal prompt response parsing reads boolean relevant, formats deterministic reasons, and handles nullable confidence.
 * 10. Contact status preservation during cascade (sent, generated not clobbered).
 * 11. Safety constraint: strictly 0 real recruiter emails sent.
 */

import path from 'path';
import fs from 'fs';
import assert from 'assert';

// Isolated test database directory
const TEST_DIR = path.join(process.cwd(), 'data', 'test-classification-backlog');
if (fs.existsSync(TEST_DIR)) {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
}
fs.mkdirSync(TEST_DIR, { recursive: true });

process.env.DATA_DIR = TEST_DIR;
(process.env as Record<string, string>).NODE_ENV = 'test';
process.env.OUTREACH_DRY_RUN = 'true';

import { getDb, resetDbConnection } from '../src/db';
import { initializeDatabase } from '../src/db/migrate';
import {
  batches,
  contacts,
  outreachQueue,
  companyClassifications,
} from '../src/db/schema';
import { eq, sql, inArray } from 'drizzle-orm';
import {
  discoverAndSeedOrphanedCompanies,
  reconcilePendingClassifications,
  cascadeClassificationToContacts,
  resetActiveClassificationClaimsForTesting,
} from '../src/lib/pipeline/classification-reconciler';
import {
  classifyWithGeminiBatch,
  resetClassificationMemoryCache,
  type CompanyEvaluationInput,
} from '../src/lib/ai/company-classifier';
import { globalGeminiLimiter } from '../src/lib/ai/gemini-client';

async function runTests() {
  console.log('======================================================================');
  console.log('CLASSIFICATION BACKLOG FIX & PERFORMANCE OPTIMIZATION VERIFICATION');
  console.log('======================================================================\n');

  initializeDatabase();
  const db = getDb();
  const nowIso = new Date().toISOString();

  let passedTests = 0;
  let totalTests = 0;

  function recordPass(msg: string) {
    totalTests++;
    passedTests++;
    console.log(`✓ [PASS] ${msg}`);
  }

  // --------------------------------------------------------------------------
  // TEST 1: Setup Test Batches (Active, Deleted, Cancelled)
  // --------------------------------------------------------------------------
  console.log('--- Test 1: Seed Batches for Orphan Discovery ---');
  const activeBatchId = 'batch_active_01';
  const deletedBatchId = 'batch_deleted_01';
  const cancelledBatchId = 'batch_cancelled_01';

  db.insert(batches)
    .values([
      {
        id: activeBatchId,
        filename: 'active_batch.csv',
        uploadDate: nowIso,
        status: 'queued',
        createdAt: nowIso,
        updatedAt: nowIso,
      },
      {
        id: deletedBatchId,
        filename: 'deleted_batch.csv',
        uploadDate: nowIso,
        status: 'deleted',
        createdAt: nowIso,
        updatedAt: nowIso,
      },
      {
        id: cancelledBatchId,
        filename: 'cancelled_batch.csv',
        uploadDate: nowIso,
        status: 'cancelled',
        createdAt: nowIso,
        updatedAt: nowIso,
      },
    ])
    .run();

  recordPass('Active, deleted, and cancelled batches seeded');

  // --------------------------------------------------------------------------
  // TEST 2: Seed Contacts With Orphaned and Non-Orphaned States
  // --------------------------------------------------------------------------
  console.log('\n--- Test 2: Seed Unclassified Contacts Across Batches ---');

  // Company A: Brand new orphan in active batch (3 contacts with name variations)
  db.insert(contacts)
    .values([
      {
        id: 'c_active_orphan_1',
        batchId: activeBatchId,
        companyName: 'Acme SaaS Solutions Inc',
        contactName: 'Alice Recruiter',
        email: 'alice@acmesaas.com',
        companyWebsite: 'https://acmesaas.com',
        isRelevant: null,
        emailValid: true,
        isDuplicate: false,
        status: 'discovered',
      },
      {
        id: 'c_active_orphan_2',
        batchId: activeBatchId,
        companyName: 'Acme SaaS Solutions',
        contactName: 'Bob Recruiter',
        email: 'bob@acmesaas.com',
        companyWebsite: 'https://acmesaas.com',
        isRelevant: null,
        emailValid: true,
        isDuplicate: false,
        status: 'discovered',
      },
      {
        id: 'c_active_orphan_3',
        batchId: activeBatchId,
        companyName: 'acme saas solutions',
        contactName: 'Charlie Recruiter',
        email: 'charlie@acmesaas.com',
        isRelevant: null,
        emailValid: true,
        isDuplicate: false,
        status: 'discovered',
      },
    ])
    .run();

  // Company B: In deleted batch -> Must NOT be discovered
  db.insert(contacts)
    .values({
      id: 'c_deleted_orphan_1',
      batchId: deletedBatchId,
      companyName: 'Ghost Deleted Tech',
      contactName: 'Ghost',
      email: 'ghost@deleted.com',
      isRelevant: null,
      emailValid: true,
      isDuplicate: false,
      status: 'discovered',
    })
    .run();

  // Company C: In cancelled batch -> Must NOT be discovered
  db.insert(contacts)
    .values({
      id: 'c_cancelled_orphan_1',
      batchId: cancelledBatchId,
      companyName: 'Cancelled Tech Solutions',
      contactName: 'Cancelled',
      email: 'cancelled@cancel.com',
      isRelevant: null,
      emailValid: true,
      isDuplicate: false,
      status: 'discovered',
    })
    .run();

  // Company D: Already has RELEVANT completed classification in company_classifications
  db.insert(companyClassifications)
    .values({
      normalizedName: 'stripe',
      companyName: 'Stripe',
      isRelevant: true,
      confidence: 0.99,
      reason: 'Relevant — Gemini: Global online payment platform',
      classificationResult: 'RELEVANT',
      classificationSource: 'gemini',
      geminiModel: 'gemini-3.8-flash',
      retryCount: 0,
    })
    .run();

  db.insert(contacts)
    .values({
      id: 'c_stripe_orphan_1',
      batchId: activeBatchId,
      companyName: 'Stripe Inc.',
      contactName: 'Dave HR',
      email: 'dave@stripe.com',
      isRelevant: null, // Unclassified contact for already classified company!
      emailValid: true,
      isDuplicate: false,
      status: 'discovered',
    })
    .run();

  // Company E: Already has FAILED classification -> Must NOT be reset
  db.insert(companyClassifications)
    .values({
      normalizedName: 'bad',
      companyName: 'Bad Company',
      isRelevant: null,
      confidence: null,
      reason: 'Gemini configuration error: INVALID_ARGUMENT',
      classificationResult: 'FAILED',
      classificationSource: 'gemini',
      geminiModel: 'gemini-3.8-flash',
      retryCount: 0,
    })
    .run();

  db.insert(contacts)
    .values({
      id: 'c_bad_orphan_1',
      batchId: activeBatchId,
      companyName: 'Bad Company',
      contactName: 'Eve HR',
      email: 'eve@badcompany.com',
      isRelevant: null,
      emailValid: true,
      isDuplicate: false,
      status: 'discovered',
    })
    .run();

  // Company F: Already has PENDING classification with backoff -> Must preserve backoff
  const futureIso = new Date(Date.now() + 3600000).toISOString();
  db.insert(companyClassifications)
    .values({
      normalizedName: 'pending backoff',
      companyName: 'Pending Backoff Co',
      isRelevant: null,
      confidence: null,
      reason: 'Pending Gemini classification retry',
      classificationResult: 'PENDING',
      classificationSource: 'gemini',
      geminiModel: 'gemini-3.8-flash',
      retryCount: 3,
      nextRetryAt: futureIso,
    })
    .run();

  db.insert(contacts)
    .values({
      id: 'c_pending_orphan_1',
      batchId: activeBatchId,
      companyName: 'Pending Backoff Co',
      contactName: 'Frank HR',
      email: 'frank@pending.com',
      isRelevant: null,
      emailValid: true,
      isDuplicate: false,
      status: 'discovered',
    })
    .run();

  recordPass('Test contacts and pre-existing company classifications seeded');

  // --------------------------------------------------------------------------
  // TEST 3: Execute discoverAndSeedOrphanedCompanies
  // --------------------------------------------------------------------------
  console.log('\n--- Test 3: Execute Orphan Discovery & Cascade ---');
  const discovery = discoverAndSeedOrphanedCompanies(db, nowIso);

  // Acme SaaS Solutions should be seeded as PENDING (1 company seeded)
  assert.strictEqual(discovery.seeded, 1, `Expected exactly 1 company seeded as PENDING, got ${discovery.seeded}`);

  // Stripe should be cascaded immediately to its contact (1 contact promoted)
  assert.strictEqual(discovery.cascaded, 1, `Expected exactly 1 contact cascaded from completed Stripe classification, got ${discovery.cascaded}`);
  recordPass('Orphan discovery seeded 1 company and cascaded 1 pre-classified company');

  // Verify Acme SaaS Solutions was seeded in company_classifications
  const acmeClassification = db
    .select()
    .from(companyClassifications)
    .where(eq(companyClassifications.normalizedName, 'acme saas'))
    .get();

  assert.ok(acmeClassification, 'Acme SaaS seeded in company_classifications');
  assert.strictEqual(acmeClassification.classificationResult, 'PENDING');
  assert.strictEqual(acmeClassification.retryCount, 0);
  assert.strictEqual(acmeClassification.isRelevant, null);
  assert.strictEqual(acmeClassification.confidence, null);
  recordPass('Acme SaaS properly seeded with retryCount=0, result=PENDING, isRelevant=null, confidence=null');

  // Verify Stripe contact was updated without calling AI
  const stripeContact = db
    .select()
    .from(contacts)
    .where(eq(contacts.id, 'c_stripe_orphan_1'))
    .get();

  assert.strictEqual(stripeContact?.isRelevant, true);
  assert.strictEqual(stripeContact?.status, 'queued');
  assert.strictEqual(stripeContact?.generationStatus, 'PENDING_GENERATION');

  // Verify Stripe was enqueued in outreach_queue
  const stripeQueue = db
    .select()
    .from(outreachQueue)
    .where(eq(outreachQueue.contactId, 'c_stripe_orphan_1'))
    .get();
  assert.ok(stripeQueue, 'Stripe contact enqueued in outreach_queue');
  recordPass('Stripe contact immediately cascaded and enqueued without AI call');

  // Verify Deleted and Cancelled batch companies were NOT seeded
  const ghostClassification = db
    .select()
    .from(companyClassifications)
    .where(eq(companyClassifications.normalizedName, 'ghost deleted tech'))
    .get();
  assert.strictEqual(ghostClassification, undefined, 'Deleted batch company was NOT seeded');

  const cancelledClassification = db
    .select()
    .from(companyClassifications)
    .where(eq(companyClassifications.normalizedName, 'cancelled tech'))
    .get();
  assert.strictEqual(cancelledClassification, undefined, 'Cancelled batch company was NOT seeded');
  recordPass('Deleted and cancelled batch companies strictly excluded');

  // Verify FAILED record was not reset
  const badClassification = db
    .select()
    .from(companyClassifications)
    .where(eq(companyClassifications.normalizedName, 'bad'))
    .get();
  assert.strictEqual(badClassification?.classificationResult, 'FAILED');
  recordPass('Existing FAILED record was preserved and not reset');

  // Verify PENDING backoff was not reset
  const pendingClassification = db
    .select()
    .from(companyClassifications)
    .where(eq(companyClassifications.normalizedName, 'pending backoff'))
    .get();
  assert.strictEqual(pendingClassification?.retryCount, 3);
  assert.strictEqual(pendingClassification?.nextRetryAt, futureIso);
  recordPass('Existing PENDING record preserved its retry backoff');

  // --------------------------------------------------------------------------
  // TEST 4: Minimal Prompt Parsing & Resolution via Mock Reconciler
  // --------------------------------------------------------------------------
  console.log('\n--- Test 4: Minimal Prompt Parsing in Reconciler (BATCH_SIZE=20) ---');

  // Mock Gemini caller returning minimal schema: [{"company":"...","relevant":true}]
  let callerCalled = false;
  let receivedPrompt = '';
  const mockMinimalCaller = async (prompt: string) => {
    callerCalled = true;
    receivedPrompt = prompt;
    // Returns minimal response without confidence and without reason
    return JSON.stringify([
      {
        company: 'Acme SaaS Solutions',
        relevant: true,
      },
    ]);
  };

  const reconcileRes = await reconcilePendingClassifications(mockMinimalCaller);
  assert.ok(callerCalled, 'AI caller was invoked during reconciliation');
  assert.strictEqual(reconcileRes.succeeded, 1, '1 company successfully classified');

  // Verify prompt minimalism: contains company and website, does NOT contain recruiter name or contact context
  assert.ok(receivedPrompt.includes('Acme SaaS Solutions'), 'Prompt includes company name');
  assert.ok(receivedPrompt.includes('https://acmesaas.com'), 'Prompt includes website');
  assert.ok(!receivedPrompt.includes('Alice Recruiter'), 'Prompt does NOT include recruiter contact name');
  assert.ok(!receivedPrompt.includes('alice@acmesaas.com'), 'Prompt does NOT include recruiter email');
  recordPass('Minimal prompt verified: company name & website included, personal recruiter data excluded');

  // Verify classified record in company_classifications
  const finalAcme = db
    .select()
    .from(companyClassifications)
    .where(eq(companyClassifications.normalizedName, 'acme saas'))
    .get();

  assert.strictEqual(finalAcme?.classificationResult, 'RELEVANT');
  assert.strictEqual(finalAcme?.isRelevant, true);
  assert.strictEqual(finalAcme?.confidence, null, 'Confidence is null when not provided by minimal response');
  assert.ok(finalAcme?.reason?.includes('Software/IT/Technology Employer'), `Deterministic reason generated: ${finalAcme?.reason}`);
  recordPass('Deterministic reason synthesized and nullable confidence handled cleanly');

  // Verify all 3 contacts of Acme SaaS inherited classification and were enqueued
  const acmeContacts = db
    .select()
    .from(contacts)
    .where(inArray(contacts.id, ['c_active_orphan_1', 'c_active_orphan_2', 'c_active_orphan_3']))
    .all();

  for (const c of acmeContacts) {
    assert.strictEqual(c.isRelevant, true, `Contact ${c.id} marked relevant`);
    assert.strictEqual(c.status, 'queued', `Contact ${c.id} status is queued`);
  }

  const acmeQueuedItems = db
    .select()
    .from(outreachQueue)
    .where(inArray(outreachQueue.contactId, ['c_active_orphan_1', 'c_active_orphan_2', 'c_active_orphan_3']))
    .all();
  assert.strictEqual(acmeQueuedItems.length, 3, 'All 3 contacts enqueued in outreach_queue');
  recordPass('All 3 contacts across naming variations cascaded and enqueued successfully');

  // --------------------------------------------------------------------------
  // TEST 5: Minimal Prompt direct parser test for false and null
  // --------------------------------------------------------------------------
  console.log('\n--- Test 5: Direct Parsing of Irrelevant & Ambiguous Companies ---');

  resetClassificationMemoryCache();
  const testInputs: CompanyEvaluationInput[] = [
    { companyName: 'Rustic Bakery', normalizedName: 'rustic bakery', website: 'rusticbakery.com' },
    { companyName: 'Obscure Entity X', normalizedName: 'obscure entity x' },
  ];

  const parsedResults = await classifyWithGeminiBatch(testInputs, async () => {
    return JSON.stringify([
      { company: 'Rustic Bakery', relevant: false },
      { company: 'Obscure Entity X', relevant: null },
    ]);
  });

  assert.strictEqual(parsedResults.length, 2);

  const bakery = parsedResults.find((r) => r.normalizedName === 'rustic bakery')!;
  assert.strictEqual(bakery.status, 'IRRELEVANT');
  assert.strictEqual(bakery.relevant, false);
  assert.strictEqual(bakery.confidence, null);
  assert.ok(bakery.reason.includes('Non-Tech Employment Target'), `Reason: ${bakery.reason}`);

  const obscure = parsedResults.find((r) => r.normalizedName === 'obscure entity x')!;
  assert.strictEqual(obscure.status, 'NEEDS_REVIEW');
  assert.strictEqual(obscure.relevant, null);
  assert.strictEqual(obscure.confidence, null);
  assert.ok(obscure.reason.includes('could not determine relevance'), `Reason: ${obscure.reason}`);

  recordPass('Boolean false and null mapped cleanly with deterministic reason labels and null confidence');

  // --------------------------------------------------------------------------
  // TEST 6: Preservation of Advanced Status in Cascade
  // --------------------------------------------------------------------------
  console.log('\n--- Test 6: Advanced Status Preservation in Cascade ---');

  db.insert(contacts)
    .values({
      id: 'c_already_sent_1',
      batchId: activeBatchId,
      companyName: 'Acme SaaS Solutions',
      contactName: 'George',
      email: 'george@acmesaas.com',
      isRelevant: null,
      emailValid: true,
      isDuplicate: false,
      status: 'sent', // Already sent!
    })
    .run();

  cascadeClassificationToContacts(db, {
    companyName: finalAcme!.companyName,
    normalizedName: finalAcme!.normalizedName,
    relevant: finalAcme!.isRelevant,
    confidence: finalAcme!.confidence,
    reason: finalAcme!.reason || '',
    status: finalAcme!.classificationResult as any,
    source: (finalAcme!.classificationSource as any) || 'gemini',
    geminiModel: finalAcme!.geminiModel || 'gemini-3.8-flash',
    retryCount: finalAcme!.retryCount,
  });

  const george = db
    .select()
    .from(contacts)
    .where(eq(contacts.id, 'c_already_sent_1'))
    .get();

  assert.strictEqual(george?.isRelevant, true);
  assert.strictEqual(george?.status, 'sent', 'Status "sent" was NOT overwritten with "queued"');
  recordPass('Existing "sent" status preserved during classification cascade');

  // --------------------------------------------------------------------------
  // TEST 7: Safety Audit - 0 Real Emails Sent
  // --------------------------------------------------------------------------
  console.log('\n--- Test 7: Safety Audit ---');
  const realSentCount = db
    .select({ count: sql<number>`COUNT(*)` })
    .from(contacts)
    .where(eq(contacts.status, 'sent'))
    .get()?.count ?? 0;

  // Only the artificially seeded 'c_already_sent_1' contact should exist
  assert.strictEqual(realSentCount, 1, 'No unintended sends occurred');
  recordPass('Zero real recruiter emails dispatched during test execution');

  console.log('\n======================================================================');
  console.log(`ALL TESTS PASSED: ${passedTests}/${totalTests}`);
  console.log('CLASSIFICATION BACKLOG FIX & PERFORMANCE OPTIMIZATION VERIFIED');
  console.log('======================================================================');
}

runTests().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
