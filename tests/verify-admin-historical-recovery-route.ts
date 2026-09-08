/**
 * tests/verify-admin-historical-recovery-route.ts
 *
 * Dedicated test suite for POST /api/admin/recover-historical-failures
 * and the atomic recovery engine (executeHistorical17Recovery).
 *
 * Verifies all 18 requirements:
 * 1. Missing ADMIN_RECOVERY_KEY fails closed.
 * 2. Invalid Bearer token rejected.
 * 3. Valid token accepted.
 * 4. All 17 valid preconditions → exactly 17 updated.
 * 5. One failed precondition → zero rows updated.
 * 6. Wrong target count → zero rows updated.
 * 7. UPDATE affecting fewer than 17 → rollback.
 * 8. Second invocation does not reset already recovered contacts.
 * 9. Existing outreach_queue record causes safe abort.
 * 10. Active generation lease causes safe abort.
 * 11. Sent contact causes safe abort.
 * 12. Invalid/duplicate contact causes safe abort.
 * 13. Existing cooldown conflict causes safe abort.
 * 14. No unrelated contacts are modified.
 * 15. No outreach_queue records are created by the route.
 * 16. No scheduler settings are modified.
 * 17. Transaction rollback works correctly.
 * 18. Secret never appears in logs/errors/responses.
 *
 * Strictly isolated: Uses a temporary SQLite data directory, zero real emails.
 */

import path from 'path';
import fs from 'fs';
import assert from 'assert';

const TEST_DIR = path.join(process.cwd(), 'data', `test-admin-recovery-${Date.now()}`);
fs.mkdirSync(TEST_DIR, { recursive: true });

process.env.DATA_DIR = TEST_DIR;
(process.env as Record<string, string>).NODE_ENV = 'test';
process.env.OUTREACH_DRY_RUN = 'true';

const MOCK_ADMIN_KEY = 'test-secret-recovery-key-xyz-12345';
process.env.ADMIN_RECOVERY_KEY = MOCK_ADMIN_KEY;

