import assert from 'assert';
import { getDb } from '../src/db';
import { batches, contacts, outreachQueue, companyClassifications, globalEmailHistory } from '../src/db/schema';
import { sql, eq, and } from 'drizzle-orm';
import { processBatchFile } from '../src/lib/pipeline/batch-processor';
import { getProcessingPipelineStats, getLatestActiveBatch, getReadyToSendList } from '../src/lib/processing-queries';
import { isBatchClassificationComplete } from '../src/lib/pipeline/classification-reconciler';
import { checkBatchCompletions } from '../src/lib/scheduler/queue-manager';

console.log('======================================================================');
console.log('VERIFY BATCH LIFECYCLE & GLOBAL READY TO SEND SPECIFICATION');
console.log('======================================================================\n');

const db = getDb();
const now = new Date().toISOString();
const runId = `test_cycle_${Date.now()}`;

function pass(msg: string) {
  console.log(`✔ [PASS] ${msg}`);
}

async function runTestSuite() {
  try {
    // -------------------------------------------------------------------------
    // TEST 1: Missing email vs unusual/custom domain emails
    // -------------------------------------------------------------------------
    console.log('--- TEST 1: Missing email skipped; unusual/custom domain emails accepted ---');
    // Batch with missing email records (should be terminal/skipped)
    const csvMissingEmails = 'Company Name,Email,Designation,Contact Name\nMissing Corp 1,,Engineer,Alice\nMissing Corp 2,   ,Director,Bob\n';
    const result1 = await processBatchFile(
      Buffer.from(csvMissingEmails, 'utf-8'),
      'missing_emails.csv'
    );
    const missingBatchId = result1.batchId;

    assert.strictEqual(result1.status, 'completed', 'Batch with all missing/blank email contacts should be marked completed');
    assert.strictEqual(result1.invalidEmails, 2, 'Should record 2 missing emails');

    // Verify contact row properties for missing emails
    const savedMissingContacts = db.select().from(contacts).where(eq(contacts.batchId, missingBatchId)).all();
    assert.strictEqual(savedMissingContacts.length, 2);
    for (const c of savedMissingContacts) {
      assert.strictEqual(c.emailValid, false, 'emailValid must be false for missing email');
      assert.strictEqual(c.isRelevant, null, 'isRelevant must be null (not false) for missing email');
      assert.strictEqual(c.status, 'skipped', 'status must be skipped');
      assert.strictEqual(c.relevanceReason, 'Skipped — Missing recipient email address.');
    }
    pass('Missing email contacts are saved with emailValid=false, isRelevant=null, status=skipped');

    // Batch with unusual / custom / private domain emails (should NOT be rejected)
    const csvUnusualEmails = 'Company Name,Email,Designation,Contact Name\nCustom Corp 1,someone@private-domain.xyz,Engineer,Charlie\nCustom Corp 2,founder@startup.ai,Founder,Diana\n';
    const resultUnusual = await processBatchFile(
      Buffer.from(csvUnusualEmails, 'utf-8'),
      'unusual_emails.csv'
    );
    const unusualBatchId = resultUnusual.batchId;

    assert.strictEqual(resultUnusual.status, 'processing', 'Batch with unclassified companies must be processing, never completed or queued prematurely');
    assert.strictEqual(resultUnusual.invalidEmails, 0, 'Unusual/custom emails must NOT be counted as invalid');

    const savedUnusualContacts = db.select().from(contacts).where(eq(contacts.batchId, unusualBatchId)).all();
    assert.strictEqual(savedUnusualContacts.length, 2);
    for (const c of savedUnusualContacts) {
      assert.strictEqual(c.emailValid, true, 'emailValid must be true for supplied email');
      assert.strictEqual(c.status, 'discovered', 'status must be discovered');
    }
    pass('Unusual/custom domain emails are accepted without syntax validation');

    // -------------------------------------------------------------------------
    // TEST 2: Missing/skipped contacts do not block classification barrier
    // -------------------------------------------------------------------------
    console.log('--- TEST 2: Missing/skipped contacts do not block classification barrier ---');
    const isComplete = isBatchClassificationComplete(db, missingBatchId);
    assert.strictEqual(isComplete, true, 'isBatchClassificationComplete must return true when only missing/skipped contacts exist');
    pass('Classification barrier is NOT blocked by missing/skipped contacts');

    // -------------------------------------------------------------------------
    // TEST 3: Completed batches excluded from getLatestActiveBatch()
    // -------------------------------------------------------------------------
    console.log('--- TEST 3: Completed batches excluded from getLatestActiveBatch() ---');
    // Ensure missingBatchId is completed
    const batchInDb = db.select().from(batches).where(eq(batches.id, missingBatchId)).get();
    assert.strictEqual(batchInDb?.status, 'completed');

    const latestActive = getLatestActiveBatch(db);
    // latestActive must NEVER be missingBatchId
    if (latestActive) {
      assert.notStrictEqual(latestActive.id, missingBatchId, 'Completed batch must not be selected as latest active batch');
    }
    pass('Completed batch is excluded from getLatestActiveBatch()');

    // -------------------------------------------------------------------------
    // TEST 4: Set up Batch A with 5 Ready to Send contacts and verify metrics
    // -------------------------------------------------------------------------
    console.log('--- TEST 4: Batch A with 5 Ready to Send contacts ---');
    const batchAId = `${runId}_batch_A`;
    db.insert(batches).values({
      id: batchAId,
      filename: 'Batch_A.csv',
      uploadDate: now,
      totalRecords: 5,
      validRecords: 5,
      relevantCompanies: 1,
      irrelevantCompanies: 0,
      duplicateContacts: 0,
      invalidEmails: 0,
      emailsPending: 0,
      status: 'queued',
      createdAt: new Date(Date.now() + 1000).toISOString(),
      updatedAt: now,
    }).run();

    // Mark company relevant
    db.insert(companyClassifications).values({
      companyName: 'Alpha Tech',
      normalizedName: 'alpha tech',
      classificationResult: 'RELEVANT',
      confidence: 1.0,
      reason: 'Tech company',
      retryCount: 0,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing().run();

    for (let i = 1; i <= 5; i++) {
      const cId = `${batchAId}_c${i}`;
      db.insert(contacts).values({
        id: cId,
        batchId: batchAId,
        companyName: 'Alpha Tech',
        contactName: `Alpha Contact ${i}`,
        email: `alpha${i}_${Date.now()}@example.com`,
        emailValid: true,
        isDuplicate: false,
        isRelevant: true,
        relevanceConfidence: 1.0,
        status: 'generated',
        generationStatus: 'GENERATED',
        emailSubject: `Opportunity ${i}`,
        emailBody: `Hello Alpha Contact ${i}`,
        createdAt: now,
        updatedAt: now,
      }).run();

      db.insert(outreachQueue).values({
        id: `queue_${cId}`,
        contactId: cId,
        status: 'pending',
        priority: 1,
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      }).run();
    }

    const statsAfterA = getProcessingPipelineStats();
    assert.strictEqual(statsAfterA.currentBatchId, batchAId, 'Batch A should be active batch');
    assert.strictEqual(statsAfterA.readyToSend >= 5, true, 'Ready to send should include at least the 5 from Batch A');
    assert.strictEqual(statsAfterA.companiesFound, 1, 'Batch A should have 1 company found');
    assert.strictEqual(statsAfterA.contactsFound, 5, 'Batch A should have 5 contacts found');
    pass('Batch A setup verified: 5 Ready to Send contacts');

    // -------------------------------------------------------------------------
    // TEST 5: Set up Batch B with 3 Ready to Send contacts -> Global Ready to Send increases by 3
    // -------------------------------------------------------------------------
    console.log('--- TEST 5: Set up Batch B with 3 Ready to Send contacts ---');
    const initialReadyCount = statsAfterA.readyToSend;
    const batchBId = `${runId}_batch_B`;
    db.insert(batches).values({
      id: batchBId,
      filename: 'Batch_B.csv',
      uploadDate: now,
      totalRecords: 3,
      validRecords: 3,
      relevantCompanies: 1,
      irrelevantCompanies: 0,
      duplicateContacts: 0,
      invalidEmails: 0,
      emailsPending: 0,
      status: 'queued',
      createdAt: new Date(Date.now() + 2000).toISOString(),
      updatedAt: now,
    }).run();

    db.insert(companyClassifications).values({
      companyName: 'Beta Systems',
      normalizedName: 'beta systems',
      classificationResult: 'RELEVANT',
      confidence: 1.0,
      reason: 'Tech company',
      retryCount: 0,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing().run();

    for (let i = 1; i <= 3; i++) {
      const cId = `${batchBId}_c${i}`;
      db.insert(contacts).values({
        id: cId,
        batchId: batchBId,
        companyName: 'Beta Systems',
        contactName: `Beta Contact ${i}`,
        email: `beta${i}_${Date.now()}@example.com`,
        emailValid: true,
        isDuplicate: false,
        isRelevant: true,
        relevanceConfidence: 1.0,
        status: 'generated',
        generationStatus: 'GENERATED',
        emailSubject: `Opportunity B ${i}`,
        emailBody: `Hello Beta Contact ${i}`,
        createdAt: now,
        updatedAt: now,
      }).run();

      db.insert(outreachQueue).values({
        id: `queue_${cId}`,
        contactId: cId,
        status: 'pending',
        priority: 1,
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      }).run();
    }

    const statsAfterB = getProcessingPipelineStats();
    assert.strictEqual(statsAfterB.currentBatchId, batchBId, 'Batch B should now be the latest active batch');
    assert.strictEqual(statsAfterB.contactsFound, 3, 'Metrics 1-12 must reflect current batch (Batch B has 3 contacts)');
    assert.strictEqual(statsAfterB.readyToSend, initialReadyCount + 3, 'Ready to Send must be GLOBAL across all batches');
    pass(`Global Ready to Send increased by 3 (from ${initialReadyCount} to ${initialReadyCount + 3})`);

    // -------------------------------------------------------------------------
    // TEST 6: Upload new Batch C with 0 ready-to-send (processing) -> Ready to Send remains unchanged
    // -------------------------------------------------------------------------
    console.log('--- TEST 6: New batch with 0 ready-to-send does NOT reset Ready to Send ---');
    const batchCId = `${runId}_batch_C`;
    db.insert(batches).values({
      id: batchCId,
      filename: 'Batch_C_New.csv',
      uploadDate: now,
      totalRecords: 10,
      validRecords: 10,
      relevantCompanies: 0,
      irrelevantCompanies: 0,
      duplicateContacts: 0,
      invalidEmails: 0,
      emailsPending: 0,
      status: 'processing',
      createdAt: new Date(Date.now() + 3000).toISOString(),
      updatedAt: now,
    }).run();

    // 1 unclassified contact in Batch C
    db.insert(contacts).values({
      id: `${batchCId}_c1`,
      batchId: batchCId,
      companyName: 'Gamma Unclassified Corp',
      contactName: 'Gamma Contact 1',
      email: `gamma1_${Date.now()}@example.com`,
      emailValid: true,
      isDuplicate: false,
      isRelevant: null,
      status: 'discovered',
      createdAt: now,
      updatedAt: now,
    }).run();

    const statsAfterC = getProcessingPipelineStats();
    assert.strictEqual(statsAfterC.currentBatchId, batchCId, 'Batch C should be latest active batch');
    assert.strictEqual(statsAfterC.aiSearchPending, 1, 'Batch C has 1 pending classification');
    assert.strictEqual(statsAfterC.readyToSend, initialReadyCount + 3, 'Ready to Send MUST REMAIN constant despite new batch having 0 ready-to-send');
    pass(`Uploading new batch did NOT reset Ready to Send (remained ${initialReadyCount + 3})`);

    // -------------------------------------------------------------------------
    // TEST 7: Sending/terminalizing 2 contacts reduces global Ready to Send by 2
    // -------------------------------------------------------------------------
    console.log('--- TEST 7: Terminalizing 2 contacts reduces global Ready to Send by 2 ---');
    // Simulate sending 2 contacts from Batch A
    db.update(contacts)
      .set({ status: 'sent', sentAt: now })
      .where(eq(contacts.id, `${batchAId}_c1`))
      .run();
    db.update(outreachQueue)
      .set({ status: 'completed' })
      .where(eq(outreachQueue.contactId, `${batchAId}_c1`))
      .run();

    db.update(contacts)
      .set({ status: 'sent', sentAt: now })
      .where(eq(contacts.id, `${batchAId}_c2`))
      .run();
    db.update(outreachQueue)
      .set({ status: 'completed' })
      .where(eq(outreachQueue.contactId, `${batchAId}_c2`))
      .run();

    const statsAfterSend = getProcessingPipelineStats();
    assert.strictEqual(statsAfterSend.readyToSend, initialReadyCount + 1, 'Ready to Send must accurately decrement by 2');
    pass(`Global Ready to Send reduced from ${initialReadyCount + 3} to ${initialReadyCount + 1} after 2 sends`);

    // -------------------------------------------------------------------------
    // TEST 8: Verify getReadyToSendList() pagination / global list
    // -------------------------------------------------------------------------
    console.log('--- TEST 8: Verify getReadyToSendList() returns global ready-to-send records ---');
    const readyList = getReadyToSendList({ limit: 100 });
    assert.strictEqual(readyList.total >= initialReadyCount + 1, true, 'getReadyToSendList total should include the ready items');
    const matchingTestItems = readyList.records.filter(r => r.id.startsWith(runId));
    assert.strictEqual(matchingTestItems.length, 6, 'Should find exactly 6 matching remaining test items in global list (3 from A, 3 from B)');
    pass('getReadyToSendList() accurately returned global ready-to-send items');

    // -------------------------------------------------------------------------
    // CLEANUP
    // -------------------------------------------------------------------------
    console.log('--- CLEANUP ---');
    db.run(sql`DELETE FROM outreach_queue WHERE contact_id LIKE ${`${runId}%`}`);
    db.run(sql`DELETE FROM contacts WHERE batch_id LIKE ${`${runId}%`}`);
    db.run(sql`DELETE FROM batches WHERE id LIKE ${`${runId}%`}`);
    pass('Cleanup completed successfully');

    console.log('\n======================================================================');
    console.log('ALL VERIFICATION TESTS PASSED SUCCESSFULLY (8/8)');
    console.log('======================================================================\n');
  } catch (err) {
    console.error('Test failed with error:', err);
    process.exit(1);
  }
}

runTestSuite();
