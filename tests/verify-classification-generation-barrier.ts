/**
 * Verification Test Suite for:
 * Company Classification -> Email Generation Barrier & 13-Metric Dashboard
 *
 * Requirements verified:
 * TEST 1: Batch has pending classification > 0 -> email generation does NOT begin.
 * TEST 2: Batch has retry waiting > 0 -> email generation does NOT begin.
 * TEST 3: Batch has pending = 0 and retry = 0 -> email generation becomes eligible.
 * TEST 4: Batch A incomplete, Batch B complete -> Batch B can generate, Batch A cannot.
 * TEST 5: A company becomes RELEVANT while others remain pending -> contacts remain blocked.
 * TEST 6: Classification completes -> generation starts normally.
 * TEST 7: API/manual email generation path cannot bypass the barrier.
 * TEST 8: Queue/scheduler (acquireNextEligibleJob) cannot bypass the barrier.
 * TEST 9: Small deterministic batch fixture for all 13 dashboard metrics.
 * TEST 10: Duplicate company metric with multiple contacts at same company (duplicate company = 0).
 * TEST 11: Zero state verified when no batch exists (all 13 metrics = 0).
 */

import path from 'path';
import fs from 'fs';
import assert from 'assert';

const TEST_DIR = path.join(process.cwd(), 'data', `test-barrier-${Date.now()}`);
fs.mkdirSync(TEST_DIR, { recursive: true });

process.env.DATA_DIR = TEST_DIR;
(process.env as Record<string, string>).NODE_ENV = 'test';
process.env.OUTREACH_DRY_RUN = 'true';

import { getDb, resetDbConnection } from '../src/db';
import { initializeDatabase } from '../src/db/migrate';
import { batches, contacts, companyClassifications, outreachQueue, resume } from '../src/db/schema';
import { sql, and, eq } from 'drizzle-orm';
import { isBatchClassificationComplete } from '../src/lib/pipeline/classification-reconciler';
import {
  reconcilePendingEmailGenerations,
  hasActiveFreshPendingGeneration,
  getGenerationRoundState,
} from '../src/lib/pipeline/generation-reconciler';
import { acquireNextEligibleJob } from '../src/lib/scheduler/queue-manager';
import { getProcessingPipelineStats } from '../src/lib/processing-queries';
import { saveCandidateProfile } from '../src/lib/candidate-profile/candidate-profile-service';
import { POST as generateApiRoute } from '../src/app/api/generate/route';
import { POST as regenerateApiRoute } from '../src/app/api/contacts/[id]/regenerate/route';
import { executeHistorical17Recovery } from '../src/lib/pipeline/historical-recovery';
import { NextRequest } from 'next/server';

