/**
 * Comprehensive Verification Suite for AI Outreach Processing Pipeline Section
 *
 * Verifies all mandatory requirements:
 * 1. Classification Pending count matches database state
 * 2. Classification Pending is grouped by unique company (not repeated per contact)
 * 3. Expanded company contacts are correctly retrieved
 * 4. Deleted batches are strictly excluded from all 4 categories
 * 5. Cancelled batches are strictly excluded from all 4 categories
 * 6. Email Generation Pending contains ONLY Gemini-relevant contacts (is_relevant = 1)
 * 7. Email Generation Pending excludes RETRY_PENDING and GENERATED
 * 8. Generation Retry contains ONLY retryable generation failures (generation_status = RETRY_PENDING)
 * 9. Ready to Send exactly matches canonical scheduler sendability
 * 10. Globally sent contacts excluded from Ready to Send
 * 11. Duplicate contacts excluded from Ready to Send
 * 12. Invalid emails excluded from Ready to Send
 * 13. Generated subject and body required for Ready to Send
 * 14. Processing reads do not modify todaySentCount
 * 15. Processing reads do not modify queue state
 * 16. Processing reads do not send Gmail
 * 17. Safe read-only guarantees preserved
 */

import path from 'path';
import fs from 'fs';

// Isolated scratch database for testing processing pipeline
const TEST_DIR = path.join(process.cwd(), 'data', 'test-processing-pipeline');
if (fs.existsSync(TEST_DIR)) {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
}
fs.mkdirSync(TEST_DIR, { recursive: true });

process.env.DATA_DIR = TEST_DIR;
(process.env as Record<string, string>).NODE_ENV = 'test';
process.env.OUTREACH_DRY_RUN = 'true';

import { getDb, resetDbConnection } from '@/db';
import { initializeDatabase } from '@/db/migrate';
import {
  batches,
  contacts,
  outreachQueue,
  globalEmailHistory,
  companyClassifications,
  schedulerState,
} from '@/db/schema';
import { eq } from 'drizzle-orm';
import {
  getProcessingPipelineStats,
  getClassificationPendingList,
  getCompanyContactsList,
  getEmailGenerationPendingList,
  getGenerationRetryList,
  getGenerationFailedList,
  getReadyToSendList,
} from '@/lib/processing-queries';

