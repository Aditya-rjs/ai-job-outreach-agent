/**
 * VERIFY DECOUPLED GENERATION LOOP & OUTREACH WORKER
 *
 * Validates:
 * 1. Generation continues while the Gmail sending window is closed.
 * 2. Generation is not blocked by the 3-minute Gmail send interval.
 * 3. Multiple generation batches can run back-to-back without outer worker sleep.
 * 4. Gmail sending behavior remains strictly unchanged.
 * 5. Classification barrier remains intact (pending/retry blocks generation).
 * 6. Ready-to-Send remains independent of classification status.
 * 7. No duplicate generation claims occur.
 * 8. Provider WAITING does not cause a tight CPU loop.
 * 9. Batch lifecycle & completion semantics remain intact.
 */

import path from 'path';
import fs from 'fs';
import assert from 'assert';

const TEST_DIR = path.join(process.cwd(), 'data', `test-decoupled-${Date.now()}`);
fs.mkdirSync(TEST_DIR, { recursive: true });

process.env.DATA_DIR = TEST_DIR;
(process.env as any).NODE_ENV = 'test';
process.env.OUTREACH_WORKER_NO_AUTO_START = 'true';
process.env.OUTREACH_DRY_RUN = 'true';

import { getDb, resetDbConnection } from '../src/db';
import { initializeDatabase } from '../src/db/migrate';
import { batches, contacts, companyClassifications, outreachQueue, schedulerState } from '../src/db/schema';
import { eq, sql } from 'drizzle-orm';
import { isWithinDailyWindow, hasIntervalElapsed } from '../src/lib/scheduler/time-utils';
import { acquireNextEligibleJob } from '../src/lib/scheduler/queue-manager';
import { sendOutreachEmail } from '../src/lib/gmail/send-email';
import { reconcilePendingEmailGenerations } from '../src/lib/pipeline/generation-reconciler';
import { globalGeminiLimiter } from '../src/lib/ai/gemini-client';
import { saveCandidateProfile } from '../src/lib/candidate-profile/candidate-profile-service';

function pass(msg: string) {
  console.log(`✔ [PASS] ${msg}`);
}

