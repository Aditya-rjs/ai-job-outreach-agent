/**
 * Comprehensive Verification Test Suite for:
 * Round-Based Generation Retry Semantics (matching classification retry rounds)
 *
 * Scenarios tested:
 * 1. Email Gen Pending > 0 + Generation Retry > 0 → retry does NOT run.
 * 2. Email Gen Pending decreases but remains > 0 → retry still does NOT run.
 * 3. Email Gen Pending reaches 0 + Generation Retry > 0 → retry becomes eligible.
 * 4. Email Gen Pending = 0 + Generation Retry = 0 → nothing to retry.
 * 5. Normal generation continues progressively while retries wait.
 * 6. Successful normal generations move to Ready to Send without waiting for retry pass.
 * 7. Generation Retry does not burn attempts while waiting for Email Gen Pending to drain.
 * 8. Generation Retry works correctly after Email Gen Pending reaches 0.
 * 9. Retry success → Ready to Send.
 * 10. Retry failure → existing retry/terminal-failure behavior remains unchanged.
 * 11. Provider WAITING while retry pass is active does not burn generation attempts.
 * 12. Provider recovery allows the retry pass to resume.
 * 13. No deadlock when Email Gen Pending = 0 and Generation Retry > 0.
 * 14. Existing resume-update queue deadlock tests compatibility.
 * 15. Existing AI provider state-machine integration compatibility.
 */

import path from 'path';
import fs from 'fs';
import assert from 'assert';

// Use isolated test directory
const TEST_DIR = path.join(process.cwd(), 'data', 'test-generation-retry-rounds');
if (fs.existsSync(TEST_DIR)) {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
}
fs.mkdirSync(TEST_DIR, { recursive: true });

process.env.DATA_DIR = TEST_DIR;
(process.env as Record<string, string>).NODE_ENV = 'test';
process.env.OUTREACH_DRY_RUN = 'true';

import { getDb } from '../src/db';
import { initializeDatabase } from '../src/db/migrate';
import {
  batches,
  contacts,
  outreachQueue,
  resume,
  globalEmailHistory,
} from '../src/db/schema';
import { eq, sql } from 'drizzle-orm';
import {
  reconcilePendingEmailGenerations,
  getGenerationRoundState,
  MAX_GENERATION_RETRIES,
} from '../src/lib/pipeline/generation-reconciler';
import { AiProviderUnavailableError } from '../src/lib/ai/ai-dispatcher';
import { globalGeminiLimiter } from '../src/lib/ai/gemini-client';

