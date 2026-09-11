/**
 * Verification Test Suite for:
 * Decoupled Upload Ingestion & Background AI Company Classification
 *
 * Verifies:
 * 1. Upload ingestion returns without waiting for AI classification.
 * 2. Unknown companies are persisted as PENDING.
 * 3. Classification is incomplete immediately after ingestion (isBatchClassificationComplete = false).
 * 4. Email generation remains blocked while classification is pending.
 * 5. Existing Relevant Company KB companies do not trigger AI classification.
 * 6. Background classification can pick up the PENDING companies.
 * 7. Classification resolves correctly.
 * 8. Relevant companies follow existing canonical-name/KB persistence flow.
 * 9. Contacts are promoted using existing logic.
 * 10. Classification barrier becomes complete (isBatchClassificationComplete = true).
 * 11. Email generation can then proceed.
 * 12. Existing batch isolation remains intact (Batch A pending does not block Batch B completed).
 */

import path from 'path';
import fs from 'fs';
import assert from 'assert';

const TEST_DIR = path.join(process.cwd(), 'data', `test-decoupled-upload-${Date.now()}`);
fs.mkdirSync(TEST_DIR, { recursive: true });

process.env.DATA_DIR = TEST_DIR;
(process.env as Record<string, string>).NODE_ENV = 'test';
process.env.OUTREACH_DRY_RUN = 'true';

import { getDb, resetDbConnection } from '../src/db';
import { initializeDatabase } from '../src/db/migrate';
import { batches, contacts, companyClassifications, outreachQueue, resume } from '../src/db/schema';
import { sql, eq } from 'drizzle-orm';
import { processBatchFile } from '../src/lib/pipeline/batch-processor';
import {
  isBatchClassificationComplete,
  reconcilePendingClassifications,
} from '../src/lib/pipeline/classification-reconciler';
import {
  reconcilePendingEmailGenerations,
} from '../src/lib/pipeline/generation-reconciler';
import { resolveCanonicalAndPersist } from '../src/lib/kb/relevant-companies-kb';
import { saveCandidateProfile } from '../src/lib/candidate-profile/candidate-profile-service';