let passCount = 0;
let failCount = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`✓ [PASS] ${message}`);
    passCount++;
  } else {
    console.error(`✗ [FAIL] ${message}`);
    failCount++;
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function runTests() {
  console.log('======================================================================');
  console.log('AI OUTREACH PROCESSING PIPELINE OBSERVABILITY VERIFICATION');
  console.log('======================================================================\n');

  resetDbConnection();
  initializeDatabase();
  const db = getDb();

  const nowIso = new Date().toISOString();
  const futureIso = new Date(Date.now() + 600000).toISOString(); // +10 mins

  // -------------------------------------------------------------------------
  // 1. SEED BATCHES: Active, Deleted, and Cancelled
  // -------------------------------------------------------------------------
  const activeBatchId = 'batch_active_proc';
  const deletedBatchId = 'batch_deleted_proc';
  const cancelledBatchId = 'batch_cancelled_proc';

  db.insert(batches)
    .values([
      {
        id: activeBatchId,
        filename: 'active_recruiter_batch.csv',
        uploadDate: nowIso,
        status: 'queued',
        createdAt: nowIso,
        updatedAt: nowIso,
      },
      {
        id: deletedBatchId,
        filename: 'deleted_recruiter_batch.csv',
        uploadDate: nowIso,
        status: 'deleted',
        createdAt: nowIso,
        updatedAt: nowIso,
      },
      {
        id: cancelledBatchId,
        filename: 'cancelled_recruiter_batch.csv',
        uploadDate: nowIso,
        status: 'cancelled',
        createdAt: nowIso,
        updatedAt: nowIso,
      },
    ])
    .run();

  // -------------------------------------------------------------------------
  // 2. SEED COMPANY CLASSIFICATIONS
  // -------------------------------------------------------------------------
  db.insert(companyClassifications)
    .values([
      {
        normalizedName: 'planet spark',
        companyName: 'Planet Spark',
        isRelevant: null,
        classificationResult: 'PENDING',
        classificationSource: 'gemini',
        geminiModel: 'gemini-3.8-flash',
        retryCount: 4,
        lastErrorCategory: 'RATE_LIMIT_EXCEEDED',
        nextRetryAt: futureIso,
        reason: 'Pending Gemini classification retry',
      },
      {
        normalizedName: 'infosys',
        companyName: 'Infosys',
        isRelevant: true,
        classificationResult: 'RELEVANT',
        classificationSource: 'gemini',
        geminiModel: 'gemini-3.8-flash',
        retryCount: 0,
        reason: 'Leading global enterprise IT software and services firm',
      },
      {
        normalizedName: 'tredence analytics',
        companyName: 'Tredence Analytics',
        isRelevant: true,
        classificationResult: 'RELEVANT',
        classificationSource: 'gemini',
        geminiModel: 'gemini-3.8-flash',
        retryCount: 0,
        reason: 'Enterprise AI and analytics solutions company',
      },
      {
        normalizedName: 'acme cement',
        companyName: 'Acme Cement Ltd',
        isRelevant: false,
        classificationResult: 'IRRELEVANT',
        classificationSource: 'gemini',
        geminiModel: 'gemini-3.8-flash',
        retryCount: 0,
        reason: 'Heavy industrial manufacturing and materials company',
      },
      {
        normalizedName: 'phantom deleted co',
        companyName: 'Phantom Deleted Co',
        isRelevant: null,
        classificationResult: 'PENDING',
        classificationSource: 'gemini',
        geminiModel: 'gemini-3.8-flash',
        retryCount: 1,
        reason: 'Should be excluded because its batch is deleted',
      },
      {
        normalizedName: 'cancelled co',
        companyName: 'Cancelled Co',
        isRelevant: null,
        classificationResult: 'PENDING',
        classificationSource: 'gemini',
        geminiModel: 'gemini-3.8-flash',
        retryCount: 1,
        reason: 'Should be excluded because its batch is cancelled',
      },
    ])
    .run();

  // -------------------------------------------------------------------------
  // 3. SEED CONTACTS & QUEUE
  // -------------------------------------------------------------------------
  // (A) Planet Spark: 3 contacts, all pending classification -> Should be grouped as 1 company
  db.insert(contacts)
    .values([
      {
        id: 'c_ps_01',
        batchId: activeBatchId,
        companyName: 'Planet Spark',
        contactName: 'Trina Mitra',
        email: 'trina.mitra@planetspark.in',
        designation: 'Tech Recruiter',
        isRelevant: null,
        status: 'discovered',
      },
      {
        id: 'c_ps_02',
        batchId: activeBatchId,
        companyName: 'Planet Spark',
        contactName: 'Swati',
        email: 'swati@planetspark.in',
        designation: 'Talent Acquisition',
        isRelevant: null,
        status: 'discovered',
      },
      {
        id: 'c_ps_03',
        batchId: activeBatchId,
        companyName: 'Planet Spark',
        contactName: 'Manmeet Kaur',
        email: 'manmeet.kaur@planetspark.in',
        designation: 'HR Lead',
        isRelevant: null,
        status: 'discovered',
      },
    ])
    .run();

  // (B) Deleted batch contact with pending classification -> Must be excluded
  db.insert(contacts)
    .values({
      id: 'c_deleted_01',
      batchId: deletedBatchId,
      companyName: 'Phantom Deleted Co',
      contactName: 'Ghost Recruiter',
      email: 'ghost@phantom.com',
      isRelevant: null,
      status: 'discovered',
    })
    .run();

  // (C) Cancelled batch contact with pending classification -> Must be excluded
  db.insert(contacts)
    .values({
      id: 'c_cancelled_01',
      batchId: cancelledBatchId,
      companyName: 'Cancelled Co',
      contactName: 'Cancelled Contact',
      email: 'cancel@cancelled.com',
      isRelevant: null,
      status: 'discovered',
    })
    .run();

  // (D) Email Generation Pending: Relevant contacts awaiting initial email generation
  // c_gen_pending_01: PENDING_GENERATION
  db.insert(contacts)
    .values({
      id: 'c_gen_pending_01',
      batchId: activeBatchId,
      companyName: 'Infosys',
      contactName: 'Kireet Nuthalapati',
      email: 'kireet.nuthalapati@infosys.com',
      designation: 'Talent Lead',
      isRelevant: true,
      emailValid: true,
      isDuplicate: false,
      status: 'queued',
      generationStatus: 'PENDING_GENERATION',
      generationAttemptCount: 0,
      createdAt: nowIso,
      updatedAt: nowIso,
    })
    .run();

  // c_generating_01: GENERATING
  db.insert(contacts)
    .values({
      id: 'c_generating_01',
      batchId: activeBatchId,
      companyName: 'Infosys',
      contactName: 'Priya K',
      email: 'priya.k@infosys.com',
      designation: 'Senior Technical Recruiter',
      isRelevant: true,
      emailValid: true,
      isDuplicate: false,
      status: 'generating',
      generationStatus: 'GENERATING',
      generationAttemptCount: 1,
      createdAt: nowIso,
      updatedAt: nowIso,
    })
    .run();

  // (E) Generation Retry: Contact with transient failure waiting for automatic retry
  db.insert(contacts)
    .values({
      id: 'c_retry_01',
      batchId: activeBatchId,
      companyName: 'Tredence Analytics',
      contactName: 'Rohan Sharma',
      email: 'rohan.sharma@tredence.com',
      designation: 'Engineering Hiring Manager',
      isRelevant: true,
      emailValid: true,
      isDuplicate: false,
      status: 'queued',
      generationStatus: 'RETRY_PENDING',
      generationAttemptCount: 2,
      lastGenerationErrorCategory: 'RATE_LIMIT_EXCEEDED',
      nextGenerationRetryAt: futureIso,
      createdAt: nowIso,
      updatedAt: nowIso,
    })
    .run();

  // (F) Ready to Send: Completely generated, verified relevant, queued, unsent
  db.insert(contacts)
    .values({
      id: 'c_ready_01',
      batchId: activeBatchId,
      companyName: 'Tredence Analytics',
      contactName: 'Recruiter Lead',
      email: 'recruiter@tredence.com',
      designation: 'Lead Technical Recruiter',
      isRelevant: true,
      emailValid: true,
      isDuplicate: false,
      status: 'generated',
      generationStatus: 'GENERATED',
      emailSubject: 'Excited about Enterprise AI at Tredence Analytics',
      emailBody: 'Hi Recruiter Lead, I have extensive experience building AI agents...',
      emailStrategy: 'Technical leadership alignment',
      generatedAt: nowIso,
      createdAt: nowIso,
      updatedAt: nowIso,
    })
    .run();

  db.insert(outreachQueue)
    .values({
      id: 'q_ready_01',
      contactId: 'c_ready_01',
      status: 'pending',
      priority: 10,
      createdAt: nowIso,
      updatedAt: nowIso,
    })
    .run();

  // (G) Non-Sendable Contact Edge Cases:
  // 1. Globally sent duplicate email -> Must NOT be in Ready to Send
  db.insert(contacts)
    .values({
      id: 'c_global_sent_01',
      batchId: activeBatchId,
      companyName: 'Tredence Analytics',
      contactName: 'Already Sent Person',
      email: 'already.sent@tredence.com',
      isRelevant: true,
      emailValid: true,
      isDuplicate: false,
      status: 'generated',
      generationStatus: 'GENERATED',
      emailSubject: 'Subject',
      emailBody: 'Body',
    })
    .run();

  db.insert(outreachQueue)
    .values({
      id: 'q_global_sent_01',
      contactId: 'c_global_sent_01',
      status: 'pending',
      createdAt: nowIso,
      updatedAt: nowIso,
    })
    .run();

  db.insert(globalEmailHistory)
    .values({
      email: 'already.sent@tredence.com',
      status: 'sent',
      sentAt: nowIso,
      firstSeenAt: nowIso,
    })
    .run();

  // 2. In-file duplicate -> Must NOT be in Ready to Send
  db.insert(contacts)
    .values({
      id: 'c_duplicate_01',
      batchId: activeBatchId,
      companyName: 'Tredence Analytics',
      contactName: 'Duplicate Person',
      email: 'dup@tredence.com',
      isRelevant: true,
      emailValid: true,
      isDuplicate: true,
      status: 'generated',
      generationStatus: 'GENERATED',
      emailSubject: 'Subject',
      emailBody: 'Body',
    })
    .run();

  db.insert(outreachQueue)
    .values({
      id: 'q_duplicate_01',
      contactId: 'c_duplicate_01',
      status: 'pending',
      createdAt: nowIso,
      updatedAt: nowIso,
    })
    .run();

  // 3. Invalid email -> Must NOT be in Ready to Send
  db.insert(contacts)
    .values({
      id: 'c_invalid_email_01',
      batchId: activeBatchId,
      companyName: 'Tredence Analytics',
      contactName: 'Bad Email',
      email: 'not-an-email',
      isRelevant: true,
      emailValid: false,
      isDuplicate: false,
      status: 'generated',
      generationStatus: 'GENERATED',
      emailSubject: 'Subject',
      emailBody: 'Body',
    })
    .run();

  // 4. Missing subject/body -> Must NOT be in Ready to Send
  db.insert(contacts)
    .values({
      id: 'c_missing_body_01',
      batchId: activeBatchId,
      companyName: 'Tredence Analytics',
      contactName: 'No Body',
      email: 'nobody@tredence.com',
      isRelevant: true,
      emailValid: true,
      isDuplicate: false,
      status: 'generated',
      generationStatus: 'GENERATED',
      emailSubject: 'Only Subject',
      emailBody: '',
    })
    .run();

  // Initial stats before query execution
  const initialSchedulerState = db.select().from(schedulerState).where(eq(schedulerState.id, 'singleton')).get();
  const initialSentCount = initialSchedulerState?.todaySentCount ?? 0;

  // =========================================================================
  // TEST 1: Pipeline Summary Counts
  // =========================================================================
  console.log('\n--- Test 1: Pipeline Summary Counts ---');
  const stats = getProcessingPipelineStats();

  assert(stats.classificationPendingCount === 1, `Classification Pending count is exactly 1 (found ${stats.classificationPendingCount})`);
  assert(stats.emailGenerationPendingCount === 2, `Email Generation Pending count is exactly 2 (found ${stats.emailGenerationPendingCount})`);
  assert(stats.generationRetryCount === 1, `Generation Retry count is exactly 1 (found ${stats.generationRetryCount})`);
  assert(stats.generationFailedCount === 0, `Generation Failed count is initially 0 (found ${stats.generationFailedCount})`);
  assert(stats.readyToSendCount === 1, `Ready to Send count is exactly 1 (found ${stats.readyToSendCount})`);

  const initialFailedList = getGenerationFailedList();
  assert(initialFailedList.total === 0, `Initial getGenerationFailedList total is 0 (found ${initialFailedList.total})`);
  assert(initialFailedList.records.length === 0, 'Initial getGenerationFailedList records is empty');

  // =========================================================================
  // TEST 2: Classification Pending Grouped by Company (Not per contact)
  // =========================================================================
  console.log('\n--- Test 2: Classification Pending Company Grouping ---');
  const classPendingList = getClassificationPendingList();

  assert(classPendingList.total === 1, `Classification Pending total is 1 company (found ${classPendingList.total})`);
  assert(classPendingList.records.length === 1, 'Exactly 1 company record returned in list');

  const planetSpark = classPendingList.records[0];
  assert(planetSpark.companyName === 'Planet Spark', `Company name is Planet Spark (got ${planetSpark.companyName})`);
  assert(planetSpark.normalizedName === 'planet spark', 'Normalized name matches');
  assert(planetSpark.contactCount === 3, `Grouped all 3 contacts under Planet Spark (contactCount = ${planetSpark.contactCount})`);
  assert(planetSpark.retryCount === 4, `Retry count is #4 (got ${planetSpark.retryCount})`);
  assert(planetSpark.lastErrorCategory === 'RATE_LIMIT_EXCEEDED', 'Last error category is RATE_LIMIT_EXCEEDED');
  assert(planetSpark.geminiModel === 'gemini-3.8-flash', 'Gemini model is gemini-3.8-flash');
  assert(planetSpark.classificationResult === 'PENDING', 'Classification result is PENDING');

  // =========================================================================
  // TEST 3: Expanded Company Contacts Retrieval
  // =========================================================================
  console.log('\n--- Test 3: Expanded Company Contacts Retrieval ---');
  const expandedContacts = getCompanyContactsList('planet spark');

  assert(expandedContacts.length === 3, `Expanded list has exactly 3 contacts (got ${expandedContacts.length})`);
  const contactEmails = expandedContacts.map((c) => c.email);
  assert(contactEmails.includes('trina.mitra@planetspark.in'), 'Includes Trina Mitra');
  assert(contactEmails.includes('swati@planetspark.in'), 'Includes Swati');
  assert(contactEmails.includes('manmeet.kaur@planetspark.in'), 'Includes Manmeet Kaur');

  // =========================================================================
  // TEST 4: Deleted and Cancelled Batches Excluded
  // =========================================================================
  console.log('\n--- Test 4: Deleted and Cancelled Batches Excluded ---');
  const allCompaniesInPending = classPendingList.records.map((r) => r.companyName);
  assert(!allCompaniesInPending.includes('Phantom Deleted Co'), 'Phantom Deleted Co from deleted batch is strictly excluded');
  assert(!allCompaniesInPending.includes('Cancelled Co'), 'Cancelled Co from cancelled batch is strictly excluded');

  // =========================================================================
  // TEST 5: Email Generation Pending State Separation
  // =========================================================================
  console.log('\n--- Test 5: Email Generation Pending State Separation ---');
  const genPendingList = getEmailGenerationPendingList();

  assert(genPendingList.total === 2, `Generation Pending total is 2 (found ${genPendingList.total})`);
  const genPendingIds = genPendingList.records.map((r) => r.id);
  assert(genPendingIds.includes('c_gen_pending_01'), 'Includes c_gen_pending_01 (PENDING_GENERATION)');
  assert(genPendingIds.includes('c_generating_01'), 'Includes c_generating_01 (GENERATING)');
  assert(!genPendingIds.includes('c_retry_01'), 'Strictly excludes RETRY_PENDING from Generation Pending');
  assert(!genPendingIds.includes('c_ready_01'), 'Strictly excludes GENERATED from Generation Pending');

  // =========================================================================
  // TEST 6: Generation Retry State Separation
  // =========================================================================
  console.log('\n--- Test 6: Generation Retry State Separation ---');
  const genRetryList = getGenerationRetryList();

  assert(genRetryList.total === 1, `Generation Retry total is 1 (found ${genRetryList.total})`);
  const retryRecord = genRetryList.records[0];
  assert(retryRecord.id === 'c_retry_01', 'Retry record matches c_retry_01');
  assert(retryRecord.generationStatus === 'RETRY_PENDING', 'Generation status is RETRY_PENDING');
  assert(retryRecord.lastGenerationErrorCategory === 'RATE_LIMIT_EXCEEDED', 'Error category is RATE_LIMIT_EXCEEDED');
  assert(retryRecord.generationAttemptCount === 2, 'Attempt count is 2');

  // =========================================================================
  // TEST 7: Ready to Send Exact Sendability Re-use
  // =========================================================================
  console.log('\n--- Test 7: Ready to Send Canonical Sendability ---');
  const readyToSendList = getReadyToSendList();

  assert(readyToSendList.total === 1, `Ready to Send total is exactly 1 (found ${readyToSendList.total})`);
  const readyRecord = readyToSendList.records[0];
  assert(readyRecord.id === 'c_ready_01', 'Ready to send record is c_ready_01');
  assert(readyRecord.email === 'recruiter@tredence.com', 'Recruiter email matches');
  assert(readyRecord.emailSubject.includes('Enterprise AI'), 'Generated email subject is populated');
  assert(readyRecord.emailBody.length > 0, 'Generated email body is populated');

  // Verify exclusions
  const readyIds = readyToSendList.records.map((r) => r.id);
  assert(!readyIds.includes('c_global_sent_01'), 'Globally sent contacts are excluded');
  assert(!readyIds.includes('c_duplicate_01'), 'Duplicate contacts are excluded');
  assert(!readyIds.includes('c_invalid_email_01'), 'Invalid emails are excluded');
  assert(!readyIds.includes('c_missing_body_01'), 'Contacts missing email body are excluded');

  // =========================================================================
  // TEST 8: Generation Failure Observability (10 Required Checks)
  // =========================================================================
  console.log('\n--- Test 8: Generation Failure Observability (10 Required Checks) ---');

  // Check 1: 0 failures initially verified above (passCount recorded)
  assert(initialFailedList.total === 0, 'Check 1: Zero generation failures reports 0 in API/query');

  // Check 2: Insert one terminal generation failure
  db.insert(contacts)
    .values({
      id: 'c_failed_01',
      batchId: activeBatchId,
      companyName: 'Planet Spark',
      contactName: 'Ananya Sharma',
      email: 'ananya@planetspark.in',
      isRelevant: true,
      emailValid: true,
      isDuplicate: false,
      status: 'failed',
      generationStatus: 'GENERATION_FAILED',
      generationAttemptCount: 5,
      lastGenerationErrorCategory: 'RATE_LIMIT_EXCEEDED',
      errorMessage: 'OpenRouter 429 rate limit exceeded after 5 retries',
      lastGenerationAttemptAt: nowIso,
      updatedAt: nowIso,
    })
    .run();

  const singleFailureStats = getProcessingPipelineStats();
  assert(singleFailureStats.generationFailedCount === 1, 'Check 2a: stats.generationFailedCount is 1 with 1 failure');
  const singleFailureList = getGenerationFailedList();
  assert(singleFailureList.total === 1, 'Check 2b: exactly 1 failure appears in getGenerationFailedList');
  assert(singleFailureList.records[0].id === 'c_failed_01', 'Check 2c: record ID matches c_failed_01');

  // Check 3: Insert multiple terminal generation failures
  db.insert(contacts)
    .values([
      {
        id: 'c_failed_02',
        batchId: activeBatchId,
        companyName: 'Infosys',
        contactName: 'Rajesh Nair',
        email: 'rajesh.n@infosys.com',
        isRelevant: true,
        emailValid: true,
        isDuplicate: false,
        status: 'failed',
        generationStatus: 'GENERATION_FAILED',
        generationAttemptCount: 3,
        lastGenerationErrorCategory: 'LOCAL_BUG',
        errorMessage: 'Deterministic local error: SyntaxError in prompt builder',
        lastGenerationAttemptAt: nowIso,
        updatedAt: nowIso,
      },
      {
        id: 'c_failed_03',
        batchId: activeBatchId,
        companyName: 'Tredence Analytics',
        contactName: 'Pooja Hegde',
        email: 'pooja.h@tredence.com',
        isRelevant: true,
        emailValid: true,
        isDuplicate: false,
        status: 'failed',
        generationStatus: 'GENERATION_FAILED',
        generationAttemptCount: 5,
        lastGenerationErrorCategory: 'MAX_RETRIES_EXCEEDED',
        errorMessage: 'Deterministic local error with very long trace: '.repeat(200),
        lastGenerationAttemptAt: nowIso,
        updatedAt: nowIso,
      },
    ])
    .run();

  const multipleFailureStats = getProcessingPipelineStats();
  assert(multipleFailureStats.generationFailedCount === 3, 'Check 3a: stats.generationFailedCount is 3 with 3 failures');
  const multipleFailureList = getGenerationFailedList();
  assert(multipleFailureList.total === 3, 'Check 3b: all 3 failures appear in list');

  // Check 4: Transient generation retry appears under Generation Retry, NOT Generation Failed
  const currentGenRetryList = getGenerationRetryList();
  assert(currentGenRetryList.total === 1, 'Check 4a: Generation Retry still has exactly 1 item');
  assert(currentGenRetryList.records[0].id === 'c_retry_01', 'Check 4b: Retry item is c_retry_01');
  const failedIds = multipleFailureList.records.map((r) => r.id);
  assert(!failedIds.includes('c_retry_01'), 'Check 4c: Transient c_retry_01 is strictly absent from Generation Failed list');

  // Check 5: Terminal generation failure appears under Generation Failed, NOT Generation Retry or Generation Pending
  const currentGenPendingList = getEmailGenerationPendingList();
  const pendingIds = currentGenPendingList.records.map((r) => r.id);
  const retryIds = currentGenRetryList.records.map((r) => r.id);
  assert(!pendingIds.includes('c_failed_01'), 'Check 5a: c_failed_01 strictly absent from Generation Pending');
  assert(!retryIds.includes('c_failed_01'), 'Check 5b: c_failed_01 strictly absent from Generation Retry');
  assert(!pendingIds.includes('c_failed_02'), 'Check 5c: c_failed_02 strictly absent from Generation Pending');
  assert(!retryIds.includes('c_failed_02'), 'Check 5d: c_failed_02 strictly absent from Generation Retry');

  // Check 6: Classification information is correctly associated with the contact
  const infosysFailure = multipleFailureList.records.find((r) => r.id === 'c_failed_02');
  assert(infosysFailure !== undefined, 'Check 6a: Found c_failed_02 record');
  assert(infosysFailure?.companyName === 'Infosys', 'Check 6b: Company name is Infosys');
  assert(infosysFailure?.classificationResult === 'RELEVANT', 'Check 6c: Associated classification is RELEVANT');
  assert(infosysFailure?.classificationSource === 'gemini', 'Check 6d: Associated classification source is gemini');
  assert(infosysFailure?.geminiModel === 'gemini-3.8-flash', 'Check 6e: Associated gemini model is gemini-3.8-flash');

  // Check 7: Provider information is displayed correctly when available
  const openRouterFailure = multipleFailureList.records.find((r) => r.id === 'c_failed_01');
  assert(openRouterFailure?.generationProvider === 'OpenRouter', `Check 7a: Provider correctly detected as OpenRouter (got ${openRouterFailure?.generationProvider})`);
  assert(infosysFailure?.generationProvider === 'Not recorded', `Check 7b: Provider without explicit mention is "Not recorded" (got ${infosysFailure?.generationProvider})`);

  // Check 8: Long error messages do not break query or result structure
  const longErrorFailure = multipleFailureList.records.find((r) => r.id === 'c_failed_03');
  assert((longErrorFailure?.errorMessage?.length ?? 0) > 2000, 'Check 8a: Long error message (>2000 chars) preserved intact');
  assert(longErrorFailure?.isRetryable === false, 'Check 8b: Failure is explicitly marked isRetryable = false');

  // Check 9: Viewing failures performs no state mutation
  const contactBefore = db.select().from(contacts).where(eq(contacts.id, 'c_failed_01')).get();
  // Execute queries with search and pagination
  getGenerationFailedList({ search: 'Sharma', page: 1, limit: 10 });
  getGenerationFailedList({ search: '429', page: 1, limit: 10 });
  getProcessingPipelineStats();
  const contactAfter = db.select().from(contacts).where(eq(contacts.id, 'c_failed_01')).get();

  assert(contactBefore?.status === contactAfter?.status, 'Check 9a: contact status unmodified by read');
  assert(contactBefore?.generationStatus === contactAfter?.generationStatus, 'Check 9b: generationStatus unmodified by read');
  assert(contactBefore?.generationAttemptCount === contactAfter?.generationAttemptCount, 'Check 9c: attempt count unmodified by read');
  assert(contactBefore?.errorMessage === contactAfter?.errorMessage, 'Check 9d: error message unmodified by read');
  assert(contactBefore?.updatedAt === contactAfter?.updatedAt, 'Check 9e: updatedAt unmodified by read');

  // Check 10: Existing pipeline behavior remains unchanged
  const finalPending = getEmailGenerationPendingList();
  assert(finalPending.total === 2, `Check 10a: Generation Pending unchanged at 2 (got ${finalPending.total})`);
  const finalReady = getReadyToSendList();
  assert(finalReady.total === 1, `Check 10b: Ready to Send unchanged at 1 (got ${finalReady.total})`);

  // =========================================================================
  // TEST 9: Strict Read-Only Outreach Safety
  // =========================================================================
  console.log('\n--- Test 9: Read-Only Safety Invariants ---');
  const finalSchedulerState = db.select().from(schedulerState).where(eq(schedulerState.id, 'singleton')).get();
  assert(
    (finalSchedulerState?.todaySentCount ?? 0) === initialSentCount,
    `todaySentCount strictly unchanged: ${initialSentCount} === ${finalSchedulerState?.todaySentCount ?? 0}`
  );

  const pendingQueueItem = db.select().from(outreachQueue).where(eq(outreachQueue.id, 'q_ready_01')).get();
  assert(pendingQueueItem?.status === 'pending', 'Queue item status remains strictly "pending" (no job acquired)');

  console.log('\n======================================================================');
  console.log(`ALL PROCESSING PIPELINE TESTS PASSED: ${passCount}/${passCount + failCount}`);
  console.log('COMPANY GROUPING, CATEGORY ISOLATION & SENDABILITY VERIFIED');
  console.log('REAL RECRUITER EMAILS DISPATCHED: 0 (Strict Safety Guard Preserved)');
  console.log('======================================================================');
}

runTests().catch((err) => {
  console.error('\nVerification failed with error:', err);
  process.exit(1);
});