import { getDb, resetDbConnection } from '../src/db';
import { initializeDatabase } from '../src/db/migrate';
import {
  batches,
  contacts,
  outreachQueue,
  schedulerState,
  globalEmailHistory,
} from '../src/db/schema';
import { eq, inArray, sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import {
  HISTORICAL_17_TARGET_IDS,
  executeHistorical17Recovery,
} from '../src/lib/pipeline/historical-recovery';
import { POST } from '../src/app/api/admin/recover-historical-failures/route';
import { NextRequest } from 'next/server';

let passed = 0;
let total = 0;

function markPass(scenario: number, desc: string) {
  passed++;
  console.log(`✓ [PASS] Test ${scenario}: ${desc}`);
}

async function runTests() {
  console.log('======================================================================');
  console.log('PHASE 5 — STEP 3: ADMIN HISTORICAL RECOVERY ROUTE & TRANSACTION TEST SUITE');
  console.log('======================================================================\n');

  resetDbConnection();
  initializeDatabase();
  const db = getDb();
  const nowIso = new Date().toISOString();

  const BATCH_ID = `batch_rec_test_${ulid()}`;
  db.insert(batches)
    .values({
      id: BATCH_ID,
      filename: 'HR+List.csv',
      uploadDate: nowIso,
      status: 'queued',
      createdAt: nowIso,
      updatedAt: nowIso,
    })
    .run();

  // Helper to populate all 17 contacts in valid failed state
  function seedAll17Failed() {
    db.delete(contacts).where(inArray(contacts.id, HISTORICAL_17_TARGET_IDS as unknown as string[])).run();
    db.delete(outreachQueue).where(inArray(outreachQueue.contactId, HISTORICAL_17_TARGET_IDS as unknown as string[])).run();

    for (let i = 0; i < HISTORICAL_17_TARGET_IDS.length; i++) {
      const id = HISTORICAL_17_TARGET_IDS[i];
      db.insert(contacts)
        .values({
          id,
          batchId: BATCH_ID,
          companyName: `Target Company ${i + 1}`,
          contactName: `Recruiter ${i + 1}`,
          email: `recruiter_${i + 1}_${id.slice(-6)}@targetcorp.test`,
          isRelevant: true,
          emailValid: true,
          isDuplicate: false,
          status: 'failed',
          generationStatus: 'GENERATION_FAILED',
          generationAttemptCount: 1,
          sentAt: null,
          generationClaimToken: null,
          generationLeaseExpiresAt: null,
          emailSubject: null,
          emailBody: null,
          lastGenerationErrorCategory: 'LOCAL_BUG',
          errorMessage: 'Historical failure',
          createdAt: nowIso,
          updatedAt: nowIso,
        })
        .run();
    }
  }

  // Also seed 1 unrelated contact to verify isolation
  const UNRELATED_ID = `cont_unrelated_${ulid()}`;
  db.insert(contacts)
    .values({
      id: UNRELATED_ID,
      batchId: BATCH_ID,
      companyName: 'Unrelated Corp',
      email: 'unrelated@unrelatedcorp.test',
      isRelevant: true,
      emailValid: true,
      isDuplicate: false,
      status: 'failed',
      generationStatus: 'GENERATION_FAILED',
      generationAttemptCount: 3,
      createdAt: nowIso,
      updatedAt: nowIso,
    })
    .run();

  // -------------------------------------------------------------------------
  // Test 1: Missing ADMIN_RECOVERY_KEY fails closed
  // -------------------------------------------------------------------------
  console.log('--- Test 1: Missing ADMIN_RECOVERY_KEY fails closed ---');
  total++;
  const savedKey = process.env.ADMIN_RECOVERY_KEY;
  delete process.env.ADMIN_RECOVERY_KEY;

  const req1 = new NextRequest('http://localhost:3000/api/admin/recover-historical-failures', {
    method: 'POST',
    headers: { Authorization: `Bearer ${MOCK_ADMIN_KEY}` },
  });
  const res1 = await POST(req1);
  const json1 = await res1.json();

  assert.strictEqual(res1.status, 403, 'Must return 403 Forbidden when key not configured');
  assert.strictEqual(json1.success, false);
  assert.strictEqual(json1.error, 'ADMIN_RECOVERY_KEY_NOT_CONFIGURED');
  process.env.ADMIN_RECOVERY_KEY = savedKey;
  markPass(1, 'Missing ADMIN_RECOVERY_KEY fails closed with 403');

  // -------------------------------------------------------------------------
  // Test 2: Invalid Bearer token rejected
  // -------------------------------------------------------------------------
  console.log('\n--- Test 2: Invalid Bearer token rejected ---');
  total++;
  const req2 = new NextRequest('http://localhost:3000/api/admin/recover-historical-failures', {
    method: 'POST',
    headers: { Authorization: 'Bearer wrong-secret-token' },
  });
  const res2 = await POST(req2);
  const json2 = await res2.json();

  assert.strictEqual(res2.status, 401, 'Must return 401 Unauthorized for invalid token');
  assert.strictEqual(json2.success, false);
  assert.strictEqual(json2.error, 'UNAUTHORIZED');
  markPass(2, 'Invalid Bearer token rejected with 401');

  // -------------------------------------------------------------------------
  // Test 3: Valid token accepted (Authentication layer)
  // -------------------------------------------------------------------------
  console.log('\n--- Test 3: Valid token accepted ---');
  total++;
  seedAll17Failed();

  const req3 = new NextRequest('http://localhost:3000/api/admin/recover-historical-failures', {
    method: 'POST',
    headers: { Authorization: `Bearer ${MOCK_ADMIN_KEY}` },
  });
  const res3 = await POST(req3);
  const json3 = await res3.json();

  assert.strictEqual(res3.status, 200, 'Must return 200 OK for valid token');
  assert.strictEqual(json3.success, true);
  markPass(3, 'Valid token accepted with 200 OK');

  // -------------------------------------------------------------------------
  // Test 4: All 17 valid preconditions -> exactly 17 updated
  // -------------------------------------------------------------------------
  console.log('\n--- Test 4: All 17 valid preconditions -> exactly 17 updated ---');
  total++;
  // Verify rows in DB immediately after Test 3
  const updatedRows = db
    .select()
    .from(contacts)
    .where(inArray(contacts.id, HISTORICAL_17_TARGET_IDS as unknown as string[]))
    .all();

  assert.strictEqual(updatedRows.length, 17);
  for (const r of updatedRows) {
    assert.strictEqual(r.status, 'queued', 'status must be queued');
    assert.strictEqual(r.generationStatus, 'PENDING_GENERATION', 'generationStatus must be PENDING_GENERATION');
    assert.strictEqual(r.generationAttemptCount, 0, 'generationAttemptCount must be 0');
    assert.strictEqual(r.generationClaimToken, null, 'claimToken must be null');
    assert.strictEqual(r.generationLeaseExpiresAt, null, 'lease must be null');
    assert.strictEqual(r.retryTurnConsumedMs, 0, 'consumed budget must be 0');
    assert.strictEqual(r.lastGenerationErrorCategory, null, 'last error category must be cleared');
    assert.strictEqual(r.errorMessage, null, 'error message must be cleared');
  }
  markPass(4, 'All 17 contacts successfully transitioned to PENDING_GENERATION');

  // -------------------------------------------------------------------------
  // Test 5: One failed precondition -> zero rows updated (Atomic Rollback)
  // -------------------------------------------------------------------------
  console.log('\n--- Test 5: One failed precondition -> zero rows updated ---');
  total++;
  seedAll17Failed();
  // Make 1 contact violate precondition: already has emailSubject
  db.update(contacts)
    .set({ emailSubject: 'Pre-existing Subject' })
    .where(eq(contacts.id, HISTORICAL_17_TARGET_IDS[5]))
    .run();

  const res5 = executeHistorical17Recovery(db);
  assert.strictEqual(res5.success, false);
  assert.strictEqual(res5.affectedCount, 0, 'Zero rows must be updated on precondition failure');
  assert.strictEqual(res5.failedPrecondition, 'email_subject_already_present');
  assert.strictEqual(res5.failedContactId, HISTORICAL_17_TARGET_IDS[5]);

  // Check that NO contact was updated
  const stillFailed = db
    .select({ status: contacts.status, genStatus: contacts.generationStatus })
    .from(contacts)
    .where(inArray(contacts.id, HISTORICAL_17_TARGET_IDS as unknown as string[]))
    .all();
  assert.ok(stillFailed.every((c) => c.status === 'failed' && c.genStatus === 'GENERATION_FAILED'));
  markPass(5, 'One failed precondition causes safe abort with 0 rows updated');

  // -------------------------------------------------------------------------
  // Test 6: Wrong target count -> zero rows updated
  // -------------------------------------------------------------------------
  console.log('\n--- Test 6: Wrong target count -> zero rows updated ---');
  total++;
  seedAll17Failed();
  // Delete 1 target contact
  db.delete(contacts).where(eq(contacts.id, HISTORICAL_17_TARGET_IDS[10])).run();

  const res6 = executeHistorical17Recovery(db);
  assert.strictEqual(res6.success, false);
  assert.strictEqual(res6.affectedCount, 0);
  assert.strictEqual(res6.failedPrecondition, 'TARGET_COUNT_MISMATCH');
  markPass(6, 'Missing target contact causes TARGET_COUNT_MISMATCH and 0 updates');

  // -------------------------------------------------------------------------
  // Test 7: UPDATE affecting fewer than 17 -> rollback
  // -------------------------------------------------------------------------
  console.log('\n--- Test 7: UPDATE affecting fewer than 17 -> rollback ---');
  total++;
  seedAll17Failed();
  // Pass a custom targets list with an extra fake ID that doesn't exist
  const targetsWithMissing = [...HISTORICAL_17_TARGET_IDS, 'cont_fake_999'];
  const res7 = executeHistorical17Recovery(db, targetsWithMissing);
  assert.strictEqual(res7.success, false);
  assert.strictEqual(res7.affectedCount, 0);
  markPass(7, 'Affected rows count mismatch triggers atomic rollback');

  // -------------------------------------------------------------------------
  // Test 8: Second invocation does not reset already recovered contacts (Idempotency)
  // -------------------------------------------------------------------------
  console.log('\n--- Test 8: Second invocation does not reset already recovered contacts ---');
  total++;
  seedAll17Failed();
  // First run: recovers 17
  const run1 = executeHistorical17Recovery(db);
  assert.strictEqual(run1.success, true);
  assert.strictEqual(run1.affectedCount, 17);

  // Second run: should safely report already recovered, 0 affected
  const run2 = executeHistorical17Recovery(db);
  assert.strictEqual(run2.success, true);
  assert.strictEqual(run2.affectedCount, 0);
  assert.strictEqual(run2.alreadyRecovered, true);
  assert.ok(run2.message.includes('already been recovered'));
  markPass(8, 'Idempotent repeated call safely reports already recovered with 0 updates');

  // -------------------------------------------------------------------------
  // Test 9A: Active pending outreach_queue record causes safe abort
  // -------------------------------------------------------------------------
  console.log('\n--- Test 9A: Active pending outreach_queue record causes safe abort ---');
  total++;
  seedAll17Failed();
  // Insert an active 'pending' outreach_queue item for contact 2
  db.insert(outreachQueue)
    .values({
      id: `queue_test_${ulid()}`,
      contactId: HISTORICAL_17_TARGET_IDS[2],
      priority: 0,
      status: 'pending',
      attempts: 0,
      createdAt: nowIso,
      updatedAt: nowIso,
    })
    .run();

  const res9a = executeHistorical17Recovery(db);
  assert.strictEqual(res9a.success, false);
  assert.strictEqual(res9a.failedPrecondition, 'active_outreach_queue_record');
  assert.strictEqual(res9a.failedContactId, HISTORICAL_17_TARGET_IDS[2]);
  markPass(9, 'Active pending outreach_queue record causes safe abort');

  // -------------------------------------------------------------------------
  // Test 9B: Active processing outreach_queue record causes safe abort
  // -------------------------------------------------------------------------
  console.log('\n--- Test 9B: Active processing outreach_queue record causes safe abort ---');
  total++;
  seedAll17Failed();
  // Insert an active 'processing' outreach_queue item for contact 4
  db.insert(outreachQueue)
    .values({
      id: `queue_test_${ulid()}`,
      contactId: HISTORICAL_17_TARGET_IDS[4],
      priority: 0,
      status: 'processing',
      attempts: 1,
      createdAt: nowIso,
      updatedAt: nowIso,
    })
    .run();

  const res9b = executeHistorical17Recovery(db);
  assert.strictEqual(res9b.success, false);
  assert.strictEqual(res9b.failedPrecondition, 'active_outreach_queue_record');
  assert.strictEqual(res9b.failedContactId, HISTORICAL_17_TARGET_IDS[4]);
  markPass(9.1, 'Active processing outreach_queue record causes safe abort');

  // -------------------------------------------------------------------------
  // Test 9C: Stale failed outreach_queue record is safely purged during recovery
  // -------------------------------------------------------------------------
  console.log('\n--- Test 9C: Stale failed outreach_queue record is safely purged during recovery ---');
  total++;
  seedAll17Failed();
  // Insert a stale 'failed' outreach_queue item for contact 15 (like Adani Group on production)
  const staleQueueId = `queue_stale_${ulid()}`;
  db.insert(outreachQueue)
    .values({
      id: staleQueueId,
      contactId: HISTORICAL_17_TARGET_IDS[15],
      priority: 0,
      status: 'failed',
      attempts: 5,
      createdAt: nowIso,
      updatedAt: nowIso,
    })
    .run();

  // Also insert an unrelated contact's queue record that must NOT be touched
  const unrelatedContactId = 'cont_unrelated_queue_99';
  const unrelatedQueueId = `queue_unrelated_${ulid()}`;
  db.insert(contacts)
    .values({
      id: unrelatedContactId,
      batchId: BATCH_ID,
      email: 'unrelated@corp.test',
      status: 'queued',
      createdAt: nowIso,
      updatedAt: nowIso,
    })
    .run();
  db.insert(outreachQueue)
    .values({
      id: unrelatedQueueId,
      contactId: unrelatedContactId,
      priority: 0,
      status: 'failed',
      attempts: 2,
      createdAt: nowIso,
      updatedAt: nowIso,
    })
    .run();

  const res9c = executeHistorical17Recovery(db);
  assert.strictEqual(res9c.success, true);
  assert.strictEqual(res9c.affectedCount, 17);

  // Verify the stale queue record was purged
  const purgedCheck = db.select().from(outreachQueue).where(eq(outreachQueue.id, staleQueueId)).get();
  assert.strictEqual(purgedCheck, undefined, 'Stale historical queue record must be purged');

  // Verify unrelated queue record is completely untouched
  const unrelatedCheck = db.select().from(outreachQueue).where(eq(outreachQueue.id, unrelatedQueueId)).get();
  assert.ok(unrelatedCheck !== undefined, 'Unrelated queue record must remain completely untouched');
  assert.strictEqual(unrelatedCheck.id, unrelatedQueueId);
  markPass(9.2, 'Stale failed outreach_queue record is purged while unrelated records remain untouched');

  // -------------------------------------------------------------------------
  // Test 10: Active generation lease causes safe abort
  // -------------------------------------------------------------------------
  console.log('\n--- Test 10: Active generation lease causes safe abort ---');
  total++;
  seedAll17Failed();
  db.update(contacts)
    .set({ generationLeaseExpiresAt: new Date(Date.now() + 60000).toISOString() })
    .where(eq(contacts.id, HISTORICAL_17_TARGET_IDS[7]))
    .run();

  const res10 = executeHistorical17Recovery(db);
  assert.strictEqual(res10.success, false);
  assert.strictEqual(res10.failedPrecondition, 'active_lease_expires_present');
  markPass(10, 'Active generation lease causes safe abort');

  // -------------------------------------------------------------------------
  // Test 11: Sent contact causes safe abort
  // -------------------------------------------------------------------------
  console.log('\n--- Test 11: Sent contact causes safe abort ---');
  total++;
  seedAll17Failed();
  db.update(contacts)
    .set({ sentAt: nowIso })
    .where(eq(contacts.id, HISTORICAL_17_TARGET_IDS[3]))
    .run();

  const res11 = executeHistorical17Recovery(db);
  assert.strictEqual(res11.success, false);
  assert.strictEqual(res11.failedPrecondition, 'contact_already_sent');
  markPass(11, 'Sent contact causes safe abort');

  // -------------------------------------------------------------------------
  // Test 12: Invalid / duplicate contact causes safe abort
  // -------------------------------------------------------------------------
  console.log('\n--- Test 12: Invalid / duplicate contact causes safe abort ---');
  total++;
  seedAll17Failed();
  db.update(contacts)
    .set({ isDuplicate: true })
    .where(eq(contacts.id, HISTORICAL_17_TARGET_IDS[0]))
    .run();

  const res12 = executeHistorical17Recovery(db);
  assert.strictEqual(res12.success, false);
  assert.strictEqual(res12.failedPrecondition, 'contact_is_duplicate');
  markPass(12, 'Duplicate contact flag causes safe abort');

  // -------------------------------------------------------------------------
  // Test 13: Existing cooldown conflict causes safe abort
  // -------------------------------------------------------------------------
  console.log('\n--- Test 13: Existing cooldown conflict causes safe abort ---');
  total++;
  seedAll17Failed();
  const cTarget = db.select().from(contacts).where(eq(contacts.id, HISTORICAL_17_TARGET_IDS[1])).get();
  assert.ok(cTarget);
  // Mark this email as 'sent' in global_email_history
  db.insert(globalEmailHistory)
    .values({
      email: cTarget.email.toLowerCase().trim(),
      status: 'sent',
      sentAt: nowIso,
      firstSeenAt: nowIso,
    })
    .run();

  const res13 = executeHistorical17Recovery(db);
  assert.strictEqual(res13.success, false);
  assert.strictEqual(res13.failedPrecondition, 'global_email_history_sent_conflict');
  markPass(13, 'Global email history sent conflict causes safe abort');

  // -------------------------------------------------------------------------
  // Test 14: No unrelated contacts are modified
  // -------------------------------------------------------------------------
  console.log('\n--- Test 14: No unrelated contacts are modified ---');
  total++;
  seedAll17Failed();
  // Clear the global history conflict from test 13
  db.delete(globalEmailHistory).where(eq(globalEmailHistory.email, cTarget.email.toLowerCase().trim())).run();

  const unrelatedBefore = db.select().from(contacts).where(eq(contacts.id, UNRELATED_ID)).get();
  executeHistorical17Recovery(db);
  const unrelatedAfter = db.select().from(contacts).where(eq(contacts.id, UNRELATED_ID)).get();

  assert.strictEqual(unrelatedBefore?.status, unrelatedAfter?.status);
  assert.strictEqual(unrelatedBefore?.generationStatus, unrelatedAfter?.generationStatus);
  assert.strictEqual(unrelatedBefore?.generationAttemptCount, unrelatedAfter?.generationAttemptCount);
  markPass(14, 'Unrelated contacts are 100% untouched');

  // -------------------------------------------------------------------------
  // Test 15: No outreach_queue records are created by the route
  // -------------------------------------------------------------------------
  console.log('\n--- Test 15: No outreach_queue records are created by the route ---');
  total++;
  const queueCount = db
    .select({ count: sql<number>`count(*)` })
    .from(outreachQueue)
    .where(inArray(outreachQueue.contactId, HISTORICAL_17_TARGET_IDS as unknown as string[]))
    .get()?.count ?? 0;

  assert.strictEqual(queueCount, 0, 'No queue items must be created by the recovery route');
  markPass(15, 'Recovery route created 0 outreach_queue records (deferred to reconciler)');

  // -------------------------------------------------------------------------
  // Test 16: No scheduler settings are modified
  // -------------------------------------------------------------------------
  console.log('\n--- Test 16: No scheduler settings are modified ---');
  total++;
  const schedBefore = db.select().from(schedulerState).where(eq(schedulerState.id, 'singleton')).get();
  executeHistorical17Recovery(db);
  const schedAfter = db.select().from(schedulerState).where(eq(schedulerState.id, 'singleton')).get();

  assert.strictEqual(schedBefore?.dailyLimit, schedAfter?.dailyLimit);
  assert.strictEqual(schedBefore?.intervalMinutes, schedAfter?.intervalMinutes);
  assert.strictEqual(schedBefore?.isPaused, schedAfter?.isPaused);
  markPass(16, 'Scheduler settings remain completely unchanged');

  // -------------------------------------------------------------------------
  // Test 17: Transaction rollback works correctly
  // -------------------------------------------------------------------------
  console.log('\n--- Test 17: Transaction rollback works correctly ---');
  total++;
  seedAll17Failed();
  // Intentionally delete parent batch to break batch invariant
  db.delete(batches).where(eq(batches.id, BATCH_ID)).run();

  const res17 = executeHistorical17Recovery(db);
  assert.strictEqual(res17.success, false);
  assert.strictEqual(res17.affectedCount, 0);

  // Verify none of the contacts were updated
  const checkRollback = db
    .select({ status: contacts.status })
    .from(contacts)
    .where(inArray(contacts.id, HISTORICAL_17_TARGET_IDS as unknown as string[]))
    .all();
  assert.ok(checkRollback.every((c) => c.status === 'failed'));
  markPass(17, 'Transaction rollback leaves 0 rows modified on unexpected failure');

  // -------------------------------------------------------------------------
  // Test 18: Secret never appears in logs / errors / responses
  // -------------------------------------------------------------------------
  console.log('\n--- Test 18: Secret never appears in logs / errors / responses ---');
  total++;
  const req18 = new NextRequest('http://localhost:3000/api/admin/recover-historical-failures', {
    method: 'POST',
    headers: { Authorization: `Bearer wrong-token-with-secret` },
  });
  const res18 = await POST(req18);
  const text18 = await res18.text();

  assert.ok(!text18.includes(MOCK_ADMIN_KEY), 'Configured admin key must never appear in response body');
  assert.ok(!text18.includes('wrong-token-with-secret'), 'Provided token must never be reflected in response body');
  markPass(18, 'Secret and authorization tokens are strictly omitted from responses');

  // Cleanup temporary test directory
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {}

  console.log('\n======================================================================');
  console.log(`ALL TESTS PASSED: ${passed}/${total}`);
  console.log('======================================================================\n');
}

runTests().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
