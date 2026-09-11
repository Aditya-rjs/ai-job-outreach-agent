import { getDb } from '../src/db';
import { batches, contacts, companyClassifications, outreachQueue } from '../src/db/schema';
import { eq, sql } from 'drizzle-orm';
import {
  getProcessingPipelineStats,
  getCompaniesFoundList,
  getDuplicateCompaniesList,
  getClassificationPendingList,
  getClassificationRetryWaitingList,
  getAiProcessedList,
  getIrrelevantCompaniesList,
  getCsItRelevantList,
  getContactsFoundList,
  getDuplicateContactsList,
  getEmailGenerationPendingList,
  getGenerationRetryList,
  getGenerationFailedList,
  getReadyToSendList,
} from '../src/lib/processing-queries';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${msg}`);
    process.exit(1);
  }
  console.log(`✔ [PASS] ${msg}`);
}

async function runVerification() {
  console.log('======================================================================');
  console.log('BATCH DETAIL REDESIGN: 13-METRIC PROCESSING VERIFICATION SUITE');
  console.log('======================================================================\n');

  const db = getDb();
  const now = new Date().toISOString();

  const batchAId = `batch_detail_test_a_${Date.now()}`;
  const batchBId = `batch_detail_test_b_${Date.now()}`;
  const batchEmptyId = `batch_detail_test_empty_${Date.now()}`;

  // Clean up any stale test records
  db.delete(batches).where(sql`id LIKE 'batch_detail_test_%'`).run();

  try {
    // -------------------------------------------------------------------
    // 1. SEED TEST FIXTURES
    // -------------------------------------------------------------------
    console.log('--- 1. Seeding Multi-Batch Fixtures ---');

    // Batch A
    db.insert(batches).values({
      id: batchAId,
      filename: 'Batch_Alpha.xlsx',
      uploadDate: now,
      totalRecords: 8,
      validRecords: 8,
      status: 'processing',
      createdAt: now,
      updatedAt: now,
    }).run();

    // Batch B
    db.insert(batches).values({
      id: batchBId,
      filename: 'Batch_Beta.xlsx',
      uploadDate: now,
      totalRecords: 1,
      validRecords: 1,
      status: 'completed',
      createdAt: now,
      updatedAt: now,
    }).run();

    // Empty Batch
    db.insert(batches).values({
      id: batchEmptyId,
      filename: 'Batch_Empty.xlsx',
      uploadDate: now,
      totalRecords: 0,
      validRecords: 0,
      status: 'completed',
      createdAt: now,
      updatedAt: now,
    }).run();

    // Seed Company Classifications
    db.insert(companyClassifications).values([
      {
        normalizedName: 'pending tech',
        companyName: 'Pending Tech',
        classificationResult: 'PENDING',
        retryRound: 0,
        retryCount: 0,
        reason: 'Pending classification',
        classificationSource: 'gemini',
        geminiModel: 'gemini-3.8-flash',
        createdAt: now,
        updatedAt: now,
      },
      {
        normalizedName: 'retry tech',
        companyName: 'Retry Tech',
        classificationResult: 'RETRY_WAITING',
        retryRound: 1,
        retryCount: 2,
        lastErrorCategory: 'rate_limit',
        nextRetryAt: new Date(Date.now() + 60000).toISOString(),
        reason: 'Rate limit waiting',
        classificationSource: 'gemini',
        geminiModel: 'gemini-3.8-flash',
        createdAt: now,
        updatedAt: now,
      },
      {
        normalizedName: 'tesla motors',
        companyName: 'Tesla Motors',
        isRelevant: false,
        classificationResult: 'IRRELEVANT',
        confidence: 0.95,
        reason: 'Automotive manufacturing without CS/IT division in query',
        classificationSource: 'gemini',
        geminiModel: 'gemini-3.8-flash',
        createdAt: now,
        updatedAt: now,
      },
      {
        normalizedName: 'terminal tech',
        companyName: 'Terminal Tech',
        isRelevant: true,
        classificationResult: 'RELEVANT',
        confidence: 0.99,
        reason: 'Enterprise Cloud SaaS provider',
        classificationSource: 'gemini',
        geminiModel: 'gemini-3.8-flash',
        createdAt: now,
        updatedAt: now,
      },
      {
        normalizedName: 'failed tech',
        companyName: 'Failed Tech',
        isRelevant: true,
        classificationResult: 'RELEVANT',
        confidence: 0.98,
        reason: 'Enterprise security software',
        classificationSource: 'gemini',
        geminiModel: 'gemini-3.8-flash',
        createdAt: now,
        updatedAt: now,
      },
      {
        normalizedName: 'stripe',
        companyName: 'Stripe',
        isRelevant: true,
        classificationResult: 'RELEVANT',
        confidence: 1.0,
        reason: 'Financial infrastructure and payment APIs',
        classificationSource: 'gemini',
        geminiModel: 'gemini-3.8-flash',
        createdAt: now,
        updatedAt: now,
      },
      {
        normalizedName: 'batch b solitary corp',
        companyName: 'Batch B Solitary Corp',
        isRelevant: true,
        classificationResult: 'RELEVANT',
        confidence: 1.0,
        reason: 'Dedicated Batch B software consultancy',
        classificationSource: 'gemini',
        geminiModel: 'gemini-3.8-flash',
        createdAt: now,
        updatedAt: now,
      },
    ]).onConflictDoNothing().run();

    // Seed Batch A Contacts
    // Note: 'Stripe' and 'Stripe Inc' produce 2 raw companies with 1 duplicate company!
    const cStripe1Id = `c_stripe1_${Date.now()}`;
    const cStripe2Id = `c_stripe2_${Date.now()}`;
    const cStripeDupId = `c_stripe_dup_${Date.now()}`;
    const cTeslaId = `c_tesla_${Date.now()}`;
    const cPendingId = `c_pending_${Date.now()}`;
    const cRetryId = `c_retry_${Date.now()}`;
    const cTerminalId = `c_terminal_${Date.now()}`;
    const cFailedId = `c_failed_${Date.now()}`;

    db.insert(contacts).values([
      {
        id: cStripe1Id,
        batchId: batchAId,
        companyName: 'Stripe',
        contactName: 'Alice Recruiter',
        email: 'alice@stripe.com',
        designation: 'Tech Talent Lead',
        isRelevant: true,
        isDuplicate: false,
        emailValid: true,
        status: 'queued',
        generationStatus: 'PENDING_GENERATION',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: cStripe2Id,
        batchId: batchAId,
        companyName: 'Stripe Inc', // Variation that normalizes to 'stripe'
        contactName: 'Bob Recruiter',
        email: 'bob@stripe.com',
        designation: 'Engineering Manager',
        isRelevant: true,
        isDuplicate: false,
        emailValid: true,
        status: 'queued',
        generationStatus: 'PENDING_GENERATION',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: cStripeDupId,
        batchId: batchAId,
        companyName: 'Stripe',
        contactName: 'Bob Duplicate',
        email: 'bob@stripe.com', // Duplicate email
        isRelevant: true,
        isDuplicate: true,
        emailValid: true,
        status: 'skipped',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: cTeslaId,
        batchId: batchAId,
        companyName: 'Tesla Motors',
        contactName: 'Elon Manager',
        email: 'elon@tesla.com',
        isRelevant: false,
        isDuplicate: false,
        emailValid: true,
        status: 'skipped',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: cPendingId,
        batchId: batchAId,
        companyName: 'Pending Tech',
        contactName: 'Pat Pending',
        email: 'pat@pendingtech.com',
        isRelevant: null,
        isDuplicate: false,
        emailValid: true,
        status: 'discovered',
        generationStatus: null,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: cRetryId,
        batchId: batchAId,
        companyName: 'Retry Tech',
        contactName: 'Ron ClassRetry',
        email: 'ron@retrytech.com',
        isRelevant: null,
        isDuplicate: false,
        emailValid: true,
        status: 'discovered',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: `c_gen_retry_${Date.now()}`,
        batchId: batchAId,
        companyName: 'Terminal Tech',
        contactName: 'Gary GenRetry',
        email: 'gary@terminaltech.com',
        isRelevant: true,
        isDuplicate: false,
        emailValid: true,
        status: 'queued',
        generationStatus: 'RETRY_PENDING',
        generationAttemptCount: 2,
        lastGenerationErrorCategory: 'rate_limit',
        nextGenerationRetryAt: new Date(Date.now() + 60000).toISOString(),
        createdAt: now,
        updatedAt: now,
      },
      {
        id: cTerminalId,
        batchId: batchAId,
        companyName: 'Terminal Tech',
        contactName: 'Tom Ready',
        email: 'tom@terminaltech.com',
        isRelevant: true,
        isDuplicate: false,
        emailValid: true,
        status: 'generated',
        generationStatus: 'GENERATED',
        emailSubject: 'Excited about software engineering opportunities at Terminal Tech',
        emailBody: 'Dear Tom, I am reaching out regarding backend opportunities...',
        emailStrategy: 'direct',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: cFailedId,
        batchId: batchAId,
        companyName: 'Failed Tech',
        contactName: 'Fiona Failed',
        email: 'fiona@failedtech.com',
        isRelevant: true,
        isDuplicate: false,
        emailValid: true,
        status: 'failed',
        generationStatus: 'GENERATION_FAILED',
        generationAttemptCount: 5,
        errorMessage: 'Gemini rate limit exceeded repeatedly (Permanent Failover Exhausted)',
        createdAt: now,
        updatedAt: now,
      },
    ]).run();

    // Stage Terminal Tech in outreach_queue for ready-to-send
    db.insert(outreachQueue).values({
      id: `queue_${cTerminalId}`,
      contactId: cTerminalId,
      status: 'pending',
      priority: 10,
      createdAt: now,
      updatedAt: now,
    }).run();

    // Seed Batch B Contact (Strict Isolation)
    const cBatchBId = `c_batch_b_${Date.now()}`;
    db.insert(contacts).values({
      id: cBatchBId,
      batchId: batchBId,
      companyName: 'Batch B Solitary Corp',
      contactName: 'Solitary Recruiter',
      email: 'solitary@batchb.com',
      isRelevant: true,
      isDuplicate: false,
      emailValid: true,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
    }).run();

    console.log('✔ Fixtures seeded cleanly.');

    // -------------------------------------------------------------------
    // 2. VERIFY STATS FOR BATCH A (13 Canonical Metrics)
    // -------------------------------------------------------------------
    console.log('\n--- 2. Verifying Batch A Canonical Stats ---');
    const statsA = getProcessingPipelineStats(batchAId);

    assert(statsA.currentBatchId === batchAId, 'stats.currentBatchId matches requested batchId');
    assert(statsA.companiesFound === 7, `companiesFound = 7 (Got: ${statsA.companiesFound})`);
    assert(statsA.duplicateCompanies === 2, `duplicateCompanies = 2 (Got: ${statsA.duplicateCompanies})`);
    assert(statsA.aiSearchPending === 1, `aiSearchPending = 1 (Got: ${statsA.aiSearchPending})`);
    assert(statsA.aiProcessed === 5, `aiProcessed = 5 (Got: ${statsA.aiProcessed})`);
    assert(statsA.irrelevantCompanies === 1, `irrelevantCompanies = 1 (Got: ${statsA.irrelevantCompanies})`); // Tesla
    assert(statsA.csItRelevant === 4, `csItRelevant = 4 (Got: ${statsA.csItRelevant})`); // Terminal, Stripe, Stripe Inc, Failed Tech
    assert(statsA.contactsFound === 9, `contactsFound = 9 (Got: ${statsA.contactsFound})`);
    assert(statsA.duplicateContacts === 1, `duplicateContacts = 1 (Got: ${statsA.duplicateContacts})`);
    // Classification barrier active (pending=1, retry=1): emailsGenerating MUST be 0!
    assert(statsA.emailsGenerating === 0, `emailsGenerating = 0 due to classification barrier (Got: ${statsA.emailsGenerating})`);
    assert(statsA.generationRetry === 1, `generationRetry = 1 (Got: ${statsA.generationRetry})`);
    assert(statsA.generationFailed === 1, `generationFailed = 1 (Got: ${statsA.generationFailed})`);
    assert(statsA.readyToSend === 1, `readyToSend = 1 (Got: ${statsA.readyToSend})`);

    // -------------------------------------------------------------------
    // 3. VERIFY ALL 13 DETAIL QUERIES FOR BATCH A
    // -------------------------------------------------------------------
    console.log('\n--- 3. Verifying All 13 Detail Query Functions for Batch A ---');

    // 1. Companies Found
    const compFound = getCompaniesFoundList({ batchId: batchAId });
    assert(compFound.total === statsA.companiesFound, 'Companies Found detail total matches stats');
    assert(compFound.records.length === 7, 'Companies Found returns exactly 7 distinct raw company records');

    // 2. Duplicate Companies
    const dupComp = getDuplicateCompaniesList({ batchId: batchAId });
    assert(dupComp.total === statsA.duplicateCompanies, 'Duplicate Companies detail total matches stats');
    assert(dupComp.records.length === 2, 'Duplicate Companies returns 2 companies with multiple contacts');
    const compNames = dupComp.records.map((r) => r.companyName);
    assert(compNames.includes('Stripe') && compNames.includes('Terminal Tech'), 'Duplicate companies include Stripe and Terminal Tech');

    // 3. AI Search Pending
    const classPending = getClassificationPendingList({ batchId: batchAId });
    assert(classPending.total === statsA.aiSearchPending, 'AI Search Pending detail total matches stats');
    assert(classPending.records[0].companyName === 'Pending Tech', 'Pending record is "Pending Tech"');

    // 4. AI Search Retry
    const classRetry = getClassificationRetryWaitingList({ batchId: batchAId });
    assert(classRetry.total === statsA.aiSearchRetry, 'AI Search Retry detail total matches stats');
    assert(classRetry.records[0].companyName === 'Retry Tech', 'Retry record is "Retry Tech"');

    // 5. AI Processed
    const aiProc = getAiProcessedList({ batchId: batchAId });
    assert(aiProc.total === statsA.aiProcessed, 'AI Processed detail total matches stats');

    // 6. Irrelevant Companies
    const irrel = getIrrelevantCompaniesList({ batchId: batchAId });
    assert(irrel.total === statsA.irrelevantCompanies, 'Irrelevant Companies detail total matches stats');
    assert(irrel.records[0].companyName === 'Tesla Motors', 'Irrelevant record is "Tesla Motors"');

    // 7. CS/IT Relevant
    const csIt = getCsItRelevantList({ batchId: batchAId });
    assert(csIt.total === statsA.csItRelevant, 'CS/IT Relevant detail total matches stats');

    // 8. Contacts Found
    const contactsFound = getContactsFoundList({ batchId: batchAId });
    assert(contactsFound.total === statsA.contactsFound, 'Contacts Found detail total matches stats');
    assert(contactsFound.records.length === 9, 'Contacts Found returns all 9 contacts');

    // 9. Duplicate Contacts
    const dupContacts = getDuplicateContactsList({ batchId: batchAId });
    assert(dupContacts.total === statsA.duplicateContacts, 'Duplicate Contacts detail total matches stats');
    assert(dupContacts.records[0].email === 'bob@stripe.com', 'Duplicate contact is bob@stripe.com');

    // 10. Emails Generating (Barrier Gated)
    const genPending = getEmailGenerationPendingList({ batchId: batchAId });
    assert(genPending.total === 0, 'Emails Generating is 0 while barrier is active');
    assert(genPending.records.length === 0, 'Emails Generating returns 0 records while barrier is active');

    // 11. Generation Retry
    const genRetry = getGenerationRetryList({ batchId: batchAId });
    assert(genRetry.total === statsA.generationRetry, 'Generation Retry detail total matches stats');
    assert(genRetry.records[0].email === 'gary@terminaltech.com', 'Retry contact is gary@terminaltech.com');

    // 12. Generation Failed
    const genFailed = getGenerationFailedList({ batchId: batchAId });
    assert(genFailed.total === statsA.generationFailed, 'Generation Failed detail total matches stats');
    assert(genFailed.records[0].email === 'fiona@failedtech.com', 'Failed contact is fiona@failedtech.com');
    assert(Boolean(genFailed.records[0].errorMessage?.includes('rate limit')), 'Failure record contains error diagnostic');

    // 13. Ready to Send
    const readySend = getReadyToSendList({ batchId: batchAId });
    assert(readySend.total === statsA.readyToSend, 'Ready to Send detail total matches stats');
    assert(readySend.records[0].email === 'tom@terminaltech.com', 'Ready contact is tom@terminaltech.com');
    assert(readySend.records[0].emailSubject.includes('software engineering'), 'Ready contact has subject line');

    // -------------------------------------------------------------------
    // 4. VERIFY STRICT MULTI-BATCH ISOLATION (Batch A vs Batch B)
    // -------------------------------------------------------------------
    console.log('\n--- 4. Verifying Multi-Batch Isolation ---');
    const statsB = getProcessingPipelineStats(batchBId);

    assert(statsB.currentBatchId === batchBId, 'statsB scoped to batchBId');
    assert(statsB.companiesFound === 1, `Batch B companiesFound = 1 (Got: ${statsB.companiesFound})`);
    assert(statsB.duplicateCompanies === 0, 'Batch B duplicateCompanies = 0');
    assert(statsB.aiSearchPending === 0, 'Batch B aiSearchPending = 0');
    assert(statsB.aiSearchRetry === 0, 'Batch B aiSearchRetry = 0');
    assert(statsB.contactsFound === 1, 'Batch B contactsFound = 1');

    // Verify detail query for Batch B never contains Batch A data
    const compFoundB = getCompaniesFoundList({ batchId: batchBId });
    assert(compFoundB.total === 1, 'Batch B has exactly 1 company in detail');
    assert(compFoundB.records[0].companyName === 'Batch B Solitary Corp', 'Batch B company is "Batch B Solitary Corp"');

    const contactsB = getContactsFoundList({ batchId: batchBId });
    assert(contactsB.total === 1, 'Batch B has exactly 1 contact in detail');
    assert(contactsB.records[0].email === 'solitary@batchb.com', 'Batch B contact is solitary@batchb.com');

    // Check that NO Batch A company ever appears in Batch B
    const allBatchBCompanyNames = compFoundB.records.map((r) => r.companyName);
    assert(!allBatchBCompanyNames.includes('Stripe'), 'Stripe from Batch A never leaks into Batch B');
    assert(!allBatchBCompanyNames.includes('Tesla Motors'), 'Tesla Motors from Batch A never leaks into Batch B');
    assert(!allBatchBCompanyNames.includes('Pending Tech'), 'Pending Tech from Batch A never leaks into Batch B');

    // -------------------------------------------------------------------
    // 5. VERIFY ZERO-STATE BATCH BEHAVIOR
    // -------------------------------------------------------------------
    console.log('\n--- 5. Verifying Zero State Batch ---');
    const statsEmpty = getProcessingPipelineStats(batchEmptyId);
    assert(statsEmpty.companiesFound === 0, 'Empty batch companiesFound = 0');
    assert(statsEmpty.contactsFound === 0, 'Empty batch contactsFound = 0');
    assert(statsEmpty.readyToSend === 0, 'Empty batch readyToSend = 0');

    const compEmpty = getCompaniesFoundList({ batchId: batchEmptyId });
    assert(compEmpty.total === 0 && compEmpty.records.length === 0, 'Empty batch companies detail returns 0 records');

    const dupCompEmpty = getDuplicateCompaniesList({ batchId: batchEmptyId });
    assert(dupCompEmpty.total === 0 && dupCompEmpty.records.length === 0, 'Empty batch duplicate companies detail returns 0 records');

    // -------------------------------------------------------------------
    // 6. VERIFY BARRIER UNLOCKING FOR EMAILS GENERATING
    // -------------------------------------------------------------------
    console.log('\n--- 6. Verifying Barrier Lifting for Emails Generating ---');
    // Complete the classifications in Batch A so pending = 0 and retry = 0
    db.update(companyClassifications)
      .set({ classificationResult: 'RELEVANT', isRelevant: true })
      .where(sql`normalized_name IN ('pending tech', 'retry tech')`)
      .run();

    const statsAAfter = getProcessingPipelineStats(batchAId);
    assert(statsAAfter.aiSearchPending === 0, 'After update: aiSearchPending = 0');
    assert(statsAAfter.aiSearchRetry === 0, 'After update: aiSearchRetry = 0');
    assert(statsAAfter.emailsGenerating > 0, `After update: emailsGenerating unblocked (>0, Got: ${statsAAfter.emailsGenerating})`);

    const genPendingAfter = getEmailGenerationPendingList({ batchId: batchAId });
    assert(genPendingAfter.total > 0, `Emails Generating detail unblocked (>0, Got: ${genPendingAfter.total})`);
    assert(genPendingAfter.records.some((r) => r.email === 'alice@stripe.com'), 'Eligible contact alice@stripe.com present in generation detail');

    console.log('\n======================================================================');
    console.log('ALL 5 BATCH DETAIL REDESIGN VERIFICATION CRITERIA PASSED SUCCESSFULLY!');
    console.log('======================================================================\n');
  } finally {
    // Clean up test batches
    db.delete(outreachQueue).where(sql`contact_id IN (SELECT id FROM contacts WHERE batch_id LIKE 'batch_detail_test_%')`).run();
    db.delete(contacts).where(sql`batch_id LIKE 'batch_detail_test_%'`).run();
    db.delete(batches).where(sql`id LIKE 'batch_detail_test_%'`).run();
    db.delete(companyClassifications).where(sql`normalized_name IN ('pending tech', 'retry tech', 'tesla motors', 'terminal tech', 'batch b solitary corp')`).run();
  }
}

runVerification().catch((err) => {
  console.error('Fatal error during batch detail redesign verification:', err);
  process.exit(1);
});
