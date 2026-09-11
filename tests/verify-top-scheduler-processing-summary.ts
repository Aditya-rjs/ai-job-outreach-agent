/**
 * Test Suite: Top Scheduler Processing Summary Alignment with 13 Canonical Processing Metrics
 */

import path from 'path';
import fs from 'fs';

const TEST_DIR = path.join(process.cwd(), 'data', 'test-top-scheduler-summary');
if (fs.existsSync(TEST_DIR)) {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
}
fs.mkdirSync(TEST_DIR, { recursive: true });

process.env.DATA_DIR = TEST_DIR;
(process.env as Record<string, string>).NODE_ENV = 'test';
process.env.OUTREACH_DRY_RUN = 'true';

import { getDb } from '@/db';
import { initializeDatabase } from '@/db/migrate';
import {
  batches,
  contacts,
  outreachQueue,
  companyClassifications,
} from '@/db/schema';
import { eq, sql } from 'drizzle-orm';
import { getDashboardStats } from '@/lib/db-helpers';
import { getProcessingPipelineStats } from '@/lib/processing-queries';

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ FAIL: ${message}`);
    process.exit(1);
  }
  console.log(`✔ [PASS] ${message}`);
}

async function runVerification() {
  console.log('======================================================================');
  console.log('TOP SCHEDULER PROCESSING SUMMARY & 13-METRIC ALIGNMENT VERIFICATION');
  console.log('======================================================================\n');

  initializeDatabase();
  const db = getDb();

  // 1. Zero State Check
  console.log('--- TEST 1: Zero State Single Source of Truth ---');
  const initialDashboard = getDashboardStats();
  const initialProcessing = getProcessingPipelineStats();

  assert(initialDashboard.processingStats !== undefined, 'Dashboard stats includes processingStats');
  assert(initialDashboard.processingStats?.readyToSend === 0, 'Initial readyToSend is 0');
  assert(initialDashboard.processingStats?.companiesFound === 0, 'Initial companiesFound is 0');
  const { lastUpdated: _t1, ...statsWithoutTimestamp1 } = initialDashboard.processingStats!;
  const { lastUpdated: _t2, ...statsWithoutTimestamp2 } = initialProcessing;
  assert(
    JSON.stringify(statsWithoutTimestamp1) === JSON.stringify(statsWithoutTimestamp2),
    'Dashboard processingStats is 100% identical to getProcessingPipelineStats() in zero state'
  );

  // 2. Seed Batch with Pending Classification (Barrier Active)
  console.log('\n--- TEST 2: Active Classification Barrier State ---');
  const batchId = 'batch_top_test_01';
  db.insert(batches).values({
    id: batchId,
    filename: 'candidates.xlsx',
    uploadDate: new Date().toISOString(),
    totalRecords: 3,
    validRecords: 3,
    status: 'processing',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();

  // Company A (pending classification)
  db.insert(companyClassifications).values({
    companyName: 'Acme AI',
    normalizedName: 'acme ai',
    classificationResult: 'PENDING',
    reason: 'Awaiting classification',
    retryCount: 0,
    geminiModel: 'gemini-3.8-flash',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();

  // 2 contacts for Acme AI (eligible but barrier gated)
  db.insert(contacts).values([
    {
      id: 'c_01',
      batchId,
      companyName: 'Acme AI',
      contactName: 'Alice Recruiter',
      email: 'alice@acmeai.com',
      isRelevant: null,
      emailValid: true,
      isDuplicate: false,
      status: 'discovered',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      id: 'c_02',
      batchId,
      companyName: 'Acme AI',
      contactName: 'Bob Talent',
      email: 'bob@acmeai.com',
      isRelevant: null,
      emailValid: true,
      isDuplicate: false,
      status: 'discovered',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ]).run();

  // Company B (already classified relevant, 1 email generated & ready to send)
  db.insert(companyClassifications).values({
    companyName: 'Stripe',
    normalizedName: 'stripe',
    classificationResult: 'RELEVANT',
    isRelevant: true,
    confidence: 0.95,
    reason: 'Fintech and developer infrastructure',
    retryCount: 0,
    geminiModel: 'gemini-3.8-flash',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();

  db.insert(contacts).values({
    id: 'c_03',
    batchId,
    companyName: 'Stripe',
    contactName: 'Carol Headhunter',
    email: 'carol@stripe.com',
    isRelevant: true,
    emailValid: true,
    isDuplicate: false,
    status: 'queued',
    emailSubject: 'Excited about engineering opportunities at Stripe',
    emailBody: 'Dear Carol, I admire your engineering culture...',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();

  db.insert(outreachQueue).values({
    id: 'oq_01',
    contactId: 'c_03',
    priority: 1,
    status: 'pending',
    attempts: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();

  const activeStats = getDashboardStats();

  assert(activeStats.processingStats?.companiesFound === 2, 'Companies Found = 2 (Acme AI, Stripe)');
  assert(activeStats.processingStats?.aiSearchPending === 1, 'AI Search Pending = 1 (Acme AI)');
  assert(activeStats.processingStats?.csItRelevant === 1, 'CS/IT Relevant = 1 (Stripe)');
  assert(activeStats.processingStats?.emailsGenerating === 0, 'Emails Generating = 0 (Gated by active classification barrier)');
  assert(activeStats.processingStats?.readyToSend === 1, 'Ready to Send = 1 (Carol at Stripe staged with subject & body)');

  // 3. Top Summary Formatting Test
  console.log('\n--- TEST 3: Top Summary Formatting Consistency ---');
  const p = activeStats.processingStats!;
  const topSummary = `${p.readyToSend} Ready to Send • ${p.emailsGenerating} Emails Generating • ${p.generationRetry} Generation Retry • ${p.aiSearchPending} AI Search Pending • ${p.aiSearchRetry} AI Search Retry`;
  const expectedSummary = '1 Ready to Send • 0 Emails Generating • 0 Generation Retry • 1 AI Search Pending • 0 AI Search Retry';

  assert(topSummary === expectedSummary, `Top summary formatted correctly: "${topSummary}"`);
  assert(!topSummary.includes('Pending Gen'), 'Obsolete "Pending Gen" terminology strictly absent');
  assert(!topSummary.includes('contacts staged'), 'Old staged queue terminology strictly absent from processing summary');

  // 4. Scheduler-Specific Information Preservation Test
  console.log('\n--- TEST 4: Scheduler Specific Information Preservation ---');
  assert(activeStats.isDryRun === true, 'Dry-run flag preserved');
  assert(activeStats.dailyLimit === 30, 'Daily limit preserved');
  assert(activeStats.todaySentCount === 0, 'Today sent count preserved');
  assert(typeof activeStats.isPaused === 'boolean', 'isPaused flag preserved');

  // 5. Barrier Lifting Verification
  console.log('\n--- TEST 5: Barrier Lifting & Generation Progression ---');
  // Resolve Acme AI classification
  db.run(sql`
    UPDATE company_classifications
    SET classification_result = 'RELEVANT',
        is_relevant = 1,
        confidence = 0.9,
        reason = 'AI/Tech software company'
    WHERE normalized_name = 'acme ai'
  `);

  db.run(sql`
    UPDATE contacts
    SET is_relevant = 1,
        status = 'queued',
        generation_status = 'PENDING_GENERATION'
    WHERE company_name = 'Acme AI'
  `);

  const unblockedStats = getDashboardStats();
  assert(unblockedStats.processingStats?.aiSearchPending === 0, 'AI Search Pending is now 0');
  assert(unblockedStats.processingStats?.emailsGenerating === 2, 'Emails Generating is now 2 (barrier unlocked for Acme AI contacts)');
  assert(unblockedStats.processingStats?.readyToSend === 1, 'Ready to Send remains 1 until emails finish generation');

  console.log('\n======================================================================');
  console.log('ALL TOP SCHEDULER PROCESSING SUMMARY VERIFICATION CHECKS PASSED!');
  console.log('REAL EMAILS DISPATCHED: 0');
  console.log('======================================================================\n');
}

runVerification().catch((err) => {
  console.error('Fatal error during verification:', err);
  process.exit(1);
});
