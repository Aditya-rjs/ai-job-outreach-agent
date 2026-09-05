/**
 * Comprehensive Verification Suite for Interactive Clickable Dashboard Cards
 *
 * Verifies:
 * 1. Exact 1:1 mathematical equality across all 7 dashboard cards:
 *    - totalCompanies == /api/dashboard/companies?type=all total
 *    - relevantCompanies == /api/dashboard/companies?type=relevant total
 *    - totalContacts == /api/contacts?view=contacts-found total
 *    - emailsQueued == /api/contacts?view=eligible-queued total
 *    - emailsGenerated == /api/contacts?view=emails-generated total
 *    - emailsSent == /api/contacts?view=emails-sent total
 *    - emailsSkipped == /api/contacts?view=skipped-filtered total
 * 2. Deleted batch exclusion invariant across all 7 metrics.
 * 3. Search and server-side pagination consistency.
 * 4. Sendability state resolution (READY, GENERATING, PENDING_GENERATION).
 * 5. Authoritative real Gmail send history vs simulated sends separation.
 * 6. Zero emails dispatched and zero quota consumed.
 */

import path from 'path';
import fs from 'fs';

// Isolated scratch database for testing
const TEST_DIR = path.join(process.cwd(), 'data', 'test-dashboard-cards');
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
import { getDashboardStats } from '@/lib/db-helpers';
import {
  getTotalCompaniesCount,
  getTotalCompaniesList,
  getRelevantCompaniesCount,
  getRelevantCompaniesList,
  getTotalContactsCount,
  getTotalContactsList,
  getEligibleQueuedCount,
  getEligibleQueuedList,
  getEmailsGeneratedCount,
  getEmailsGeneratedList,
  getEmailsSentCount,
  getEmailsSentList,
  getEmailsSkippedCount,
  getEmailsSkippedList,
} from '@/lib/dashboard-queries';

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
  console.log('INTERACTIVE DASHBOARD STATISTICS CARDS & DETAIL VIEWS VERIFICATION');
  console.log('======================================================================\n');

  resetDbConnection();
  initializeDatabase();
  const db = getDb();

  const nowIso = new Date().toISOString();
  const pastIso = new Date(Date.now() - 3600000).toISOString();

  // --- Seed Data Setup ---
  const activeBatchId = 'batch_active_01';
  const deletedBatchId = 'batch_deleted_01';

  db.insert(batches)
    .values([
      {
        id: activeBatchId,
        filename: 'active_candidates.csv',
        uploadDate: nowIso,
        status: 'queued',
        createdAt: nowIso,
        updatedAt: nowIso,
      },
      {
        id: deletedBatchId,
        filename: 'deleted_candidates.csv',
        uploadDate: nowIso,
        status: 'deleted',
        createdAt: nowIso,
        updatedAt: nowIso,
      },
    ])
    .run();

  // Seed company classifications
  db.insert(companyClassifications)
    .values([
      {
        normalizedName: 'infosys',
        companyName: 'Infosys',
        isRelevant: true,
        confidence: 0.98,
        reason: 'Global IT consulting and custom enterprise software development.',
        classificationSource: 'gemini',
        geminiModel: 'gemini-3.8-flash',
        classificationResult: 'RELEVANT',
        createdAt: nowIso,
        updatedAt: nowIso,
      },
      {
        normalizedName: 'tredence',
        companyName: 'Tredence Analytics',
        isRelevant: true,
        confidence: 0.96,
        reason: 'Enterprise AI and data analytics consulting firm.',
        classificationSource: 'gemini',
        geminiModel: 'gemini-3.8-flash',
        classificationResult: 'RELEVANT',
        createdAt: nowIso,
        updatedAt: nowIso,
      },
      {
        normalizedName: 'acme cement',
        companyName: 'Acme Cement Ltd',
        isRelevant: false,
        confidence: 0.99,
        reason: 'Heavy construction materials manufacturing.',
        classificationSource: 'gemini',
        geminiModel: 'gemini-3.8-flash',
        classificationResult: 'IRRELEVANT',
        createdAt: nowIso,
        updatedAt: nowIso,
      },
      {
        normalizedName: 'pending inc',
        companyName: 'Pending Inc',
        isRelevant: null,
        confidence: null,
        reason: 'Classification pending',
        classificationSource: 'gemini',
        geminiModel: 'gemini-3.8-flash',
        classificationResult: 'PENDING',
        createdAt: nowIso,
        updatedAt: nowIso,
      },
    ])
    .run();

  // Seed contacts
  // 1. Infosys contact with GENERATED email, queued in outreach_queue (READY)
  const contactReadyId = 'c_ready_01';
  db.insert(contacts)
    .values({
      id: contactReadyId,
      batchId: activeBatchId,
      companyName: 'Infosys',
      contactName: 'Aarav Mehta',
      email: 'aarav.mehta@infosys.com',
      isRelevant: true,
      relevanceConfidence: 0.98,
      relevanceReason: 'Global IT consulting',
      isDuplicate: false,
      emailValid: true,
      status: 'queued',
      generationStatus: 'GENERATED',
      emailSubject: 'Software Engineering Opportunities at Infosys — Aditya Raj Singh',
      emailBody: 'Dear Aarav, I am writing to express my interest in software engineering roles at Infosys...',
      emailStrategy: 'direct',
      createdAt: nowIso,
      updatedAt: nowIso,
    })
    .run();

  db.insert(outreachQueue)
    .values({
      id: 'q_ready_01',
      contactId: contactReadyId,
      priority: 10,
      status: 'pending',
      attempts: 0,
      createdAt: nowIso,
      updatedAt: nowIso,
    })
    .run();

  // 2. Infosys contact with PENDING_GENERATION (PENDING_GENERATION)
  const contactPendingGenId = 'c_pending_gen_01';
  db.insert(contacts)
    .values({
      id: contactPendingGenId,
      batchId: activeBatchId,
      companyName: 'Infosys',
      contactName: 'Neha Sharma',
      email: 'neha.sharma@infosys.com',
      isRelevant: true,
      relevanceConfidence: 0.98,
      relevanceReason: 'Global IT consulting',
      isDuplicate: false,
      emailValid: true,
      status: 'queued',
      generationStatus: 'PENDING_GENERATION',
      createdAt: nowIso,
      updatedAt: nowIso,
    })
    .run();

  db.insert(outreachQueue)
    .values({
      id: 'q_pending_gen_01',
      contactId: contactPendingGenId,
      priority: 5,
      status: 'pending',
      attempts: 0,
      createdAt: nowIso,
      updatedAt: nowIso,
    })
    .run();

  // 3. Tredence contact with GENERATING (GENERATING)
  const contactGeneratingId = 'c_generating_01';
  db.insert(contacts)
    .values({
      id: contactGeneratingId,
      batchId: activeBatchId,
      companyName: 'Tredence Analytics',
      contactName: 'Rohit Verma',
      email: 'rohit.verma@tredence.com',
      isRelevant: true,
      relevanceConfidence: 0.96,
      relevanceReason: 'Enterprise AI and data analytics',
      isDuplicate: false,
      emailValid: true,
      status: 'generating',
      generationStatus: 'GENERATING',
      createdAt: nowIso,
      updatedAt: nowIso,
    })
    .run();

  db.insert(outreachQueue)
    .values({
      id: 'q_generating_01',
      contactId: contactGeneratingId,
      priority: 5,
      status: 'pending',
      attempts: 0,
      createdAt: nowIso,
      updatedAt: nowIso,
    })
    .run();

  // 4. Acme Cement contact - Irrelevant (SKIPPED)
  const contactIrrelevantId = 'c_irrelevant_01';
  db.insert(contacts)
    .values({
      id: contactIrrelevantId,
      batchId: activeBatchId,
      companyName: 'Acme Cement Ltd',
      contactName: 'Suresh Patel',
      email: 'suresh@acmecement.com',
      isRelevant: false,
      relevanceConfidence: 0.99,
      relevanceReason: 'Gemini classified company as irrelevant (heavy materials)',
      isDuplicate: false,
      emailValid: true,
      status: 'skipped',
      createdAt: nowIso,
      updatedAt: nowIso,
    })
    .run();

  // 5. In-file duplicate contact (SKIPPED)
  const contactDuplicateId = 'c_dup_01';
  db.insert(contacts)
    .values({
      id: contactDuplicateId,
      batchId: activeBatchId,
      companyName: 'Infosys',
      contactName: 'Aarav Mehta Dup',
      email: 'aarav.mehta@infosys.com',
      isRelevant: null,
      relevanceReason: 'Duplicate: email already appears in this file.',
      isDuplicate: true,
      emailValid: true,
      status: 'skipped',
      createdAt: nowIso,
      updatedAt: nowIso,
    })
    .run();

  // 6. Real sent contact (SENT - Real Gmail Send)
  const contactRealSentId = 'c_real_sent_01';
  const realSentEmail = 'talent.lead@infosys.com';
  db.insert(contacts)
    .values({
      id: contactRealSentId,
      batchId: activeBatchId,
      companyName: 'Infosys',
      contactName: 'Talent Lead',
      email: realSentEmail,
      isRelevant: true,
      isDuplicate: false,
      emailValid: true,
      status: 'sent',
      sentAt: pastIso,
      gmailMessageId: 'gmail_msg_live_789xyz',
      emailSubject: 'Application for Software Engineer',
      emailBody: 'Dear Team, please find attached my resume.',
      createdAt: pastIso,
      updatedAt: pastIso,
    })
    .run();

  // Authoritative history entry for real send
  db.insert(globalEmailHistory)
    .values({
      email: realSentEmail,
      firstContactId: contactRealSentId,
      firstBatchId: activeBatchId,
      firstSeenAt: pastIso,
      sentAt: pastIso,
      status: 'sent',
    })
    .run();

  // 7. Simulated sent contact (SIMULATED - Dry Run)
  const contactSimulatedId = 'c_sim_01';
  db.insert(contacts)
    .values({
      id: contactSimulatedId,
      batchId: activeBatchId,
      companyName: 'Tredence Analytics',
      contactName: 'Sim Lead',
      email: 'sim.lead@tredence.com',
      isRelevant: true,
      isDuplicate: false,
      emailValid: true,
      status: 'simulated',
      sentAt: null,
      gmailMessageId: 'simulated_msg_001',
      emailSubject: 'Application for Data Engineer',
      emailBody: 'Simulated body',
      createdAt: pastIso,
      updatedAt: pastIso,
    })
    .run();

  // 8. Contact in DELETED batch (Must NEVER be counted in any active metric!)
  const contactDeletedBatchId = 'c_del_batch_01';
  db.insert(contacts)
    .values({
      id: contactDeletedBatchId,
      batchId: deletedBatchId,
      companyName: 'Phantom Corp',
      contactName: 'Ghost Contact',
      email: 'ghost@phantom.com',
      isRelevant: true,
      status: 'queued',
      createdAt: nowIso,
      updatedAt: nowIso,
    })
    .run();

  // =========================================================================
  // TEST 1: The Seven Exact Equalities
  // =========================================================================
  console.log('--- Test 1: Seven Exact Equalities ---');
  const dashboard = getDashboardStats();

  // Card 1: Total Companies
  const totalCompaniesList = getTotalCompaniesList({ limit: 100 });
  assert(
    dashboard.totalCompanies === totalCompaniesList.total,
    `Card 1 Total Companies equality: dashboard (${dashboard.totalCompanies}) === api.total (${totalCompaniesList.total})`
  );
  assert(
    totalCompaniesList.companies.length === totalCompaniesList.total,
    `Card 1 records returned (${totalCompaniesList.companies.length}) equals total (${totalCompaniesList.total})`
  );
  assert(
    dashboard.totalCompanies === 3,
    `Card 1 exactly 3 active distinct companies: Infosys, Tredence Analytics, Acme Cement Ltd`
  );

  // Card 2: Relevant Tech
  const relevantCompaniesList = getRelevantCompaniesList({ limit: 100 });
  assert(
    dashboard.relevantCompanies === relevantCompaniesList.total,
    `Card 2 Relevant Tech equality: dashboard (${dashboard.relevantCompanies}) === api.total (${relevantCompaniesList.total})`
  );
  assert(
    relevantCompaniesList.companies.length === relevantCompaniesList.total,
    `Card 2 records returned (${relevantCompaniesList.companies.length}) equals total (${relevantCompaniesList.total})`
  );
  assert(
    dashboard.relevantCompanies === 2,
    `Card 2 exactly 2 relevant companies: Infosys and Tredence Analytics`
  );

  // Card 3: Contacts Found
  const totalContactsList = getTotalContactsList({ limit: 100 });
  assert(
    dashboard.totalContacts === totalContactsList.total,
    `Card 3 Contacts Found equality: dashboard (${dashboard.totalContacts}) === api.total (${totalContactsList.total})`
  );
  assert(
    totalContactsList.contacts.length === totalContactsList.total,
    `Card 3 records returned (${totalContactsList.contacts.length}) equals total (${totalContactsList.total})`
  );
  assert(
    dashboard.totalContacts === 7,
    `Card 3 exactly 7 contacts from active batches (1 deleted batch contact strictly excluded)`
  );

  // Card 4: Eligible Queued
  const eligibleQueuedList = getEligibleQueuedList({ limit: 100 });
  assert(
    dashboard.emailsQueued === eligibleQueuedList.total,
    `Card 4 Eligible Queued equality: dashboard (${dashboard.emailsQueued}) === api.total (${eligibleQueuedList.total})`
  );
  assert(
    eligibleQueuedList.contacts.length === eligibleQueuedList.total,
    `Card 4 records returned (${eligibleQueuedList.contacts.length}) equals total (${eligibleQueuedList.total})`
  );
  assert(
    dashboard.emailsQueued === 3,
    `Card 4 exactly 3 eligible queued contacts (c_ready_01, c_pending_gen_01, c_generating_01)`
  );

  // Card 5: Emails Generated
  const emailsGeneratedList = getEmailsGeneratedList({ limit: 100 });
  assert(
    dashboard.emailsGenerated === emailsGeneratedList.total,
    `Card 5 Emails Generated equality: dashboard (${dashboard.emailsGenerated}) === api.total (${emailsGeneratedList.total})`
  );
  assert(
    emailsGeneratedList.contacts.length === emailsGeneratedList.total,
    `Card 5 records returned (${emailsGeneratedList.contacts.length}) equals total (${emailsGeneratedList.total})`
  );
  assert(
    dashboard.emailsGenerated === 1,
    `Card 5 exactly 1 generated contact with populated subject/body (c_ready_01)`
  );

  // Card 6: Emails Sent (Real Gmail Sends)
  const emailsSentRealList = getEmailsSentList({ mode: 'real', limit: 100 });
  assert(
    dashboard.emailsSent === emailsSentRealList.total,
    `Card 6 Emails Sent equality: dashboard (${dashboard.emailsSent}) === api.total (${emailsSentRealList.total})`
  );
  assert(
    emailsSentRealList.contacts.length === emailsSentRealList.total,
    `Card 6 records returned (${emailsSentRealList.contacts.length}) equals total (${emailsSentRealList.total})`
  );
  assert(
    dashboard.emailsSent === 1,
    `Card 6 exactly 1 authoritative real Gmail send (c_real_sent_01)`
  );

  // Card 7: Skipped / Filtered
  const emailsSkippedList = getEmailsSkippedList({ limit: 100 });
  assert(
    dashboard.emailsSkipped === emailsSkippedList.total,
    `Card 7 Skipped / Filtered equality: dashboard (${dashboard.emailsSkipped}) === api.total (${emailsSkippedList.total})`
  );
  assert(
    emailsSkippedList.contacts.length === emailsSkippedList.total,
    `Card 7 records returned (${emailsSkippedList.contacts.length}) equals total (${emailsSkippedList.total})`
  );
  assert(
    dashboard.emailsSkipped === 2,
    `Card 7 exactly 2 skipped contacts: 1 irrelevant company + 1 in-file duplicate`
  );

  // =========================================================================
  // TEST 2: Deleted Batch Invariant
  // =========================================================================
  console.log('\n--- Test 2: Deleted Batch Invariant ---');
  const allCompanies = totalCompaniesList.companies.map((c) => c.companyName);
  assert(!allCompanies.includes('Phantom Corp'), 'Phantom Corp from deleted batch is NOT in Total Companies');

  const allContactsEmails = totalContactsList.contacts.map((c) => c.email);
  assert(!allContactsEmails.includes('ghost@phantom.com'), 'Ghost contact from deleted batch is NOT in Contacts Found');

  // =========================================================================
  // TEST 3: Search and Pagination
  // =========================================================================
  console.log('\n--- Test 3: Search and Pagination ---');
  const infosysSearch = getTotalCompaniesList({ search: 'Infosys' });
  assert(infosysSearch.total === 1, 'Search for "Infosys" yields exactly 1 company');
  assert(infosysSearch.companies[0].companyName === 'Infosys', 'Found company name matches');

  const emailSearch = getTotalContactsList({ search: 'rohit' });
  assert(emailSearch.total === 1, 'Search for contact "rohit" yields exactly 1 contact');
  assert(emailSearch.contacts[0].contactName === 'Rohit Verma', 'Found contact name matches');

  const pagedList = getTotalContactsList({ page: 1, limit: 3 });
  assert(pagedList.contacts.length === 3, 'Pagination page size of 3 respected');
  assert(pagedList.total === 7, 'Total records count preserved during pagination');

  // =========================================================================
  // TEST 4: Sendability State Computation
  // =========================================================================
  console.log('\n--- Test 4: Sendability State Computation ---');
  const readyItem = eligibleQueuedList.contacts.find((c) => c.id === contactReadyId);
  assert(readyItem?.sendabilityStatus === 'READY', 'Contact with generated email has sendabilityStatus = READY');

  const genItem = eligibleQueuedList.contacts.find((c) => c.id === contactGeneratingId);
  assert(genItem?.sendabilityStatus === 'GENERATING', 'Contact in generation has sendabilityStatus = GENERATING');

  const pendingGenItem = eligibleQueuedList.contacts.find((c) => c.id === contactPendingGenId);
  assert(
    pendingGenItem?.sendabilityStatus === 'PENDING_GENERATION',
    'Contact awaiting generation has sendabilityStatus = PENDING_GENERATION'
  );

  // =========================================================================
  // TEST 5: Real vs Simulated Send Isolation
  // =========================================================================
  console.log('\n--- Test 5: Real vs Simulated Send Isolation ---');
  const simulatedList = getEmailsSentList({ mode: 'simulated' });
  assert(simulatedList.total === 1, 'Simulated mode returns exactly 1 simulated contact');
  assert(simulatedList.contacts[0].id === contactSimulatedId, 'Simulated contact ID matches');
  assert(emailsSentRealList.total === 1, 'Real send mode returns exactly 1 real contact');
  assert(emailsSentRealList.contacts[0].id === contactRealSentId, 'Real send contact ID matches');

  // =========================================================================
  // TEST 6: Absolute Outreach Invariant (0 Dispatches, Quota Intact)
  // =========================================================================
  console.log('\n--- Test 6: Outreach Safety Invariant ---');
  // Re-read dashboard stats after all views and queries have been executed
  const statsAfter = getDashboardStats();
  assert(
    statsAfter.todaySentCount === dashboard.todaySentCount,
    `Today sent count strictly unchanged: before (${dashboard.todaySentCount}) === after (${statsAfter.todaySentCount})`
  );
  assert(
    statsAfter.remainingToday === dashboard.remainingToday,
    `Daily send quota strictly unchanged: remaining (${statsAfter.remainingToday})`
  );

  console.log('\n======================================================================');
  console.log(`ALL DASHBOARD CARD TESTS PASSED: ${passCount}/${passCount + failCount}`);
  console.log('MATHEMATICAL EQUALITY ENFORCED ACROSS ALL 7 CARDS (100% CONSISTENT)');
  console.log('REAL RECRUITER EMAILS DISPATCHED: 0 (Strict Safety Guard Preserved)');
  console.log('======================================================================');
}

runTests().catch((err) => {
  console.error('\nVerification failed with error:', err);
  process.exit(1);
});