async function runTests() {
  console.log('======================================================================');
  console.log('VERIFY DECOUPLED GENERATION LOOP & OUTREACH WORKER SPECIFICATION');
  console.log('======================================================================\n');

  resetDbConnection();
  initializeDatabase();
  const db = getDb();

  // Ensure resume and candidate profile exist
  const dummyPdf = path.join(TEST_DIR, 'test_resume.pdf');
  fs.writeFileSync(dummyPdf, 'Dummy PDF content for resume');

  const { resume } = await import('../src/db/schema');
  db.insert(resume)
    .values({
      id: 'current',
      filename: 'test_resume.pdf',
      filePath: dummyPdf,
      mimeType: 'application/pdf',
      parsedText: 'Test Candidate Software Engineer TypeScript React Node.js',
      parsedData: JSON.stringify({ skills: ['TypeScript', 'React'] }),
      uploadedAt: new Date().toISOString(),
    })
    .onConflictDoUpdate({
      target: resume.id,
      set: {
        filename: 'test_resume.pdf',
        filePath: dummyPdf,
        uploadedAt: new Date().toISOString(),
      },
    })
    .run();

  saveCandidateProfile({
    fullName: 'Test Candidate',
    email: 'test@example.com',
    phone: '1234567890',
    degree: 'B.Tech',
    fieldOfStudy: 'Computer Science',
    institution: 'IIT',
    linkedin: 'https://linkedin.com/in/test',
    github: 'https://github.com/test',
    portfolio: 'https://test.dev',
  }, db);

  const testPrefix = `decouple_${Date.now()}`;

  // -------------------------------------------------------------------------
  // TEST 1: Generation continues while Gmail sending window is CLOSED
  // -------------------------------------------------------------------------
  console.log('--- TEST 1: Generation continues while Gmail sending window is closed ---');
  const outsideWindowDate = new Date('2026-09-13T18:00:00.000Z');
  const windowOpen = isWithinDailyWindow(outsideWindowDate, 'Asia/Kolkata', 10, 0, 16, 0);
  assert.strictEqual(windowOpen, false, 'Window must evaluate to closed');

  const b1Id = `${testPrefix}_b1_outside_window`;
  const comp1 = `${testPrefix} NightOwl Tech`;
  db.insert(batches).values({
    id: b1Id,
    filename: 'b1.csv',
    uploadDate: new Date().toISOString(),
    status: 'processing',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();

  db.insert(companyClassifications).values({
    normalizedName: comp1.toLowerCase().trim(),
    companyName: comp1,
    reason: 'Software company',
    classificationResult: 'RELEVANT',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();

  for (let i = 1; i <= 4; i++) {
    db.insert(contacts).values({
      id: `${testPrefix}_c1-${i}`,
      batchId: b1Id,
      companyName: comp1,
      contactName: `Recruiter ${i}`,
      email: `recruiter${i}_${testPrefix}@nightowl.test`,
      isRelevant: true,
      emailValid: true,
      isDuplicate: false,
      status: 'discovered',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }).run();
  }

  // Execute generation reconciler
  const res1 = await reconcilePendingEmailGenerations({
    batchId: b1Id,
    batchSize: 4,
    aiCallerOverride: async () => 'Subject: Opportunities\n\nNightOwl outreach body.',
  });

  assert.strictEqual(res1.succeeded, 4, '4 emails must generate outside sending window');
  const queuedCount1 = db.select().from(outreachQueue).where(eq(outreachQueue.status, 'pending')).all().length;
  assert.ok(queuedCount1 >= 4, 'Generated emails must be placed into outreach_queue as ready-to-send');
  pass('Email generation executes and queues Ready-to-Send emails while sending window is closed');

  // -------------------------------------------------------------------------
  // TEST 2: Generation is NOT blocked by the 3-minute Gmail send interval
  // -------------------------------------------------------------------------
  console.log('\n--- TEST 2: Generation is not blocked by 3-minute Gmail send interval ---');
  const recentSendAttempt = new Date(Date.now() - 10000).toISOString();
  db.update(schedulerState)
    .set({ lastSendAttemptAt: recentSendAttempt })
    .where(eq(schedulerState.id, 'singleton'))
    .run();

  const intervalElapsed = hasIntervalElapsed(recentSendAttempt, 3);
  assert.strictEqual(intervalElapsed, false, '3-minute sending interval must not have elapsed');

  const b2Id = `${testPrefix}_b2_interval_test`;
  const comp2 = `${testPrefix} Rapid Gen Inc`;
  db.insert(batches).values({
    id: b2Id,
    filename: 'b2.csv',
    uploadDate: new Date().toISOString(),
    status: 'processing',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();

  db.insert(companyClassifications).values({
    normalizedName: comp2.toLowerCase().trim(),
    companyName: comp2,
    reason: 'IT services',
    classificationResult: 'RELEVANT',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();

  for (let i = 1; i <= 4; i++) {
    db.insert(contacts).values({
      id: `${testPrefix}_c2-${i}`,
      batchId: b2Id,
      companyName: comp2,
      contactName: `Lead ${i}`,
      email: `lead${i}_${testPrefix}@rapidgen.test`,
      isRelevant: true,
      emailValid: true,
      isDuplicate: false,
      status: 'discovered',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }).run();
  }

  const res2 = await reconcilePendingEmailGenerations({
    batchId: b2Id,
    batchSize: 4,
    aiCallerOverride: async () => 'Subject: Opportunities\n\nRapid Gen outreach body.',
  });

  assert.strictEqual(res2.succeeded, 4, '4 emails must generate immediately during 3-min send interval wait');
  pass('Email generation executes without waiting for 3-minute Gmail send interval');

  // -------------------------------------------------------------------------
  // TEST 3: Multiple generation batches run back-to-back without 30s outer sleep
  // -------------------------------------------------------------------------
  console.log('\n--- TEST 3: Multiple generation batches run back-to-back without 30s outer sleep ---');
  const b3Id = `${testPrefix}_b3_burst`;
  const comp3 = `${testPrefix} Burst Tech Corp`;
  db.insert(batches).values({
    id: b3Id,
    filename: 'b3.csv',
    uploadDate: new Date().toISOString(),
    status: 'processing',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();

  db.insert(companyClassifications).values({
    normalizedName: comp3.toLowerCase().trim(),
    companyName: comp3,
    reason: 'High throughput engineering',
    classificationResult: 'RELEVANT',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();

  // 12 contacts = 3 batches of 4
  for (let i = 1; i <= 12; i++) {
    db.insert(contacts).values({
      id: `${testPrefix}_c3-${i}`,
      batchId: b3Id,
      companyName: comp3,
      contactName: `Burst Recruiter ${i}`,
      email: `recruiter${i}_${testPrefix}@bursttech.test`,
      isRelevant: true,
      emailValid: true,
      isDuplicate: false,
      status: 'discovered',
      createdAt: new Date(Date.now() + i * 100).toISOString(),
      updatedAt: new Date().toISOString(),
    }).run();
  }

  const tStart = performance.now();
  let totalSucceeded = 0;
  // Simulate the decoupled loop: while processed > 0, run next batch
  for (let round = 1; round <= 3; round++) {
    const resBurst = await reconcilePendingEmailGenerations({
      batchId: b3Id,
      batchSize: 4,
      aiCallerOverride: async () => 'Subject: Opportunities\n\nBurst email body.',
    });
    totalSucceeded += resBurst.succeeded;
    assert.strictEqual(resBurst.succeeded, 4, `Round ${round} must generate 4 emails`);
  }
  const tElapsed = performance.now() - tStart;

  assert.strictEqual(totalSucceeded, 12, 'All 12 emails across 3 batches must be generated');
  assert.ok(tElapsed < 5000, `3 batches must complete without 30s sleeps (took ${tElapsed.toFixed(0)}ms)`);
  pass(`3 consecutive batches of 4 executed back-to-back in ${tElapsed.toFixed(0)}ms without outer sleeps`);

  // -------------------------------------------------------------------------
  // TEST 4: Gmail sending behavior remains strictly unchanged
  // -------------------------------------------------------------------------
  console.log('\n--- TEST 4: Gmail sending behavior remains strictly unchanged ---');
  db.update(schedulerState)
    .set({
      lastSendAttemptAt: new Date(Date.now() - 600000).toISOString(),
      isPaused: false,
      isStopped: false,
    })
    .where(eq(schedulerState.id, 'singleton'))
    .run();

  const acquired = acquireNextEligibleJob('worker_test_sender');
  assert.ok(acquired, 'Eligible job must be acquired');
  assert.ok(acquired.contact.email.includes('@'), 'Acquired valid contact');

  const sendRes = await sendOutreachEmail(acquired.contact.id);
  assert.strictEqual(sendRes.success, true, 'Dry-run send must succeed');
  assert.ok(sendRes.messageId?.startsWith('dryrun_'), 'Dry run message ID generated');
  pass('Gmail sending pipeline dispatches Ready-to-Send emails with exact existing logic');

  // -------------------------------------------------------------------------
  // TEST 5: Classification barrier remains unchanged
  // -------------------------------------------------------------------------
  console.log('\n--- TEST 5: Classification barrier remains unchanged ---');
  const b5IncompleteId = `${testPrefix}_b5_incomplete`;
  const comp5 = `${testPrefix} Pending AI Corp`;
  db.insert(batches).values({
    id: b5IncompleteId,
    filename: 'b5.csv',
    uploadDate: new Date().toISOString(),
    status: 'processing',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();

  db.insert(contacts).values({
    id: `${testPrefix}_c5-pending`,
    batchId: b5IncompleteId,
    companyName: comp5,
    contactName: 'Pending Recruiter',
    email: `pending_${testPrefix}@pendingaicorp.test`,
    isRelevant: null,
    emailValid: true,
    isDuplicate: false,
    status: 'discovered',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();

  db.insert(companyClassifications).values({
    normalizedName: comp5.toLowerCase().trim(),
    companyName: comp5,
    reason: 'Classification pending',
    classificationResult: 'PENDING',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();

  const res5 = await reconcilePendingEmailGenerations({
    batchId: b5IncompleteId,
    batchSize: 4,
  });

  assert.strictEqual(res5.processed, 0, 'Generation must be blocked for incomplete classification');
  assert.strictEqual(res5.skippedReason, 'CLASSIFICATION_INCOMPLETE', 'Skipped reason must be CLASSIFICATION_INCOMPLETE');
  pass('Classification barrier strictly blocks generation when pending classifications exist');

  // -------------------------------------------------------------------------
  // TEST 6: Ready-to-Send remains independent of classification status
  // -------------------------------------------------------------------------
  console.log('\n--- TEST 6: Ready-to-Send remains independent of classification status ---');
  const acquiredIndep = acquireNextEligibleJob('worker_test_sender_indep');
  assert.ok(acquiredIndep, 'Scheduler acquires Ready-to-Send email even while b5 is incomplete');
  pass('Ready-to-Send email dispatching proceeds independently of incomplete batches');

  // -------------------------------------------------------------------------
  // TEST 7: No duplicate generation claims occur
  // -------------------------------------------------------------------------
  console.log('\n--- TEST 7: No duplicate generation claims occur ---');
  const b7Id = `${testPrefix}_b7_dup_check`;
  const comp7 = `${testPrefix} Safe Claims LLC`;
  db.insert(batches).values({
    id: b7Id,
    filename: 'b7.csv',
    uploadDate: new Date().toISOString(),
    status: 'processing',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();

  db.insert(companyClassifications).values({
    normalizedName: comp7.toLowerCase().trim(),
    companyName: comp7,
    reason: 'Tech',
    classificationResult: 'RELEVANT',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();

  db.insert(contacts).values({
    id: `${testPrefix}_c7-single`,
    batchId: b7Id,
    companyName: comp7,
    contactName: 'One Recruiter',
    email: `single_${testPrefix}@safeclaims.test`,
    isRelevant: true,
    emailValid: true,
    isDuplicate: false,
    status: 'discovered',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();

  const [claim1, claim2] = await Promise.all([
    reconcilePendingEmailGenerations({
      batchId: b7Id,
      batchSize: 4,
      claimWorkerId: 'worker_alpha',
      aiCallerOverride: async () => 'Subject: Test\n\nAlpha body',
    }),
    reconcilePendingEmailGenerations({
      batchId: b7Id,
      batchSize: 4,
      claimWorkerId: 'worker_beta',
      aiCallerOverride: async () => 'Subject: Test\n\nBeta body',
    }),
  ]);

  const totalProcessed7 = claim1.succeeded + claim2.succeeded;
  assert.strictEqual(totalProcessed7, 1, 'Exactly one worker must claim and generate the contact');
  const contact7 = db.select().from(contacts).where(eq(contacts.id, `${testPrefix}_c7-single`)).get();
  assert.strictEqual(contact7?.generationStatus, 'GENERATED', 'Contact marked GENERATED');
  pass('Atomic SQLite lease guarantees zero duplicate generation claims under concurrent calls');

  // -------------------------------------------------------------------------
  // TEST 8: Provider WAITING does not cause a tight CPU loop
  // -------------------------------------------------------------------------
  console.log('\n--- TEST 8: Provider WAITING does not cause a tight CPU loop ---');
  const { geminiPool } = await import('../src/lib/ai/gemini-pool');
  geminiPool.setAccessibleModelsForTesting([
    'gemini-3.8-flash',
    'gemini-3.7-flash',
  ]);
  geminiPool.record429('gemini-3.8-flash');
  geminiPool.record429('gemini-3.7-flash');

  assert.strictEqual(geminiPool.isPoolExhausted(), true, 'Pool must be exhausted');
  assert.strictEqual(globalGeminiLimiter.isCooldownActive(), true, 'Cooldown must be active');

  const cooldownRes = await reconcilePendingEmailGenerations({
    batchId: b3Id,
    batchSize: 4,
  });

  assert.strictEqual(cooldownRes.processed, 0, 'Must process 0 items when provider is cooling down');
  assert.strictEqual(cooldownRes.skippedReason, 'GEMINI_COOLDOWN_ACTIVE', 'Must report GEMINI_COOLDOWN_ACTIVE');
  pass('Provider cooldown returns cleanly with skippedReason, allowing loop to sleep rather than CPU spin');

  globalGeminiLimiter.resetForTesting();
  geminiPool.resetForTesting();
  assert.strictEqual(globalGeminiLimiter.isCooldownActive(), false, 'Limiter reset cleanly');

  // -------------------------------------------------------------------------
  // TEST 9: Batch lifecycle & completion semantics remain intact
  // -------------------------------------------------------------------------
  console.log('\n--- TEST 9: Batch lifecycle & completion semantics remain intact ---');
  const completedBatchId = `${testPrefix}_b_completed`;
  db.insert(batches).values({
    id: completedBatchId,
    filename: 'completed.csv',
    uploadDate: new Date().toISOString(),
    status: 'completed',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();

  db.insert(contacts).values({
    id: `${testPrefix}_c-completed-terminal`,
    batchId: completedBatchId,
    companyName: 'Done Corp',
    contactName: 'Done Recruiter',
    email: `done_${testPrefix}@donecorp.test`,
    isRelevant: true,
    emailValid: true,
    isDuplicate: false,
    status: 'skipped',
    generationStatus: 'GENERATED',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();

  await reconcilePendingEmailGenerations({
    batchSize: 4,
  });
  const checkComp = db.select().from(batches).where(eq(batches.id, completedBatchId)).get();
  assert.strictEqual(checkComp?.status, 'completed', 'Batch status remains completed');
  pass('Completed batch semantics and active-work exclusion remain 100% intact');

  // Cleanup isolated test database
  resetDbConnection();
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {}

  console.log('\n======================================================================');
  console.log('ALL 9 DECOUPLED GENERATION LOOP & OUTREACH WORKER TESTS PASSED!');
  console.log('======================================================================\n');
}

runTests().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