async function runDecoupledUploadTests() {
  console.log('======================================================================');
  console.log('DECOUPLED UPLOAD INGESTION VERIFICATION SUITE');
  console.log('======================================================================\n');

  resetDbConnection();
  initializeDatabase();
  const db = getDb();

  // Seed candidate profile and resume
  db.insert(resume).values({
    id: 'current',
    filename: 'resume.pdf',
    filePath: '/data/resume.pdf',
    mimeType: 'application/pdf',
    parsedText: 'Alex Engineer - Full Stack Software Developer',
    uploadedAt: new Date().toISOString(),
  }).run();

  saveCandidateProfile({
    fullName: 'Alex Engineer',
    email: 'alex@example.com',
    degree: 'B.Tech',
    fieldOfStudy: 'Computer Science',
    institution: 'Tech Institute',
    skills: {
      programmingLanguages: ['TypeScript', 'JavaScript', 'Python'],
      webDevelopment: ['React', 'Next.js', 'Node.js'],
      databasesOrms: ['PostgreSQL', 'SQLite'],
      aiMl: [],
      coreComputerScience: [],
      toolsApis: [],
    },
  });

  // 1. Seed a known company in Relevant Company Knowledge Base
  // "Stripe Inc" is known in the KB
  resolveCanonicalAndPersist('Stripe', 'Stripe Inc', db);
  console.log('✔ [Setup] Seeded "Stripe Inc" into Relevant Company Knowledge Base.');

  // Create test CSV content with:
  // - Contact 1: Stripe Inc (Known KB Company)
  // - Contact 2: Innovatech Labs (Unknown Company, will be classified as RELEVANT)
  // - Contact 3: Bob Green Bakery (Unknown Company, will be classified as IRRELEVANT)
  const csvContent = [
    'company_name,contact_name,email,designation',
    'Stripe Inc,Sarah Recruiter,sarah@stripe.com,Technical Recruiter',
    'Innovatech Labs,John Tech,john@innovatech.com,Engineering Manager',
    'Bob Green Bakery,Bob Baker,bob@bakery.com,Head Baker',
  ].join('\n');

  const csvBuffer = Buffer.from(csvContent, 'utf-8');

  // =========================================================================
  // TEST 1: Ingestion Returns Rapidly Without AI Calls
  // =========================================================================
  console.log('\n--- TEST 1: Synchronous Ingestion Returns Without Waiting For AI ---');
  const startTime = Date.now();
  const result = await processBatchFile(csvBuffer, 'batch_test_decoupled.csv');
  const durationMs = Date.now() - startTime;

  console.log(`Ingestion completed in ${durationMs}ms`);
  assert.ok(durationMs < 3000, `Expected ingestion in < 3000ms, took ${durationMs}ms`);
  assert.strictEqual(result.totalRecords, 3, 'Expected 3 total records');
  assert.strictEqual(result.validRecords, 3, 'Expected 3 valid records');
  assert.strictEqual(result.status, 'processing', 'Expected batch status to be "processing"');
  // Only the KB match (Stripe) is relevant initially
  assert.strictEqual(result.relevantCompanies, 1, 'Expected 1 relevant company initially (KB match)');
  console.log('✔ TEST 1 PASSED: Synchronous ingestion finished rapidly with status "processing".');

  const batchId = result.batchId;

  // =========================================================================
  // TEST 2: Unknown Companies Persisted as PENDING in company_classifications
  // =========================================================================
  console.log('\n--- TEST 2: Unknown Companies Persisted as PENDING ---');
  const pendingRows = db
    .select()
    .from(companyClassifications)
    .where(eq(companyClassifications.classificationResult, 'PENDING'))
    .all();

  const pendingNames = pendingRows.map((r) => r.companyName);
  console.log('Pending companies in DB:', pendingNames);
  assert.ok(pendingNames.some((n) => n.includes('Innovatech Labs')), 'Expected Innovatech Labs in PENDING');
  assert.ok(pendingNames.some((n) => n.includes('Bob Green Bakery')), 'Expected Bob Green Bakery in PENDING');
  // Stripe should NOT be pending (it was resolved by KB)
  assert.ok(!pendingNames.some((n) => n.includes('Stripe')), 'Expected Stripe NOT in PENDING (KB match)');
  console.log('✔ TEST 2 PASSED: Unknown companies safely persisted as PENDING.');

  // =========================================================================
  // TEST 3: Contact States Immediately After Ingestion
  // =========================================================================
  console.log('\n--- TEST 3: Contact Initial States at Ingestion ---');
  const batchContacts = db
    .select()
    .from(contacts)
    .where(eq(contacts.batchId, batchId))
    .all();

  const stripeContact = batchContacts.find((c) => c.email === 'sarah@stripe.com')!;
  const innovaContact = batchContacts.find((c) => c.email === 'john@innovatech.com')!;
  const bakeryContact = batchContacts.find((c) => c.email === 'bob@bakery.com')!;

  // Stripe (KB): queued, is_relevant = true, generation_status = PENDING_GENERATION
  assert.strictEqual(stripeContact.status, 'queued', 'Stripe contact should be queued');
  assert.strictEqual(stripeContact.isRelevant, true, 'Stripe contact isRelevant should be true');
  assert.strictEqual(stripeContact.generationStatus, 'PENDING_GENERATION', 'Stripe gen status should be PENDING_GENERATION');

  // Innovatech & Bakery (Unknown): discovered, is_relevant = null, generation_status = null
  assert.strictEqual(innovaContact.status, 'discovered', 'Innovatech contact should be discovered');
  assert.strictEqual(innovaContact.isRelevant, null, 'Innovatech contact isRelevant should be null');
  assert.strictEqual(innovaContact.generationStatus, null, 'Innovatech gen status should be null');

  assert.strictEqual(bakeryContact.status, 'discovered', 'Bakery contact should be discovered');
  assert.strictEqual(bakeryContact.isRelevant, null, 'Bakery contact isRelevant should be null');
  assert.strictEqual(bakeryContact.generationStatus, null, 'Bakery gen status should be null');
  console.log('✔ TEST 3 PASSED: Contacts have exact expected initial states.');

  // =========================================================================
  // TEST 4: Classification Barrier is Active (Email Generation Blocked)
  // =========================================================================
  console.log('\n--- TEST 4: Classification Barrier Blocks Email Generation ---');
  const isComplete = isBatchClassificationComplete(db, batchId);
  assert.strictEqual(isComplete, false, 'Classification must be incomplete while companies are PENDING');

  // Attempt email generation; must generate 0 emails because batch is blocked by barrier
  const genResult = await reconcilePendingEmailGenerations({ batchId });
  assert.strictEqual(genResult.succeeded, 0, 'No emails must be generated while barrier is active');
  assert.strictEqual(genResult.failed, 0);

  // Even the KB contact (sarah@stripe.com) must NOT be generated yet because the batch has other pending companies
  const stripeContactAfterGen = db.select().from(contacts).where(eq(contacts.id, stripeContact.id)).get()!;
  assert.strictEqual(stripeContactAfterGen.generationStatus, 'PENDING_GENERATION', 'Stripe email generation must remain blocked');
  console.log('✔ TEST 4 PASSED: Classification barrier fully blocks email generation for the batch.');

  // =========================================================================
  // TEST 5: Background Worker Picks Up PENDING Companies & Resolves
  // =========================================================================
  console.log('\n--- TEST 5: Background Classification Resolves Companies ---');
  // Mock AI caller for background reconciliation
  const mockAiCaller = async (prompt: string): Promise<string> => {
    // If prompt contains Innovatech Labs -> relevant tech company
    // If prompt contains Bob Green Bakery -> irrelevant bakery
    const items: Array<{ company: string; relevant: boolean; confidence: number; reason: string }> = [];
    if (prompt.includes('Innovatech Labs')) {
      items.push({
        company: 'Innovatech Labs',
        relevant: true,
        confidence: 0.95,
        reason: 'Software and AI development consultancy',
      });
    }
    if (prompt.includes('Bob Green Bakery')) {
      items.push({
        company: 'Bob Green Bakery',
        relevant: false,
        confidence: 0.99,
        reason: 'Bakery and food services (Non-Tech Target)',
      });
    }
    return JSON.stringify(items);
  };

  const reconcileRes = await reconcilePendingClassifications(mockAiCaller, { batchId });
  console.log('Reconciliation result:', reconcileRes);
  assert.ok(reconcileRes.processed >= 2, `Expected at least 2 processed, got ${reconcileRes.processed}`);
  assert.ok(reconcileRes.promotedToQueue >= 1, `Expected at least 1 promoted, got ${reconcileRes.promotedToQueue}`);

  // Check contact updates:
  const innovaAfter = db.select().from(contacts).where(eq(contacts.id, innovaContact.id)).get()!;
  const bakeryAfter = db.select().from(contacts).where(eq(contacts.id, bakeryContact.id)).get()!;

  // Innovatech Labs should now be promoted to queued with PENDING_GENERATION
  assert.strictEqual(innovaAfter.status, 'queued', 'Innovatech should now be queued');
  assert.strictEqual(innovaAfter.isRelevant, true, 'Innovatech isRelevant should be true');
  assert.strictEqual(innovaAfter.generationStatus, 'PENDING_GENERATION', 'Innovatech gen status should be PENDING_GENERATION');

  // Bob Green Bakery should be marked skipped
  assert.strictEqual(bakeryAfter.status, 'skipped', 'Bakery should be skipped');
  assert.strictEqual(bakeryAfter.isRelevant, false, 'Bakery isRelevant should be false');
  assert.strictEqual(bakeryAfter.generationStatus, null, 'Bakery gen status should be null');
  console.log('✔ TEST 5 PASSED: Background reconciliation resolved and cascaded classifications.');

  // =========================================================================
  // TEST 6: Barrier Unlocks and Email Generation Proceeds
  // =========================================================================
  console.log('\n--- TEST 6: Classification Barrier Lifts & Generation Proceeds ---');
  const isCompleteAfter = isBatchClassificationComplete(db, batchId);
  assert.strictEqual(isCompleteAfter, true, 'Classification barrier must be complete now (Pending = 0, Retry = 0)');

  // Run generation reconciler
  const genResult2 = await reconcilePendingEmailGenerations({ batchId });
  console.log('Generation result after barrier unlocked:', genResult2);
  assert.ok(genResult2.succeeded >= 2, `Expected at least 2 emails generated (Stripe + Innovatech), got ${genResult2.succeeded}`);

  // Confirm contacts now have GENERATED status
  const stripeFinal = db.select().from(contacts).where(eq(contacts.id, stripeContact.id)).get()!;
  const innovaFinal = db.select().from(contacts).where(eq(contacts.id, innovaContact.id)).get()!;
  assert.strictEqual(stripeFinal.generationStatus, 'GENERATED', 'Stripe should be GENERATED');
  assert.strictEqual(innovaFinal.generationStatus, 'GENERATED', 'Innovatech should be GENERATED');
  assert.ok(stripeFinal.emailSubject && stripeFinal.emailSubject.length > 0, 'Stripe email subject should exist');
  assert.ok(innovaFinal.emailSubject && innovaFinal.emailSubject.length > 0, 'Innovatech email subject should exist');
  console.log('✔ TEST 6 PASSED: Barrier unlocked and emails successfully generated autonomously.');

  // =========================================================================
  // TEST 7: Batch Isolation (Batch A Pending Does NOT Block Completed Batch B)
  // =========================================================================
  console.log('\n--- TEST 7: Multi-Batch Isolation ---');
  // Batch A: Uploaded with an unknown company that remains PENDING
  const csvBatchA = [
    'company_name,contact_name,email',
    'Pending Co A,Bob A,boba@pendinga.com',
  ].join('\n');
  const resBatchA = await processBatchFile(Buffer.from(csvBatchA), 'batch_A.csv');

  // Batch B: Uploaded with a known KB company (Stripe), immediately complete
  const csvBatchB = [
    'company_name,contact_name,email',
    'Stripe Inc,Recruiter B,recruiterb@stripe.com',
  ].join('\n');
  const resBatchB = await processBatchFile(Buffer.from(csvBatchB), 'batch_B.csv');

  // Verify: Batch A is incomplete, Batch B is complete
  assert.strictEqual(isBatchClassificationComplete(db, resBatchA.batchId), false, 'Batch A must be incomplete');
  assert.strictEqual(isBatchClassificationComplete(db, resBatchB.batchId), true, 'Batch B must be complete (KB company)');

  // Verify: Batch B can generate emails while Batch A is still blocked
  const genBatchB = await reconcilePendingEmailGenerations({ batchId: resBatchB.batchId });
  assert.strictEqual(genBatchB.succeeded, 1, 'Batch B must generate email successfully');

  const genBatchA = await reconcilePendingEmailGenerations({ batchId: resBatchA.batchId });
  assert.strictEqual(genBatchA.succeeded, 0, 'Batch A must remain blocked');
  console.log('✔ TEST 7 PASSED: Batch isolation verified; incomplete Batch A does not block Batch B.');

  console.log('\n======================================================================');
  console.log('ALL 7 DECOUPLED UPLOAD VERIFICATION TESTS PASSED SUCCESSFULLY');
  console.log('======================================================================');

  // Cleanup test directory
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {}
}

runDecoupledUploadTests().catch((err) => {
  console.error('Test Suite Failed:', err);
  process.exit(1);
});