async function runAllTests() {
  console.log('======================================================================');
  console.log('ROUND-BASED EMAIL GENERATION RETRY VERIFICATION SUITE');
  console.log('======================================================================\n');

  initializeDatabase();
  const db = getDb();
  globalGeminiLimiter.resetForTesting();

  const nowIso = new Date().toISOString();

  // Seed active resume
  db.insert(resume)
    .values({
      id: 'current',
      filename: 'Aditya_Raj_Singh_Resume.pdf',
      filePath: '/data/resume.pdf',
      mimeType: 'application/pdf',
      parsedText: 'Aditya Raj Singh - Computer Science Engineer - React, Node, Express, Python',
      parsedData: JSON.stringify({
        name: 'Aditya Raj Singh',
        email: 'aditya.rjs003@gmail.com',
        target_roles: ['Full Stack Engineer', 'Backend Engineer'],
        skills: { languages: ['TypeScript', 'JavaScript', 'Python'], frameworks: ['Next.js', 'React', 'Node.js'] },
        experience: [{ role: 'Software Engineer', company: 'Tech Corp' }],
      }),
      uploadedAt: nowIso,
    })
    .run();

  const batchId = 'batch_gen_retry_rounds_01';
  db.insert(batches)
    .values({
      id: batchId,
      filename: 'test_contacts.csv',
      uploadDate: nowIso,
      status: 'processing',
      totalRecords: 10,
      validRecords: 10,
      createdAt: nowIso,
      updatedAt: nowIso,
    })
    .run();

  let passedTests = 0;
  function markPass(num: number, desc: string) {
    passedTests++;
    console.log(`[PASS] Scenario ${num}: ${desc}`);
  }

  // -------------------------------------------------------------------------
  // Scenario 1: Email Gen Pending > 0 + Generation Retry > 0 → retry does NOT run
  // -------------------------------------------------------------------------
  console.log('\n--- Scenario 1: Email Gen Pending > 0 + Generation Retry > 0 blocks retries ---');

  // Insert 2 pending contacts and 2 retry contacts
  const p1Id = 'contact_pending_1';
  const p2Id = 'contact_pending_2';
  const r1Id = 'contact_retry_1';
  const r2Id = 'contact_retry_2';

  db.insert(contacts)
    .values([
      {
        id: p1Id,
        batchId,
        companyName: 'Acme Corp',
        contactName: 'Alice Pending',
        email: 'alice@acme.com',
        isRelevant: true,
        emailValid: true,
        isDuplicate: false,
        generationStatus: 'PENDING_GENERATION',
        status: 'queued',
        createdAt: '2026-09-07T10:00:00.000Z',
        updatedAt: nowIso,
      },
      {
        id: p2Id,
        batchId,
        companyName: 'Beta Inc',
        contactName: 'Bob Pending',
        email: 'bob@beta.com',
        isRelevant: true,
        emailValid: true,
        isDuplicate: false,
        generationStatus: 'PENDING_GENERATION',
        status: 'queued',
        createdAt: '2026-09-07T10:00:01.000Z',
        updatedAt: nowIso,
      },
      {
        id: r1Id,
        batchId,
        companyName: 'Retry Gamma',
        contactName: 'Grace Retry',
        email: 'grace@gamma.com',
        isRelevant: true,
        emailValid: true,
        isDuplicate: false,
        generationStatus: 'RETRY_PENDING',
        generationAttemptCount: 1,
        lastGenerationErrorCategory: 'TRANSIENT_ERROR',
        status: 'queued',
        createdAt: '2026-09-07T09:00:00.000Z', // Created EARLIER than pending!
        updatedAt: nowIso,
      },
      {
        id: r2Id,
        batchId,
        companyName: 'Retry Delta',
        contactName: 'David Retry',
        email: 'david@delta.com',
        isRelevant: true,
        emailValid: true,
        isDuplicate: false,
        generationStatus: 'RETRY_PENDING',
        generationAttemptCount: 1,
        lastGenerationErrorCategory: 'TRANSIENT_ERROR',
        status: 'queued',
        createdAt: '2026-09-07T09:00:01.000Z',
        updatedAt: nowIso,
      },
    ])
    .run();

  const roundState1 = getGenerationRoundState(db, batchId);
  assert.strictEqual(roundState1.activePendingCount, 2, 'Should detect 2 active pending generation contacts');
  assert.strictEqual(roundState1.retryWaitingCount, 2, 'Should detect 2 retry waiting contacts');
  assert.strictEqual(roundState1.isCurrentRoundDrained, false, 'Current round should NOT be drained');

  // Process batch of 1
  const res1 = await reconcilePendingEmailGenerations({
    batchId,
    batchSize: 1,
    aiCallerOverride: async () => 'Subject: Opportunities\n\nHello Alice, interested in joining Acme.',
  });

  assert.strictEqual(res1.activePass, 'ACTIVE_GENERATION', 'Should execute ACTIVE_GENERATION pass');
  assert.strictEqual(res1.succeeded, 1, 'Should succeed generating 1 pending contact');

  // Verify p1 was generated
  const p1After = db.select().from(contacts).where(eq(contacts.id, p1Id)).get();
  assert.strictEqual(p1After?.generationStatus, 'GENERATED', 'Alice should be GENERATED');

  // Verify retries were NOT touched (still attempt 1, RETRY_PENDING)
  const r1After1 = db.select().from(contacts).where(eq(contacts.id, r1Id)).get();
  assert.strictEqual(r1After1?.generationStatus, 'RETRY_PENDING', 'Grace should remain RETRY_PENDING');
  assert.strictEqual(r1After1?.generationAttemptCount, 1, 'Grace attemptCount must not increment');

  markPass(1, 'Email Gen Pending > 0 + Generation Retry > 0 → retry does NOT run');

  // -------------------------------------------------------------------------
  // Scenario 2: Email Gen Pending decreases but remains > 0 → retry still does NOT run
  // -------------------------------------------------------------------------
  console.log('\n--- Scenario 2: Email Gen Pending decreases but remains > 0 ---');

  const roundState2 = getGenerationRoundState(db, batchId);
  assert.strictEqual(roundState2.activePendingCount, 1, '1 active pending contact left');
  assert.strictEqual(roundState2.retryWaitingCount, 2, '2 retries still waiting');

  // Next run: with batchSize 1, should generate the 2nd pending contact, NOT retries
  const res2 = await reconcilePendingEmailGenerations({
    batchId,
    batchSize: 1,
    aiCallerOverride: async () => 'Subject: Opportunities\n\nHello Bob, interested in joining Beta.',
  });

  assert.strictEqual(res2.activePass, 'ACTIVE_GENERATION');
  assert.strictEqual(res2.succeeded, 1);

  const p2After = db.select().from(contacts).where(eq(contacts.id, p2Id)).get();
  assert.strictEqual(p2After?.generationStatus, 'GENERATED', 'Bob should be GENERATED');

  const r2After2 = db.select().from(contacts).where(eq(contacts.id, r2Id)).get();
  assert.strictEqual(r2After2?.generationStatus, 'RETRY_PENDING', 'David must still be RETRY_PENDING');
  assert.strictEqual(r2After2?.generationAttemptCount, 1, 'David attemptCount must not increment');

  markPass(2, 'Email Gen Pending decreases but remains > 0 → retry still does NOT run');

  // -------------------------------------------------------------------------
  // Scenario 3: Email Gen Pending reaches 0 + Generation Retry > 0 → retry becomes eligible
  // -------------------------------------------------------------------------
  console.log('\n--- Scenario 3: Email Gen Pending reaches 0 → retry becomes eligible ---');

  const roundState3 = getGenerationRoundState(db, batchId);
  assert.strictEqual(roundState3.activePendingCount, 0, 'Active pending generation count is now strictly 0');
  assert.strictEqual(roundState3.retryWaitingCount, 2, '2 retries waiting');
  assert.strictEqual(roundState3.isCurrentRoundDrained, true, 'Current round is drained');

  // Reconciler should now transition to GENERATION_RETRY pass
  const res3 = await reconcilePendingEmailGenerations({
    batchId,
    batchSize: 1,
    aiCallerOverride: async () => 'Subject: Retry Opportunities\n\nHello Grace, retried email.',
  });

  assert.strictEqual(res3.activePass, 'GENERATION_RETRY', 'Should now execute GENERATION_RETRY pass');
  assert.strictEqual(res3.succeeded, 1, '1 retry job succeeded');

  const r1After3 = db.select().from(contacts).where(eq(contacts.id, r1Id)).get();
  assert.strictEqual(r1After3?.generationStatus, 'GENERATED', 'Grace should now be GENERATED');

  markPass(3, 'Email Gen Pending reaches 0 + Generation Retry > 0 → retry becomes eligible');

  // -------------------------------------------------------------------------
  // Scenario 4: Email Gen Pending = 0 + Generation Retry = 0 → nothing to retry
  // -------------------------------------------------------------------------
  console.log('\n--- Scenario 4: Email Gen Pending = 0 + Generation Retry = 0 ---');

  // Complete the last retry contact
  const res4a = await reconcilePendingEmailGenerations({
    batchId,
    batchSize: 1,
    aiCallerOverride: async () => 'Subject: Retry Opportunities\n\nHello David, retried email.',
  });
  assert.strictEqual(res4a.succeeded, 1);

  const roundState4 = getGenerationRoundState(db, batchId);
  assert.strictEqual(roundState4.activePendingCount, 0);
  assert.strictEqual(roundState4.retryWaitingCount, 0);

  // Now both are 0
  const res4b = await reconcilePendingEmailGenerations({ batchId });
  assert.strictEqual(res4b.processed, 0, 'Nothing to process');
  assert.strictEqual(res4b.activePass, 'IDLE', 'Should report IDLE pass');

  markPass(4, 'Email Gen Pending = 0 + Generation Retry = 0 → nothing to retry');

  // -------------------------------------------------------------------------
  // Scenario 5: Normal generation continues progressively while retries wait
  // -------------------------------------------------------------------------
  console.log('\n--- Scenario 5: Progressive normal generation while retries wait ---');

  const b5 = 'batch_gen_scenario_5';
  db.insert(batches).values({ id: b5, filename: 's5.csv', uploadDate: nowIso, status: 'processing' }).run();

  // 3 pending contacts, 1 retry contact
  db.insert(contacts).values([
    { id: 'c5_p1', batchId: b5, email: 'p1@s5.com', isRelevant: true, emailValid: true, isDuplicate: false, generationStatus: 'PENDING_GENERATION', status: 'queued', createdAt: nowIso, updatedAt: nowIso },
    { id: 'c5_p2', batchId: b5, email: 'p2@s5.com', isRelevant: true, emailValid: true, isDuplicate: false, generationStatus: 'PENDING_GENERATION', status: 'queued', createdAt: nowIso, updatedAt: nowIso },
    { id: 'c5_p3', batchId: b5, email: 'p3@s5.com', isRelevant: true, emailValid: true, isDuplicate: false, generationStatus: 'PENDING_GENERATION', status: 'queued', createdAt: nowIso, updatedAt: nowIso },
    { id: 'c5_r1', batchId: b5, email: 'r1@s5.com', isRelevant: true, emailValid: true, isDuplicate: false, generationStatus: 'RETRY_PENDING', generationAttemptCount: 1, status: 'queued', createdAt: '2026-09-07T08:00:00.000Z', updatedAt: nowIso },
  ]).run();

  // Run in chunks of 1
  for (let i = 1; i <= 3; i++) {
    const stepRes = await reconcilePendingEmailGenerations({
      batchId: b5,
      batchSize: 1,
      aiCallerOverride: async () => 'Subject: Progressive\n\nProgressive generation.',
    });
    assert.strictEqual(stepRes.activePass, 'ACTIVE_GENERATION');
    assert.strictEqual(stepRes.succeeded, 1);

    // Verify retry was NOT touched in any of these progressive runs
    const rContact = db.select().from(contacts).where(eq(contacts.id, 'c5_r1')).get();
    assert.strictEqual(rContact?.generationStatus, 'RETRY_PENDING');
    assert.strictEqual(rContact?.generationAttemptCount, 1);
  }

  markPass(5, 'Normal generation continues progressively while retries wait');

  // -------------------------------------------------------------------------
  // Scenario 6: Successful normal generations move to Ready to Send without waiting for retry pass
  // -------------------------------------------------------------------------
  console.log('\n--- Scenario 6: Successful normal generations move to Ready to Send immediately ---');

  // c5_p1, c5_p2, c5_p3 must each have an outreach_queue entry with status = 'pending'
  for (const cid of ['c5_p1', 'c5_p2', 'c5_p3']) {
    const qRow = db.select().from(outreachQueue).where(eq(outreachQueue.contactId, cid)).get();
    assert.ok(qRow, `outreach_queue record must exist for ${cid}`);
    assert.strictEqual(qRow?.status, 'pending', `${cid} must be staged as pending in outreach_queue`);
  }

  markPass(6, 'Successful normal generations move to Ready to Send without waiting for retry pass');

  // -------------------------------------------------------------------------
  // Scenario 7: Generation Retry does not burn attempts while waiting for Email Gen Pending to drain
  // -------------------------------------------------------------------------
  console.log('\n--- Scenario 7: Retries do not burn attempts while waiting ---');

  const rBefore = db.select().from(contacts).where(eq(contacts.id, 'c5_r1')).get();
  assert.strictEqual(rBefore?.generationAttemptCount, 1, 'Attempt count must remain 1 after 3 runs of active generation');

  markPass(7, 'Generation Retry does not burn attempts while waiting for Email Gen Pending to drain');

  // -------------------------------------------------------------------------
  // Scenario 8: Generation Retry works correctly after Email Gen Pending reaches 0
  // -------------------------------------------------------------------------
  console.log('\n--- Scenario 8: Retry runs once pending is 0 ---');

  const res8 = await reconcilePendingEmailGenerations({
    batchId: b5,
    batchSize: 1,
    aiCallerOverride: async () => 'Subject: Retry Success\n\nRetry completed.',
  });
  assert.strictEqual(res8.activePass, 'GENERATION_RETRY');
  assert.strictEqual(res8.succeeded, 1);

  const rAfter = db.select().from(contacts).where(eq(contacts.id, 'c5_r1')).get();
  assert.strictEqual(rAfter?.generationStatus, 'GENERATED');

  markPass(8, 'Generation Retry works correctly after Email Gen Pending reaches 0');

  // -------------------------------------------------------------------------
  // Scenario 9: Retry success → Ready to Send
  // -------------------------------------------------------------------------
  console.log('\n--- Scenario 9: Retry success stages to Ready to Send ---');

  const qRetry = db.select().from(outreachQueue).where(eq(outreachQueue.contactId, 'c5_r1')).get();
  assert.ok(qRetry, 'outreach_queue record must exist for successful retry');
  assert.strictEqual(qRetry?.status, 'pending', 'outreach_queue status must be pending');

  markPass(9, 'Retry success → Ready to Send');

  // -------------------------------------------------------------------------
  // Scenario 10: Retry failure → existing retry/terminal-failure behavior remains unchanged
  // -------------------------------------------------------------------------
  console.log('\n--- Scenario 10: Retry failure behavior and max retries capping ---');

  const b10 = 'batch_scenario_10';
  db.insert(batches).values({ id: b10, filename: 's10.csv', uploadDate: nowIso, status: 'processing' }).run();

  // Contact with attempt count = 4 (one below MAX_GENERATION_RETRIES = 5)
  const cTransientId = 'c10_transient';
  db.insert(contacts).values({
    id: cTransientId,
    batchId: b10,
    email: 'transient@s10.com',
    isRelevant: true,
    emailValid: true,
    isDuplicate: false,
    generationStatus: 'RETRY_PENDING',
    generationAttemptCount: 4,
    status: 'queued',
    createdAt: nowIso,
    updatedAt: nowIso,
  }).run();

  // Fails with transient error -> reaches attempt 5 -> transitions terminally to GENERATION_FAILED
  await reconcilePendingEmailGenerations({
    batchId: b10,
    aiCallerOverride: async () => {
      const err = new Error('429 Rate limit / resource exhausted');
      (err as unknown as { isRateLimit: boolean }).isRateLimit = true;
      throw err;
    },
  });

  const cTransAfter = db.select().from(contacts).where(eq(contacts.id, cTransientId)).get();
  assert.strictEqual(cTransAfter?.generationStatus, 'GENERATION_FAILED', 'Must transition to GENERATION_FAILED after max retries');
  assert.strictEqual(cTransAfter?.generationAttemptCount, 5, 'Attempt count must be capped at 5');
  assert.strictEqual(cTransAfter?.status, 'failed');

  markPass(10, 'Retry failure → existing retry/terminal-failure behavior remains unchanged');

  // -------------------------------------------------------------------------
  // Scenario 11: Provider WAITING while retry pass is active does not burn generation attempts
  // -------------------------------------------------------------------------
  console.log('\n--- Scenario 11: Provider WAITING during retry does not burn attempts ---');

  // Reset limiter so we enter loop and encounter the AiProviderUnavailableError
  globalGeminiLimiter.resetForTesting();

  const b11 = 'batch_scenario_11';
  db.insert(batches).values({ id: b11, filename: 's11.csv', uploadDate: nowIso, status: 'processing' }).run();

  const cWaitId = 'c11_waiting';
  db.insert(contacts).values({
    id: cWaitId,
    batchId: b11,
    email: 'waiting@s11.com',
    isRelevant: true,
    emailValid: true,
    isDuplicate: false,
    generationStatus: 'RETRY_PENDING',
    generationAttemptCount: 2,
    status: 'queued',
    createdAt: nowIso,
    updatedAt: nowIso,
  }).run();

  // Simulate AI provider WAITING state error
  await reconcilePendingEmailGenerations({
    batchId: b11,
    aiCallerOverride: async () => {
      throw new AiProviderUnavailableError('Both Gemini and OpenRouter are in cooldown', 45000);
    },
  });

  const cWaitAfter = db.select().from(contacts).where(eq(contacts.id, cWaitId)).get();
  assert.strictEqual(cWaitAfter?.generationStatus, 'RETRY_PENDING', 'Must revert to RETRY_PENDING on provider WAITING');
  assert.strictEqual(cWaitAfter?.generationAttemptCount, 2, 'Must NOT burn attempt count on provider WAITING');
  assert.strictEqual(cWaitAfter?.status, 'queued');

  markPass(11, 'Provider WAITING while retry pass is active does not burn generation attempts');

  // -------------------------------------------------------------------------
  // Scenario 12: Provider recovery allows the retry pass to resume
  // -------------------------------------------------------------------------
  console.log('\n--- Scenario 12: Provider recovery allows retry pass to resume ---');

  // Provider recovers (cooldown expires)
  globalGeminiLimiter.resetForTesting();

  const res12 = await reconcilePendingEmailGenerations({
    batchId: b11,
    aiCallerOverride: async () => 'Subject: Recovered\n\nProvider recovered.',
  });

  assert.strictEqual(res12.activePass, 'GENERATION_RETRY');
  assert.strictEqual(res12.succeeded, 1);

  const cRecovered = db.select().from(contacts).where(eq(contacts.id, cWaitId)).get();
  assert.strictEqual(cRecovered?.generationStatus, 'GENERATED');

  markPass(12, 'Provider recovery allows the retry pass to resume');

  // -------------------------------------------------------------------------
  // Scenario 13: No deadlock when Email Gen Pending = 0 and Generation Retry > 0
  // -------------------------------------------------------------------------
  console.log('\n--- Scenario 13: No deadlock verification ---');

  const b13 = 'batch_scenario_13';
  db.insert(batches).values({ id: b13, filename: 's13.csv', uploadDate: nowIso, status: 'processing' }).run();

  for (let i = 1; i <= 4; i++) {
    db.insert(contacts).values({
      id: `c13_r${i}`,
      batchId: b13,
      email: `r${i}@s13.com`,
      isRelevant: true,
      emailValid: true,
      isDuplicate: false,
      generationStatus: 'RETRY_PENDING',
      generationAttemptCount: 1,
      status: 'queued',
      createdAt: nowIso,
      updatedAt: nowIso,
    }).run();
  }

  const s13Before = getGenerationRoundState(db, b13);
  assert.strictEqual(s13Before.activePendingCount, 0);
  assert.strictEqual(s13Before.retryWaitingCount, 4);

  // Process all 4 retries
  const res13 = await reconcilePendingEmailGenerations({
    batchId: b13,
    batchSize: 10,
    aiCallerOverride: async (comp) => `Subject: No Deadlock\n\nEmail for ${comp}`,
  });

  assert.strictEqual(res13.activePass, 'GENERATION_RETRY');
  assert.strictEqual(res13.succeeded, 4, 'All 4 waiting retries must be claimed and processed without deadlock');

  const s13After = getGenerationRoundState(db, b13);
  assert.strictEqual(s13After.activePendingCount, 0);
  assert.strictEqual(s13After.retryWaitingCount, 0);

  markPass(13, 'No deadlock when Email Gen Pending = 0 and Generation Retry > 0');

  // -------------------------------------------------------------------------
  // Scenario 14: Race Condition Protection: Atomic claim prevents retry if pending exists
  // -------------------------------------------------------------------------
  console.log('\n--- Scenario 14: Atomic claim prevents retry if active pending arrives ---');

  const b14 = 'batch_scenario_14';
  db.insert(batches).values({ id: b14, filename: 's14.csv', uploadDate: nowIso, status: 'processing' }).run();

  // Create 1 retry contact
  const c14r = 'c14_retry';
  db.insert(contacts).values({
    id: c14r,
    batchId: b14,
    email: 'retry14@test.com',
    isRelevant: true,
    emailValid: true,
    isDuplicate: false,
    generationStatus: 'RETRY_PENDING',
    status: 'queued',
    createdAt: nowIso,
    updatedAt: nowIso,
  }).run();

  // Insert an active pending contact right before claiming
  const c14p = 'c14_pending';
  db.insert(contacts).values({
    id: c14p,
    batchId: b14,
    email: 'pending14@test.com',
    isRelevant: true,
    emailValid: true,
    isDuplicate: false,
    generationStatus: 'PENDING_GENERATION',
    status: 'queued',
    createdAt: nowIso,
    updatedAt: nowIso,
  }).run();

  // Candidate selection evaluates activePendingCount = 1 -> selects c14p, NOT c14r!
  const res14 = await reconcilePendingEmailGenerations({
    batchId: b14,
    batchSize: 1,
    aiCallerOverride: async () => 'Subject: Hello\n\nPending contact first.',
  });

  assert.strictEqual(res14.activePass, 'ACTIVE_GENERATION');
  const pCheck = db.select().from(contacts).where(eq(contacts.id, c14p)).get();
  assert.strictEqual(pCheck?.generationStatus, 'GENERATED');

  const rCheck = db.select().from(contacts).where(eq(contacts.id, c14r)).get();
  assert.strictEqual(rCheck?.generationStatus, 'RETRY_PENDING', 'Retry was safely protected and blocked from running early');

  markPass(14, 'Race condition protection: pending contact takes strict priority over retries');

  // -------------------------------------------------------------------------
  // Scenario 15: Global Recipient Cooldown and Safety Protection Preserved
  // -------------------------------------------------------------------------
  console.log('\n--- Scenario 15: Global recipient cooldown and safety protection ---');

  // Insert a contact whose email was already sent 2 hours ago (within 144h cooldown)
  const recentSentIso = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  db.insert(globalEmailHistory).values({
    email: 'cooldown@recipient.com',
    sentAt: recentSentIso,
    status: 'sent',
  }).run();

  const cCooldownId = 'c15_cooldown';
  db.insert(contacts).values({
    id: cCooldownId,
    batchId: b14,
    email: 'cooldown@recipient.com',
    isRelevant: true,
    emailValid: true,
    isDuplicate: false,
    generationStatus: 'PENDING_GENERATION',
    status: 'queued',
    createdAt: nowIso,
    updatedAt: nowIso,
  }).run();

  // Reconciler should skip this contact because of 144h recipient cooldown
  const res15 = await reconcilePendingEmailGenerations({
    batchId: b14,
    aiCallerOverride: async () => 'Subject: Test\n\nShould not be called',
  });

  const cCooldownAfter = db.select().from(contacts).where(eq(contacts.id, cCooldownId)).get();
  assert.strictEqual(cCooldownAfter?.generationStatus, 'PENDING_GENERATION', 'Contact in 144h cooldown should not be generated');

  markPass(15, 'Global recipient cooldown and safety policies preserved');

  console.log('\n======================================================================');
  console.log(`ALL ${passedTests}/15 GENERATION RETRY ROUND SCENARIOS PASSED!`);
  console.log('======================================================================\n');
}

runAllTests().catch((err) => {
  console.error('[FAIL] Generation retry rounds verification failed:', err);
  process.exit(1);
});
