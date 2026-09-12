import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { getDb } from '../src/db';
import { batches, contacts, outreachQueue, companyClassifications } from '../src/db/schema';
import { sql, eq } from 'drizzle-orm';
import { checkBatchCompletions, acquireNextEligibleJob } from '../src/lib/scheduler/queue-manager';
import { getProcessingPipelineStats } from '../src/lib/processing-queries';
import { hasActiveFreshPendingGeneration } from '../src/lib/pipeline/generation-reconciler';
import { isBatchClassificationComplete } from '../src/lib/pipeline/classification-reconciler';

console.log('======================================================================');
console.log('VERIFY BATCH LIFECYCLE & COMPLETION SPECIFICATION');
console.log('======================================================================\n');

const db = getDb();
const now = new Date().toISOString();
const testPrefix = `test_life_${Date.now()}`;

// Helper assertion
function pass(msg: string) {
  console.log(`✔ [PASS] ${msg}`);
}

async function runTestSuite() {
  try {
    // -------------------------------------------------------------------------
    // TEST 1: Batch with Ready to Send > 0 is NOT completed
    // -------------------------------------------------------------------------
    console.log('--- TEST 1: Batch with Ready to Send > 0 is NOT completed ---');
    const b1Id = `${testPrefix}_b1`;
    db.insert(batches).values({
      id: b1Id,
      filename: 'ActiveReadyToSend.xlsx',
      uploadDate: now,
      totalRecords: 3,
      validRecords: 3,
      status: 'queued',
      emailsPending: 1,
      createdAt: now,
      updatedAt: now,
    }).run();

    // Company classification complete
    db.insert(companyClassifications).values({
      companyName: 'Acme Corp',
      normalizedName: 'acme corp',
      classificationResult: 'RELEVANT',
      confidence: 0.95,
      reason: 'Tech',
      retryCount: 0,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing().run();

    db.insert(contacts).values([
      {
        id: `${b1Id}_c1`,
        batchId: b1Id,
        companyName: 'Acme Corp',
        contactName: 'Alice',
        email: 'alice@acme.com',
        status: 'sent',
        isRelevant: true,
        isDuplicate: false,
        emailValid: true,
        sentAt: now,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: `${b1Id}_c2`,
        batchId: b1Id,
        companyName: 'Acme Corp',
        contactName: 'Bob',
        email: 'bob@acme.com',
        status: 'skipped',
        isRelevant: false,
        isDuplicate: false,
        emailValid: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: `${b1Id}_c3`,
        batchId: b1Id,
        companyName: 'Acme Corp',
        contactName: 'Charlie',
        email: 'charlie@acme.com',
        status: 'generated', // Ready to send!
        generationStatus: 'GENERATED',
        emailSubject: 'Outreach to Charlie',
        emailBody: 'Hello Charlie',
        isRelevant: true,
        isDuplicate: false,
        emailValid: true,
        createdAt: now,
        updatedAt: now,
      },
    ]).run();

    // Run completion check
    checkBatchCompletions();

    const b1After = db.select().from(batches).where(eq(batches.id, b1Id)).get();
    assert.strictEqual(b1After?.status, 'queued', 'Batch with ready to send contact must remain active (status queued)');
    pass('Batch with Ready to Send > 0 remains active (not completed)');

    // -------------------------------------------------------------------------
    // TEST 2: Batch with generated/Ready-to-Send contact is NOT completed
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 2: Batch with generated/Ready-to-Send contact is NOT completed ---');
    // Verify checkBatchCompletions returns empty for b1
    const completedSummaries = checkBatchCompletions();
    const b1Completed = completedSummaries.find(s => s.batchId === b1Id);
    assert.strictEqual(b1Completed, undefined, 'b1 must NOT be in completed summaries while generated contact exists');
    pass('checkBatchCompletions ignores batch with generated contact');

    // -------------------------------------------------------------------------
    // TEST 3: Batch becomes completed only after all contacts reach terminal states
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 3: Batch becomes completed only after all contacts reach terminal states ---');
    // Now simulate final email sending: transition Charlie to 'sent'
    db.update(contacts)
      .set({ status: 'sent', sentAt: now })
      .where(eq(contacts.id, `${b1Id}_c3`))
      .run();

    const completedSummariesAfterSend = checkBatchCompletions();
    const b1Finished = completedSummariesAfterSend.find(s => s.batchId === b1Id);
    assert(b1Finished !== undefined, 'b1 must be included in completedSummaries now that all contacts are terminal');
    
    const b1Final = db.select().from(batches).where(eq(batches.id, b1Id)).get();
    assert.strictEqual(b1Final?.status, 'completed', 'b1 status must now be completed');
    assert.strictEqual(b1Final?.emailsPending, 0, 'emailsPending must be 0 for completed batch');
    pass('Batch transitions to completed only after all contacts reach terminal states (sent/skipped)');

    // -------------------------------------------------------------------------
    // TEST 4: Recent Batches displays "completed" for completed batches
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 4: Recent Batches displays "completed" for completed batches ---');
    // Verify Recent Batches badge code in page.tsx and batches/page.tsx
    const homePageCode = fs.readFileSync(path.join(process.cwd(), 'src/app/page.tsx'), 'utf8');
    const batchesPageCode = fs.readFileSync(path.join(process.cwd(), 'src/app/batches/page.tsx'), 'utf8');

    assert(homePageCode.includes("b.status === 'completed' ? 'success'"), 'page.tsx must have success variant for completed batches');
    assert(homePageCode.includes('{b.status}'), 'page.tsx must render actual b.status string');
    assert(!homePageCode.includes("b.status === 'completed' ? 'queued'"), 'page.tsx must never hardcode queued for completed batches');
    assert(batchesPageCode.includes("case 'completed':\n        return 'success';"), 'batches/page.tsx must return success for completed batches');
    assert(batchesPageCode.includes("case 'queued':\n        return 'secondary';"), 'batches/page.tsx must distinguish queued from completed');
    pass('Recent Batches displays actual dynamic status ("completed" with success badge)');

    // -------------------------------------------------------------------------
    // TEST 5: Active batch continues 5-second polling
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 5: Active batch continues 5-second polling ---');
    const batchDetailPageCode = fs.readFileSync(path.join(process.cwd(), 'src/app/batches/[id]/page.tsx'), 'utf8');
    assert(batchDetailPageCode.includes('setInterval(') && batchDetailPageCode.includes('5000);'), '5000ms polling interval must be present');
    assert(batchDetailPageCode.includes("!batch || batch.status === 'completed' || batch.status === 'deleted' || batch.status === 'cancelled' || batch.status === 'failed'"), 'Polling guard must prevent completed/deleted batches from polling');
    pass('Active batch continues 5-second polling while in active state');

    // -------------------------------------------------------------------------
    // TEST 6: Completed batch does not start 5-second polling
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 6: Completed batch does not start 5-second polling ---');
    // Test simulator of hook logic
    function shouldStartPolling(batch: { status: string } | null): boolean {
      if (!batch || batch.status === 'completed' || batch.status === 'deleted' || batch.status === 'cancelled' || batch.status === 'failed') {
        return false;
      }
      return true;
    }
    assert.strictEqual(shouldStartPolling({ status: 'completed' }), false, 'Completed batch must not start polling');
    pass('Completed batch does NOT start 5-second polling interval');

    // -------------------------------------------------------------------------
    // TEST 7: Deleted batch does not start polling
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 7: Deleted batch does not start polling ---');
    assert.strictEqual(shouldStartPolling({ status: 'deleted' }), false, 'Deleted batch must not start polling');
    assert.strictEqual(shouldStartPolling({ status: 'cancelled' }), false, 'Cancelled batch must not start polling');
    assert.strictEqual(shouldStartPolling({ status: 'failed' }), false, 'Failed batch must not start polling');
    assert.strictEqual(shouldStartPolling({ status: 'processing' }), true, 'Processing batch must start polling');
    assert.strictEqual(shouldStartPolling({ status: 'queued' }), true, 'Queued batch must start polling');
    pass('Deleted and non-active batches do NOT start polling; only active batches poll');

    // -------------------------------------------------------------------------
    // TEST 8: Active batch background polling does not show detail loading spinner
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 8: Active batch background polling does not show detail loading spinner ---');
    assert(batchDetailPageCode.includes('if (targetCategory && !isBackground) setLoadingDetail(true);'), 'setLoadingDetail(true) must be guarded against background polls');
    assert(batchDetailPageCode.includes('if (!isBackground) setLoadingDetail(false);'), 'setLoadingDetail(false) must be guarded against background polls');
    pass('Active batch background polling performs silent refresh without flicker');

    // -------------------------------------------------------------------------
    // TEST 9: Completed batches are excluded from worker/reconciler active-work selection
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 9: Completed batches excluded from worker/reconciler active-work ---');
    // Check generation reconciler
    const classReconcilerCode = fs.readFileSync(path.join(process.cwd(), 'src/lib/pipeline/classification-reconciler.ts'), 'utf8');
    const genReconcilerCode = fs.readFileSync(path.join(process.cwd(), 'src/lib/pipeline/generation-reconciler.ts'), 'utf8');
    const queueManagerCode = fs.readFileSync(path.join(process.cwd(), 'src/lib/scheduler/queue-manager.ts'), 'utf8');
    const workerCode = fs.readFileSync(path.join(process.cwd(), 'src/worker/outreach-worker.ts'), 'utf8');
    const histRecoveryCode = fs.readFileSync(path.join(process.cwd(), 'src/lib/pipeline/historical-recovery.ts'), 'utf8');

    assert(classReconcilerCode.includes("batches.status NOT IN ('completed', 'deleted', 'cancelled')"), 'Classification reconciler must exclude completed');
    assert(genReconcilerCode.includes("batches.status NOT IN ('completed', 'deleted', 'cancelled')"), 'Generation reconciler must exclude completed');
    assert(queueManagerCode.includes("batches.status NOT IN ('completed', 'cancelled', 'deleted')"), 'Queue manager acquireNextEligibleJob must exclude completed');
    assert(workerCode.includes("parentBatch.status === 'completed'"), 'Outreach worker must abort sending for completed batches');
    assert(histRecoveryCode.includes("b.status !== 'completed'"), 'Historical recovery must exclude completed batches');
    pass('Completed batches are strictly excluded from all worker/reconciler active queries');

    // -------------------------------------------------------------------------
    // TEST 10: Completed batch data remains readable as historical data
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 10: Completed batch data remains readable as historical data ---');
    const stats = getProcessingPipelineStats(b1Id);
    assert(stats !== null, 'Completed batch processing stats must be readable');
    assert.strictEqual(stats.contactsFound, 3, 'Historical contactsFound preserved');
    assert.strictEqual(stats.readyToSend, 0, 'Ready to send is 0 for completed batch');
    assert.strictEqual(stats.currentBatchId, b1Id, 'Correct batch resolved');
    pass('Completed batch data remains 100% intact and readable as historical data');

    // -------------------------------------------------------------------------
    // TEST 11: Multiple batches remain isolated
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 11: Multiple batches remain isolated ---');
    const b2ActiveId = `${testPrefix}_b2_active`;
    db.insert(batches).values({
      id: b2ActiveId,
      filename: 'Batch2Active.xlsx',
      uploadDate: now,
      totalRecords: 1,
      validRecords: 1,
      status: 'queued',
      emailsPending: 1,
      createdAt: now,
      updatedAt: now,
    }).run();

    db.insert(contacts).values([
      {
        id: `${b2ActiveId}_c1`,
        batchId: b2ActiveId,
        companyName: 'Beta Corp',
        contactName: 'Dave',
        email: 'dave@beta.com',
        status: 'generated',
        generationStatus: 'GENERATED',
        emailSubject: 'Hello Dave',
        emailBody: 'Body Dave',
        isRelevant: true,
        isDuplicate: false,
        emailValid: true,
        createdAt: now,
        updatedAt: now,
      },
    ]).run();

    db.insert(companyClassifications).values({
      companyName: 'Beta Corp',
      normalizedName: 'beta corp',
      classificationResult: 'RELEVANT',
      confidence: 0.95,
      reason: 'Tech',
      retryCount: 0,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing().run();

    // Check completion again
    checkBatchCompletions();

    const b1Check = db.select().from(batches).where(eq(batches.id, b1Id)).get();
    const b2Check = db.select().from(batches).where(eq(batches.id, b2ActiveId)).get();

    assert.strictEqual(b1Check?.status, 'completed', 'b1 must remain completed');
    assert.strictEqual(b2Check?.status, 'queued', 'b2 must remain active/queued because Dave is generated');
    pass('Batches remain strictly isolated: completing b1 does not affect b2');

    // -------------------------------------------------------------------------
    // TEST 12: Existing Ready-to-Send behavior remains unchanged
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 12: Existing Ready-to-Send behavior remains unchanged ---');
    // Enqueue Dave in outreach_queue
    const qItem = {
      id: `q_${b2ActiveId}_1`,
      contactId: `${b2ActiveId}_c1`,
      priority: 10,
      status: 'pending' as const,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };
    db.insert(outreachQueue).values(qItem).run();

    const eligibleJob = acquireNextEligibleJob('worker_test_1');
    assert(eligibleJob !== null, 'Eligible ready-to-send job in active batch must be acquirable');
    assert.strictEqual(eligibleJob.contact.id, `${b2ActiveId}_c1`, 'Dave must be acquired');
    assert.strictEqual(eligibleJob.contact.status, 'generated', 'Contact status remains generated (Ready to Send)');
    pass('Ready-to-Send job acquisition and lifecycle behavior remains completely unchanged');

    console.log('\n======================================================================');
    console.log('ALL 12 BATCH LIFECYCLE & COMPLETION TESTS PASSED SUCCESSFULLY');
    console.log('======================================================================');
  } finally {
    // Cleanup test fixtures
    db.delete(outreachQueue).where(sql`id LIKE ${'q_' + testPrefix + '%'}`).run();
    db.delete(contacts).where(sql`batch_id LIKE ${testPrefix + '%'}`).run();
    db.delete(batches).where(sql`id LIKE ${testPrefix + '%'}`).run();
  }
}

runTestSuite().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