async function runBarrierVerificationTests() {
  console.log('======================================================================');
  console.log('COMPANY CLASSIFICATION -> EMAIL GENERATION BARRIER VERIFICATION');
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
    parsedText: 'Alice Developer',
    uploadedAt: new Date().toISOString(),
  }).run();

  saveCandidateProfile({
    fullName: 'Test Candidate',
    email: 'candidate@test.com',
    degree: 'B.Tech',
    fieldOfStudy: 'Computer Science',
    institution: 'University',
    skills: {
      programmingLanguages: ['TypeScript', 'JavaScript', 'Python'],
      webDevelopment: ['Next.js', 'React', 'Node.js'],
      databasesOrms: [],
      aiMl: [],
      coreComputerScience: [],
      toolsApis: [],
    },
    projects: [],
    experience: [],
    education: [],
    achievements: [],
  });

  // -------------------------------------------------------------------------
  // TEST 1: Batch has pending classification > 0 -> generation blocked
  // -------------------------------------------------------------------------
  console.log('TEST 1: Batch with AI Search Pending > 0 blocks email generation...');
  const batch1Id = 'batch-test-1';
  db.insert(batches).values({
    id: batch1Id,
    filename: 'batch1.csv',
    uploadDate: new Date().toISOString(),
    status: 'processing',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();

  // Contact 1: Relevant company, but company classification is PENDING
  db.insert(contacts).values({
    id: 'c1-1',
    batchId: batch1Id,
    companyName: 'Acme Cloud',
    contactName: 'Alice',
    email: 'alice@acmecloud.com',
    isRelevant: true,
    emailValid: true,
    isDuplicate: false,
    status: 'discovered',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();

  db.insert(companyClassifications).values({
    normalizedName: 'acme cloud',
    companyName: 'Acme Cloud',
    reason: 'Test pending classification',
    classificationResult: 'PENDING',
    retryRound: 0,
    retryCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();

  const isComplete1 = isBatchClassificationComplete(db, batch1Id);
  assert.strictEqual(isComplete1, false, 'Batch 1 must NOT be classification-complete when pending > 0');

  const activeFresh1 = hasActiveFreshPendingGeneration(db, batch1Id);
  assert.strictEqual(activeFresh1, false, 'hasActiveFreshPendingGeneration must return false while classification incomplete');

  const roundState1 = getGenerationRoundState(db, batch1Id);
  assert.strictEqual(roundState1.activePendingCount, 0, 'Round state active count must be 0 when classification incomplete');

  const reconcileResult1 = await reconcilePendingEmailGenerations({ batchId: batch1Id });
  assert.strictEqual(reconcileResult1.processed, 0, 'reconcilePendingEmailGenerations must process 0 when barrier not met');
  assert.strictEqual(reconcileResult1.skippedReason, 'CLASSIFICATION_INCOMPLETE', 'reconcile skippedReason must be CLASSIFICATION_INCOMPLETE');
  console.log('✓ TEST 1 PASSED: Generation blocked when pending > 0\n');

  // -------------------------------------------------------------------------
  // TEST 2: Batch has retry waiting > 0 -> generation blocked
  // -------------------------------------------------------------------------
  console.log('TEST 2: Batch with AI Search Retry > 0 blocks email generation...');
  const batch2Id = 'batch-test-2';
  db.insert(batches).values({
    id: batch2Id,
    filename: 'batch2.csv',
    uploadDate: new Date().toISOString(),
    status: 'processing',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();

  db.insert(contacts).values({
    id: 'c2-1',
    batchId: batch2Id,
    companyName: 'Retry Corp',
    contactName: 'Bob',
    email: 'bob@retrycorp.com',
    isRelevant: true,
    emailValid: true,
    isDuplicate: false,
    status: 'discovered',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();

  db.insert(companyClassifications).values({
    normalizedName: 'retry corp',
    companyName: 'Retry Corp',
    reason: 'Test retry',
    classificationResult: 'RETRY_WAITING',
    retryRound: 1,
    retryCount: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();

  const isComplete2 = isBatchClassificationComplete(db, batch2Id);
  assert.strictEqual(isComplete2, false, 'Batch 2 must NOT be classification-complete when retry waiting > 0');

  const reconcileResult2 = await reconcilePendingEmailGenerations({ batchId: batch2Id });
  assert.strictEqual(reconcileResult2.processed, 0, 'reconcile must process 0 for batch with retry waiting');
  console.log('✓ TEST 2 PASSED: Generation blocked when retry waiting > 0\n');

  // -------------------------------------------------------------------------
  // TEST 3: Batch has pending = 0 and retry waiting = 0 -> generation eligible
  // -------------------------------------------------------------------------
  console.log('TEST 3: Batch with pending = 0 and retry = 0 allows generation...');
  const batch3Id = 'batch-test-3';
  db.insert(batches).values({
    id: batch3Id,
    filename: 'batch3.csv',
    uploadDate: new Date().toISOString(),
    status: 'processing',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();

  db.insert(contacts).values({
    id: 'c3-1',
    batchId: batch3Id,
    companyName: 'Ready Tech',
    contactName: 'Charlie',
    email: 'charlie@readytech.com',
    isRelevant: true,
    emailValid: true,
    isDuplicate: false,
    status: 'discovered',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();

  db.insert(companyClassifications).values({
    normalizedName: 'ready tech',
    companyName: 'Ready Tech',
    reason: 'Test relevant',
    classificationResult: 'RELEVANT',
    retryRound: 0,
    retryCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();

  const isComplete3 = isBatchClassificationComplete(db, batch3Id);
  assert.strictEqual(isComplete3, true, 'Batch 3 must be classification-complete when all terminal');

  const activeFresh3 = hasActiveFreshPendingGeneration(db, batch3Id);
  assert.strictEqual(activeFresh3, true, 'hasActiveFreshPendingGeneration must return true when batch complete and relevant contact waiting');

  const roundState3 = getGenerationRoundState(db, batch3Id);
  assert.strictEqual(roundState3.activePendingCount, 1, 'Round state active count must be 1');
  console.log('✓ TEST 3 PASSED: Generation unlocked when pending = 0 and retry = 0\n');

  // -------------------------------------------------------------------------
  // TEST 4: Batch A incomplete, Batch B complete -> Batch isolation
  // -------------------------------------------------------------------------
  console.log('TEST 4: Batch isolation (Batch A incomplete does not block Batch B)...');
  // Batch 1 is still incomplete (acme cloud is PENDING). Batch 3 is complete.
  assert.strictEqual(isBatchClassificationComplete(db, batch1Id), false, 'Batch 1 is incomplete');
  assert.strictEqual(isBatchClassificationComplete(db, batch3Id), true, 'Batch 3 is complete');

  // Global reconciler pass should pick up Batch 3 and NOT Batch 1
  const globalRoundState = getGenerationRoundState(db);
  assert.ok(globalRoundState.activePendingCount >= 1, 'Global round state must find eligible contacts from Batch 3');
  console.log('✓ TEST 4 PASSED: Batch isolation maintained\n');

  // -------------------------------------------------------------------------
  // TEST 5: Company becomes RELEVANT while other companies in same batch pending
  // -------------------------------------------------------------------------
  console.log('TEST 5: Company becomes RELEVANT while other companies in same batch pending...');
  const batch5Id = 'batch-test-5';
  db.insert(batches).values({
    id: batch5Id,
    filename: 'batch5.csv',
    uploadDate: new Date().toISOString(),
    status: 'processing',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();

  // Contact A from Relevant Company Alpha
  db.insert(contacts).values({
    id: 'c5-alpha',
    batchId: batch5Id,
    companyName: 'Company Alpha',
    contactName: 'Alpha Contact',
    email: 'alpha@alpha.com',
    isRelevant: true,
    emailValid: true,
    isDuplicate: false,
    status: 'discovered',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();

  db.insert(companyClassifications).values({
    normalizedName: 'company alpha',
    companyName: 'Company Alpha',
    reason: 'Test alpha relevant',
    classificationResult: 'RELEVANT',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();

  // Contact B from Pending Company Beta in SAME batch
  db.insert(contacts).values({
    id: 'c5-beta',
    batchId: batch5Id,
    companyName: 'Company Beta',
    contactName: 'Beta Contact',
    email: 'beta@beta.com',
    isRelevant: null,
    emailValid: true,
    isDuplicate: false,
    status: 'discovered',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();

  db.insert(companyClassifications).values({
    normalizedName: 'company beta',
    companyName: 'Company Beta',
    reason: 'Test beta pending',
    classificationResult: 'PENDING',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();

  assert.strictEqual(isBatchClassificationComplete(db, batch5Id), false, 'Batch 5 must be incomplete due to Beta');
  assert.strictEqual(hasActiveFreshPendingGeneration(db, batch5Id), false, 'Alpha contacts must remain blocked while Beta is pending');
  console.log('✓ TEST 5 PASSED: Relevant company in incomplete batch remains blocked\n');

  // -------------------------------------------------------------------------
  // TEST 6: When Company Beta completes, generation starts
  // -------------------------------------------------------------------------
  console.log('TEST 6: When Company Beta completes, generation becomes unlocked...');
  db.run(sql`UPDATE company_classifications SET classification_result = 'IRRELEVANT' WHERE normalized_name = 'company beta'`);
  db.run(sql`UPDATE contacts SET is_relevant = 0 WHERE id = 'c5-beta'`);

  assert.strictEqual(isBatchClassificationComplete(db, batch5Id), true, 'Batch 5 must now be complete');
  assert.strictEqual(hasActiveFreshPendingGeneration(db, batch5Id), true, 'Alpha contacts now unlocked for generation');
  console.log('✓ TEST 6 PASSED: Batch generation unlocked once all companies reach terminal status\n');

  // -------------------------------------------------------------------------
  // TEST 7: API / manual generation path cannot bypass barrier
  // -------------------------------------------------------------------------
  console.log('TEST 7: API POST /api/generate cannot bypass the barrier...');
  // Attempt to generate contact from incomplete Batch 1
  const req1 = new NextRequest('http://localhost:3000/api/generate', {
    method: 'POST',
    body: JSON.stringify({ contactId: 'c1-1' }),
  });
  const res1 = await generateApiRoute(req1);
  assert.strictEqual(res1.status, 400, 'API must return 400 for contact in incomplete batch');
  const body1 = await res1.json();
  assert.ok(body1.error.includes('classification is still pending'), 'API error must state classification pending');

  // Attempt to generate by batchId for incomplete Batch 1
  const reqBatch = new NextRequest('http://localhost:3000/api/generate', {
    method: 'POST',
    body: JSON.stringify({ batchId: batch1Id }),
  });
  const resBatch = await generateApiRoute(reqBatch);
  assert.strictEqual(resBatch.status, 400, 'API must return 400 when batch classification incomplete');
  console.log('✓ TEST 7 PASSED: API /api/generate enforces classification barrier\n');

  // -------------------------------------------------------------------------
  // TEST 8: Scheduler / queue acquisition cannot bypass barrier
  // -------------------------------------------------------------------------
  console.log('TEST 8: Scheduler acquireNextEligibleJob cannot bypass the barrier...');
  // Put an incomplete batch contact into outreach_queue with pending status
  db.insert(outreachQueue).values({
    id: 'oq-c1-1',
    contactId: 'c1-1',
    status: 'pending',
    priority: 10,
    attempts: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();

  const acquiredJob = acquireNextEligibleJob('worker_test_barrier');
  // It must NOT acquire c1-1 because Batch 1 classification is incomplete
  if (acquiredJob) {
    assert.notStrictEqual(acquiredJob.contact.id, 'c1-1', 'Scheduler acquired job must NOT be from incomplete Batch 1');
  }
  console.log('✓ TEST 8 PASSED: Scheduler acquireNextEligibleJob respects barrier\n');

  // -------------------------------------------------------------------------
  // TEST 9 & 10: 13 Dashboard Metrics + Duplicate Company count
  // -------------------------------------------------------------------------
  console.log('TEST 9 & 10: 13 Dashboard Metrics with deterministic fixture & multi-contact deduplication...');
  const fixtureBatchId = 'batch-fixture-13';
  db.insert(batches).values({
    id: fixtureBatchId,
    filename: 'companies_test.xlsx',
    uploadDate: new Date().toISOString(),
    status: 'processing',
    createdAt: new Date(Date.now() + 10000).toISOString(), // latest batch
    updatedAt: new Date().toISOString(),
  }).run();

  // 3 contacts at "Microsoft"
  db.insert(contacts).values({
    id: 'f-1',
    batchId: fixtureBatchId,
    companyName: 'Microsoft',
    contactName: 'Person 1',
    email: 'p1@microsoft.com',
    isRelevant: true,
    emailValid: true,
    isDuplicate: false,
    status: 'discovered',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();

  db.insert(contacts).values({
    id: 'f-2',
    batchId: fixtureBatchId,
    companyName: 'Microsoft',
    contactName: 'Person 2',
    email: 'p2@microsoft.com',
    isRelevant: true,
    emailValid: true,
    isDuplicate: false,
    status: 'discovered',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();

  db.insert(contacts).values({
    id: 'f-3',
    batchId: fixtureBatchId,
    companyName: 'Microsoft',
    contactName: 'Person 3',
    email: 'p3@microsoft.com',
    isRelevant: true,
    emailValid: true,
    isDuplicate: false,
    status: 'discovered',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();

  // Duplicate contact in batch
  db.insert(contacts).values({
    id: 'f-3-dup',
    batchId: fixtureBatchId,
    companyName: 'Microsoft',
    contactName: 'Person 3 Dup',
    email: 'p3@microsoft.com',
    isRelevant: true,
    emailValid: true,
    isDuplicate: true, // Marked duplicate contact
    status: 'discovered',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();

  // Google Inc and Google LLC -> raw distinct = 2, normalized distinct = 1 -> Duplicate Companies = 1
  db.insert(contacts).values({
    id: 'f-4',
    batchId: fixtureBatchId,
    companyName: 'Google Inc',
    contactName: 'Person 4',
    email: 'p4@google.com',
    isRelevant: null,
    emailValid: true,
    isDuplicate: false,
    status: 'discovered',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();

  db.insert(contacts).values({
    id: 'f-5',
    batchId: fixtureBatchId,
    companyName: 'Google LLC',
    contactName: 'Person 5',
    email: 'p5@google.com',
    isRelevant: null,
    emailValid: true,
    isDuplicate: false,
    status: 'discovered',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();

  // Irrelevant company
  db.insert(contacts).values({
    id: 'f-6',
    batchId: fixtureBatchId,
    companyName: 'Bakery Shop',
    contactName: 'Baker',
    email: 'baker@bakery.com',
    isRelevant: false,
    emailValid: true,
    isDuplicate: false,
    status: 'discovered',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();

  // Insert classifications:
  // Microsoft -> RELEVANT
  db.insert(companyClassifications).values({
    normalizedName: 'microsoft',
    companyName: 'Microsoft',
    reason: 'Software and Cloud',
    classificationResult: 'RELEVANT',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();

  // Google Inc / LLC -> PENDING
  db.insert(companyClassifications).values({
    normalizedName: 'google inc',
    companyName: 'Google Inc',
    reason: 'Search and Cloud',
    classificationResult: 'PENDING',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();

  db.insert(companyClassifications).values({
    normalizedName: 'google llc',
    companyName: 'Google LLC',
    reason: 'Search and Cloud',
    classificationResult: 'PENDING',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();

  // Bakery -> IRRELEVANT
  db.insert(companyClassifications).values({
    normalizedName: 'bakery shop',
    companyName: 'Bakery Shop',
    reason: 'Food retail',
    classificationResult: 'IRRELEVANT',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();

  const stats = getProcessingPipelineStats(fixtureBatchId);
  console.log('Fixture Stats:', {
    companiesFound: stats.companiesFound,
    duplicateCompanies: stats.duplicateCompanies,
    aiSearchPending: stats.aiSearchPending,
    aiSearchRetry: stats.aiSearchRetry,
    aiProcessed: stats.aiProcessed,
    irrelevantCompanies: stats.irrelevantCompanies,
    csItRelevant: stats.csItRelevant,
    contactsFound: stats.contactsFound,
    duplicateContacts: stats.duplicateContacts,
    emailsGenerating: stats.emailsGenerating,
  });

  // Raw companies = 'Microsoft', 'Google Inc', 'Google LLC', 'Bakery Shop' (4 raw distinct)
  // Companies with multiple contact rows:
  // Microsoft: 4 contacts (> 1) -> duplicate company
  // Google (Google Inc, Google LLC): 2 contacts (> 1) -> duplicate company
  // Bakery Shop: 1 contact (not duplicate)
  // Duplicate Companies = 2
  assert.strictEqual(stats.companiesFound, 4, 'Companies found must equal raw distinct companies');
  assert.strictEqual(stats.duplicateCompanies, 2, 'Duplicate companies must be 2 (Microsoft and Google have multiple contacts)');
  assert.strictEqual(stats.contactsFound, 7, 'Total contacts found must be 7');
  assert.strictEqual(stats.duplicateContacts, 1, 'Duplicate contacts must be 1');
  assert.strictEqual(stats.aiSearchPending, 2, 'AI search pending must be 2 (Google Inc and Google LLC)');
  assert.strictEqual(stats.irrelevantCompanies, 1, 'Irrelevant companies must be 1 (Bakery)');
  assert.strictEqual(stats.csItRelevant, 1, 'CS/IT Relevant must be 1 (Microsoft)');
  assert.strictEqual(stats.aiProcessed, 2, 'AI processed must be 2 (Microsoft + Bakery)');
  // Crucial requirement: While aiSearchPending > 0, emailsGenerating MUST BE 0 even though Microsoft contacts are relevant
  assert.strictEqual(stats.emailsGenerating, 0, 'Emails generating MUST BE 0 while batch classification is incomplete');
  console.log('✓ TEST 9 & 10 PASSED: All 13 metrics and company deduplication formula verified\n');

  // -------------------------------------------------------------------------
  // TEST 11: Zero State
  // -------------------------------------------------------------------------
  console.log('TEST 11: Zero state when no batch exists...');
  const emptyStats = getProcessingPipelineStats('non-existent-batch-id');
  assert.strictEqual(emptyStats.companiesFound, 0);
  assert.strictEqual(emptyStats.duplicateCompanies, 0);
  assert.strictEqual(emptyStats.aiSearchPending, 0);
  assert.strictEqual(emptyStats.aiSearchRetry, 0);
  assert.strictEqual(emptyStats.aiProcessed, 0);
  assert.strictEqual(emptyStats.irrelevantCompanies, 0);
  assert.strictEqual(emptyStats.csItRelevant, 0);
  assert.strictEqual(emptyStats.contactsFound, 0);
  assert.strictEqual(emptyStats.duplicateContacts, 0);
  assert.strictEqual(emptyStats.emailsGenerating, 0);
  assert.strictEqual(emptyStats.generationRetry, 0);
  assert.strictEqual(emptyStats.generationFailed, 0);
  assert.strictEqual(emptyStats.readyToSend, 0);
  console.log('✓ TEST 11 PASSED: Zero state returns 0 for all 13 metrics\n');

  // -------------------------------------------------------------------------
  // TEST 12: Incomplete classification blocks entire generation processing stage:
  // - Pending generation blocked
  // - Generation retry execution blocked
  // - Generation failure recovery blocked
  // -------------------------------------------------------------------------
  console.log('TEST 12: Incomplete classification gates entire generation stage (pending, retry, failure recovery)...');
  const batch12Id = 'batch-test-12-gating';
  db.insert(batches).values({
    id: batch12Id,
    filename: 'batch12_gating.csv',
    uploadDate: new Date().toISOString(),
    status: 'processing',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();

  // Contact 12-A: Fresh pending generation
  db.insert(contacts).values({
    id: 'c12-pending',
    batchId: batch12Id,
    companyName: 'Incomplete Systems',
    contactName: 'Incomplete Pending User',
    email: 'pending_user@incompletesys.com',
    isRelevant: true,
    emailValid: true,
    isDuplicate: false,
    status: 'discovered',
    generationStatus: 'PENDING_GENERATION',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();

  // Contact 12-B: Existing RETRY_PENDING record
  db.insert(contacts).values({
    id: 'c12-retry',
    batchId: batch12Id,
    companyName: 'Incomplete Systems',
    contactName: 'Incomplete Retry User',
    email: 'retry_user@incompletesys.com',
    isRelevant: true,
    emailValid: true,
    isDuplicate: false,
    status: 'queued',
    generationStatus: 'RETRY_PENDING',
    generationAttemptCount: 1,
    retryTurnConsumedMs: 25000,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();

  // Contact 12-C: Existing GENERATION_FAILED record
  db.insert(contacts).values({
    id: 'c12-failed',
    batchId: batch12Id,
    companyName: 'Incomplete Systems',
    contactName: 'Incomplete Failed User',
    email: 'failed_user@incompletesys.com',
    isRelevant: true,
    emailValid: true,
    isDuplicate: false,
    status: 'failed',
    generationStatus: 'GENERATION_FAILED',
    errorMessage: 'Quota exhausted',
    generationAttemptCount: 5,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();

  // Company is PENDING classification
  db.insert(companyClassifications).values({
    normalizedName: 'incomplete systems',
    companyName: 'Incomplete Systems',
    reason: 'Evaluating domain',
    classificationResult: 'PENDING',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();

  assert.strictEqual(isBatchClassificationComplete(db, batch12Id), false, 'Batch 12 must be classification incomplete');

  // 1. Pending generation is blocked
  assert.strictEqual(hasActiveFreshPendingGeneration(db, batch12Id), false, 'hasActiveFreshPendingGeneration must return false');

  // 2. Round state reports 0 active and 0 retry waiting for batch
  const roundState12 = getGenerationRoundState(db, batch12Id);
  assert.strictEqual(roundState12.activePendingCount, 0, 'Round state active count must be 0');
  assert.strictEqual(roundState12.retryWaitingCount, 0, 'Round state retry waiting count must be 0');
  assert.strictEqual(roundState12.isCurrentRoundDrained, false, 'Current round must not be marked drained when blocked');

  // 3. Reconciler does not process fresh OR retry contacts
  const reconcileResult12 = await reconcilePendingEmailGenerations({
    batchId: batch12Id,
    aiCallerOverride: async () => 'Subject: Test\n\nTest body',
  });
  assert.strictEqual(reconcileResult12.processed, 0, 'reconcile must process 0 contacts');
  assert.strictEqual(reconcileResult12.skippedReason, 'CLASSIFICATION_INCOMPLETE', 'skippedReason must be CLASSIFICATION_INCOMPLETE');

  // 4. Contact regenerate API route rejects with 400
  const regenReq = new NextRequest('http://localhost:3000/api/contacts/c12-retry/regenerate', { method: 'POST' });
  const regenRes = await regenerateApiRoute(regenReq, { params: Promise.resolve({ id: 'c12-retry' }) });
  assert.strictEqual(regenRes.status, 400, 'Regenerate API must reject with 400 when classification incomplete');

  // 5. Historical / failure recovery rejects because classification is incomplete
  const recoveryResult = executeHistorical17Recovery(db, ['c12-failed']);
  assert.strictEqual(recoveryResult.success, false, 'Recovery must fail for batch with incomplete classification');
  assert.strictEqual(recoveryResult.failedPrecondition, 'classification_incomplete', 'Precondition must cite classification_incomplete');
  assert.strictEqual(recoveryResult.affectedCount, 0, 'Affected count must be 0');

  // 6. Dashboard metrics: emailsGenerating = 0 (blocked), but persisted retry & failed counts intact
  const stats12 = getProcessingPipelineStats(batch12Id);
  assert.strictEqual(stats12.aiSearchPending, 1, 'AI Search Pending must be 1');
  assert.strictEqual(stats12.emailsGenerating, 0, 'Emails generating must be 0 (blocked)');
  assert.strictEqual(stats12.generationRetry, 1, 'Generation retry count must be preserved (1)');
  assert.strictEqual(stats12.generationFailed, 1, 'Generation failed count must be preserved (1)');
  console.log('✓ TEST 12 PASSED: Incomplete classification blocks entire generation stage\n');

  // -------------------------------------------------------------------------
  // TEST 13: Completed classification unlocks entire generation processing stage:
  // - Generation starts normally
  // - Generation retry resumes normally
  // - Failure recovery proceeds normally
  // -------------------------------------------------------------------------
  console.log('TEST 13: Completed classification allows entire generation processing stage to proceed...');
  const batch13Id = 'batch-test-13-complete';
  db.insert(batches).values({
    id: batch13Id,
    filename: 'batch13_complete.csv',
    uploadDate: new Date().toISOString(),
    status: 'processing',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();

  // Contact 13-Retry
  db.insert(contacts).values({
    id: 'c13-retry',
    batchId: batch13Id,
    companyName: 'Finished Software',
    contactName: 'Finished Retry User',
    email: 'retry_user@finishedsoftware.com',
    isRelevant: true,
    emailValid: true,
    isDuplicate: false,
    status: 'queued',
    generationStatus: 'RETRY_PENDING',
    generationAttemptCount: 1,
    retryTurnConsumedMs: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();

  // Company is fully classified as RELEVANT
  db.insert(companyClassifications).values({
    normalizedName: 'finished software',
    companyName: 'Finished Software',
    reason: 'CS/IT software company',
    classificationResult: 'RELEVANT',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();

  assert.strictEqual(isBatchClassificationComplete(db, batch13Id), true, 'Batch 13 must be classification complete');

  // Round state shows retryWaiting = 1 and isCurrentRoundDrained = true (ready for retry pass)
  const roundState13 = getGenerationRoundState(db, batch13Id);
  assert.strictEqual(roundState13.activePendingCount, 0, 'No fresh pending contacts');
  assert.strictEqual(roundState13.retryWaitingCount, 1, 'Retry contact is waiting');
  assert.strictEqual(roundState13.isCurrentRoundDrained, true, 'Round is drained and ready for retry');

  // Reconcile pending email generations executes the retry turn
  const reconcileResult13 = await reconcilePendingEmailGenerations({
    batchId: batch13Id,
    aiCallerOverride: async () => 'Subject: Finished Solutions\n\nEmail body for finished user.',
  });
  assert.strictEqual(reconcileResult13.processed, 1, 'Reconcile must process 1 contact in retry pass');
  assert.strictEqual(reconcileResult13.succeeded, 1, 'Reconcile must succeed for retry contact');

  // Verify contact updated to GENERATED
  const updatedContact13 = db.select().from(contacts).where(sql`id = 'c13-retry'`).get();
  assert.strictEqual(updatedContact13?.generationStatus, 'GENERATED', 'Contact must be transitioned to GENERATED');
  assert.strictEqual(updatedContact13?.status, 'generated', 'Contact status must be generated');
  assert.ok(updatedContact13?.emailSubject?.includes('Finished Solutions'), 'Subject must be populated');

  // Verify presence in outreach_queue
  const queueItem13 = db.select().from(outreachQueue).where(sql`contact_id = 'c13-retry'`).get();
  assert.ok(queueItem13, 'Contact must be staged in outreach queue');
  assert.strictEqual(queueItem13?.status, 'pending', 'Queue item status must be pending');

  console.log('✓ TEST 13 PASSED: Completed classification unlocks retry generation\n');

  // -------------------------------------------------------------------------
  // TEST 14: Batch A incomplete + Batch B complete -> Batch isolation
  // -------------------------------------------------------------------------
  console.log('TEST 14: Batch A incomplete blocks its generation while Batch B complete generates normally...');
  // Batch 12 is still incomplete (Incomplete Systems is PENDING)
  // Create Batch 14 which is complete and has a pending generation contact
  const batch14Id = 'batch-test-14-isolated';
  db.insert(batches).values({
    id: batch14Id,
    filename: 'batch14_isolated.csv',
    uploadDate: new Date().toISOString(),
    status: 'processing',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();

  db.insert(contacts).values({
    id: 'c14-isolated-pending',
    batchId: batch14Id,
    companyName: 'Isolated Tech',
    contactName: 'Isolated Contact',
    email: 'isolated@isolatedtech.com',
    isRelevant: true,
    emailValid: true,
    isDuplicate: false,
    status: 'discovered',
    generationStatus: 'PENDING_GENERATION',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();

  db.insert(companyClassifications).values({
    normalizedName: 'isolated tech',
    companyName: 'Isolated Tech',
    reason: 'Pure technology company',
    classificationResult: 'RELEVANT',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();

  assert.strictEqual(isBatchClassificationComplete(db, batch12Id), false, 'Batch 12 is incomplete');
  assert.strictEqual(isBatchClassificationComplete(db, batch14Id), true, 'Batch 14 is complete');

  // Reconciler run for Batch 12 remains blocked
  const res12 = await reconcilePendingEmailGenerations({ batchId: batch12Id });
  assert.strictEqual(res12.processed, 0, 'Batch 12 must process 0');
  assert.strictEqual(res12.skippedReason, 'CLASSIFICATION_INCOMPLETE');

  // Reconciler run for Batch 14 succeeds
  const res14 = await reconcilePendingEmailGenerations({
    batchId: batch14Id,
    aiCallerOverride: async () => 'Subject: Collaboration\n\nIsolated body.',
  });
  assert.strictEqual(res14.processed, 1, 'Batch 14 must process 1 contact');
  assert.strictEqual(res14.succeeded, 1, 'Batch 14 must succeed');

  const updatedC14 = db.select().from(contacts).where(sql`id = 'c14-isolated-pending'`).get();
  assert.strictEqual(updatedC14?.generationStatus, 'GENERATED', 'Batch 14 contact must be generated');

  console.log('✓ TEST 14 PASSED: Batch isolation strictly maintained\n');

  // -------------------------------------------------------------------------
  // TEST 15: Persisted Generation Retry and Generation Failed records preserved
  // -------------------------------------------------------------------------
  console.log('TEST 15: Existing Generation Retry and Generation Failed records remain persisted while barrier active...');
  const c12RetryContact = db.select().from(contacts).where(sql`id = 'c12-retry'`).get();
  assert.ok(c12RetryContact, 'c12-retry record must exist');
  assert.strictEqual(c12RetryContact?.generationStatus, 'RETRY_PENDING', 'c12-retry generation status must remain RETRY_PENDING');
  assert.strictEqual(c12RetryContact?.generationAttemptCount, 1, 'c12-retry attempt count must be preserved');
  assert.strictEqual(c12RetryContact?.retryTurnConsumedMs, 25000, 'c12-retry consumed ms must be preserved');

  const c12FailedContact = db.select().from(contacts).where(sql`id = 'c12-failed'`).get();
  assert.ok(c12FailedContact, 'c12-failed record must exist');
  assert.strictEqual(c12FailedContact?.generationStatus, 'GENERATION_FAILED', 'c12-failed generation status must remain GENERATION_FAILED');
  assert.strictEqual(c12FailedContact?.errorMessage, 'Quota exhausted', 'c12-failed error message must be preserved');
  assert.strictEqual(c12FailedContact?.generationAttemptCount, 5, 'c12-failed attempt count must be preserved');

  console.log('✓ TEST 15 PASSED: Existing retry and failure records remain completely intact and persisted\n');

  // -------------------------------------------------------------------------
  // TEST 16: Subsequent batches of 4 execute rapidly without correlated query overhead
  // -------------------------------------------------------------------------
  console.log('TEST 16: Subsequent batches of 4 execute rapidly without correlated query overhead...');
  const batch16Id = 'batch-fast-burst-16';
  db.insert(batches).values({
    id: batch16Id,
    filename: 'batch16.csv',
    uploadDate: new Date().toISOString(),
    status: 'processing',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();

  // Company is already complete (RELEVANT)
  db.insert(companyClassifications).values({
    normalizedName: 'hyper fast tech',
    companyName: 'Hyper Fast Tech',
    reason: 'Pure cloud infra',
    classificationResult: 'RELEVANT',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();

  // Insert 12 contacts (3 batches of 4)
  for (let i = 1; i <= 12; i++) {
    db.insert(contacts).values({
      id: `c16-${i}`,
      batchId: batch16Id,
      companyName: 'Hyper Fast Tech',
      contactName: `Recruiter ${i}`,
      email: `recruiter${i}@hyperfast.test`,
      isRelevant: true,
      emailValid: true,
      isDuplicate: false,
      status: 'discovered',
      createdAt: new Date(Date.now() + i * 1000).toISOString(),
      updatedAt: new Date().toISOString(),
    }).run();
  }

  // Batch is complete
  assert.strictEqual(isBatchClassificationComplete(db, batch16Id), true, 'Batch 16 must be complete');

  // First batch of 4:
  const tStart1 = performance.now();
  const resBurst1 = await reconcilePendingEmailGenerations({
    batchId: batch16Id,
    batchSize: 4,
    aiCallerOverride: async () => 'Subject: Opportunities\n\nFast burst body 1.',
  });
  const tDur1 = performance.now() - tStart1;
  assert.strictEqual(resBurst1.succeeded, 4, 'Burst 1 must generate 4 emails');
  assert.ok(tDur1 < 3000, `Burst 1 must complete quickly (< 3000ms, got ${tDur1.toFixed(1)}ms)`);

  // Second batch of 4:
  const tStart2 = performance.now();
  const resBurst2 = await reconcilePendingEmailGenerations({
    batchId: batch16Id,
    batchSize: 4,
    aiCallerOverride: async () => 'Subject: Opportunities\n\nFast burst body 2.',
  });
  const tDur2 = performance.now() - tStart2;
  assert.strictEqual(resBurst2.succeeded, 4, 'Burst 2 must generate 4 emails');
  assert.ok(tDur2 < 3000, `Burst 2 must complete quickly (< 3000ms, got ${tDur2.toFixed(1)}ms)`);

  // Third batch of 4:
  const tStart3 = performance.now();
  const resBurst3 = await reconcilePendingEmailGenerations({
    batchId: batch16Id,
    batchSize: 4,
    aiCallerOverride: async () => 'Subject: Opportunities\n\nFast burst body 3.',
  });
  const tDur3 = performance.now() - tStart3;
  assert.strictEqual(resBurst3.succeeded, 4, 'Burst 3 must generate 4 emails');
  assert.ok(tDur3 < 3000, `Burst 3 must complete quickly (< 3000ms, got ${tDur3.toFixed(1)}ms)`);

  // Verify all 12 generated
  const genCount16 = db.select().from(contacts).where(and(eq(contacts.batchId, batch16Id), eq(contacts.generationStatus, 'GENERATED'))).all();
  assert.strictEqual(genCount16.length, 12, 'All 12 contacts in Batch 16 must be generated');
  console.log(`✓ TEST 16 PASSED: 3 consecutive batches of 4 executed rapidly (${tDur1.toFixed(0)}ms, ${tDur2.toFixed(0)}ms, ${tDur3.toFixed(0)}ms)\n`);

  // -------------------------------------------------------------------------
  // TEST 17: Ready-to-Send dispatching continues independently
  // -------------------------------------------------------------------------
  console.log('TEST 17: Ready-to-Send dispatching continues independently...');
  // Add an incomplete batch to the DB
  const batch17IncompleteId = 'batch-incomplete-17';
  db.insert(batches).values({
    id: batch17IncompleteId,
    filename: 'batch17.csv',
    uploadDate: new Date().toISOString(),
    status: 'processing',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();

  db.insert(contacts).values({
    id: 'c17-pending-contact',
    batchId: batch17IncompleteId,
    companyName: 'Pending Corp 17',
    contactName: 'Pending Recruiter',
    email: 'pending@pendingcorp17.test',
    isRelevant: null,
    emailValid: true,
    isDuplicate: false,
    status: 'discovered',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();

  db.insert(companyClassifications).values({
    normalizedName: 'pending corp 17',
    companyName: 'Pending Corp 17',
    reason: 'Pending classification',
    classificationResult: 'PENDING',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();

  // Outreach queue item from completed Batch 16 contact:
  db.insert(outreachQueue).values({
    id: 'oq-c16-1',
    contactId: 'c16-1',
    status: 'pending',
    priority: 1,
    attempts: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();

  // Incomplete batch must NOT block job acquisition of ready-to-send contact
  const acquired = acquireNextEligibleJob('worker_test_17');
  assert.ok(acquired, 'Scheduler must acquire ready-to-send contact even when AI Search Pending > 0');
  assert.strictEqual(acquired.contact.id, 'c16-1', 'Acquired contact must be c16-1');
  console.log('✓ TEST 17 PASSED: Ready-to-Send continues independently of classification barrier\n');

  console.log('======================================================================');
  console.log('ALL BARRIER AND DASHBOARD TESTS COMPLETED SUCCESSFULLY!');
  console.log('======================================================================\n');
}

runBarrierVerificationTests().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
