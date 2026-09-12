import path from 'path';
import fs from 'fs';
import assert from 'assert';

const TEST_DIR = path.join(process.cwd(), 'data', `test-rts-${Date.now()}`);
fs.mkdirSync(TEST_DIR, { recursive: true });

process.env.DATA_DIR = TEST_DIR;
(process.env as Record<string, string>).NODE_ENV = 'test';
process.env.OUTREACH_DRY_RUN = 'true';

import { getDb, resetDbConnection } from '../src/db';
import { initializeDatabase } from '../src/db/migrate';
import {
  batches,
  contacts,
  companyClassifications,
  outreachQueue,
  schedulerState,
  resume,
} from '../src/db/schema';
import { sql, eq } from 'drizzle-orm';
import { isBatchClassificationComplete } from '../src/lib/pipeline/classification-reconciler';
import { reconcilePendingEmailGenerations } from '../src/lib/pipeline/generation-reconciler';
import { acquireNextEligibleJob } from '../src/lib/scheduler/queue-manager';
import { getProcessingPipelineStats } from '../src/lib/processing-queries';
import { sendOutreachEmail } from '../src/lib/gmail/send-email';
import { saveCandidateProfile } from '../src/lib/candidate-profile/candidate-profile-service';

async function runRegressionSuite() {
  console.log('======================================================================');
  console.log('VERIFY READY-TO-SEND INDEPENDENCE FROM CLASSIFICATION BARRIER');
  console.log('======================================================================\n');

  resetDbConnection();
  initializeDatabase();
  const db = getDb();

  // 1. Seed active resume and candidate profile
  const dummyPdf = path.join(TEST_DIR, 'test_resume.pdf');
  fs.writeFileSync(dummyPdf, 'Dummy PDF content for resume');

  db.insert(resume)
    .values({
      id: 'current',
      filename: 'test_resume.pdf',
      filePath: dummyPdf,
      mimeType: 'application/pdf',
      parsedText: 'John Doe Software Engineer Typescript React Node.js',
      parsedData: JSON.stringify({ skills: ['Typescript', 'React'] }),
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
    fullName: 'John Doe',
    email: 'john@example.com',
    degree: 'B.Tech',
    fieldOfStudy: 'Computer Science',
    institution: 'University of Tech',
    skills: {
      programmingLanguages: ['TypeScript', 'JavaScript'],
      webDevelopment: ['React', 'Next.js'],
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

  // 2. Setup Scheduler in Open Window
  db.insert(schedulerState)
    .values({
      id: 'singleton',
      isPaused: false,
      todaySentCount: 0,
      todayDate: new Date().toISOString().split('T')[0],
      timezone: 'Asia/Kolkata',
      dailyLimit: 100,
      intervalMinutes: 3,
      startHour: 0,
      startMinute: 0,
      endHour: 23,
      endMinute: 59,
    })
    .onConflictDoUpdate({
      target: schedulerState.id,
      set: {
        isPaused: false,
        startHour: 0,
        startMinute: 0,
        endHour: 23,
        endMinute: 59,
      },
    })
    .run();

  const batchId = 'batch-rts-independent-test';
  db.insert(batches)
    .values({
      id: batchId,
      filename: 'HR_Data_Test.xlsx',
      uploadDate: new Date().toISOString(),
      status: 'processing',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .run();

  // 3. Insert Contact 1: Belonging to an unclassified company (AI Search Pending)
  const pendingCompany = 'Acme Search Pending Ltd';
  db.insert(contacts)
    .values({
      id: 'c-pending-1',
      batchId: batchId,
      companyName: pendingCompany,
      contactName: 'Pending Person',
      email: 'pending@acmesearch.com',
      isRelevant: null,
      emailValid: true,
      isDuplicate: false,
      status: 'discovered',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .run();

  db.insert(companyClassifications)
    .values({
      normalizedName: 'acme search pending ltd',
      companyName: pendingCompany,
      reason: 'Awaiting domain and job classification',
      classificationResult: 'PENDING',
      retryRound: 0,
      retryCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .run();

  // 4. Insert Contact 2: Already verified Relevant, but email NOT generated yet
  db.insert(contacts)
    .values({
      id: 'c-relevant-not-gen',
      batchId: batchId,
      companyName: 'Verified Relevant Tech',
      contactName: 'Bob Developer',
      email: 'bob@relevanttech.com',
      isRelevant: true,
      emailValid: true,
      isDuplicate: false,
      status: 'discovered',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .run();

  // 5. Insert Contact 3: Ready to Send (already generated)
  const readyEmail = 'alice@readycompany.com';
  db.insert(contacts)
    .values({
      id: 'c-ready-1',
      batchId: batchId,
      companyName: 'Ready Company Inc',
      contactName: 'Alice Recruiter',
      email: readyEmail,
      isRelevant: true,
      emailValid: true,
      isDuplicate: false,
      status: 'generated',
      emailSubject: 'Application for Senior Engineer - Alice',
      emailBody: 'Dear Alice, I noticed your tech stack and would love to connect...',
      resumeVersion: (db.select().from(resume).where(eq(resume.id, 'current')).get())?.uploadedAt,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .run();

  db.insert(outreachQueue)
    .values({
      id: 'oq-ready-1',
      contactId: 'c-ready-1',
      priority: 10,
      status: 'pending',
      attempts: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .run();

  // -------------------------------------------------------------------------
  // TEST 1: Verify Initial Dashboard Metrics & State
  // -------------------------------------------------------------------------
  console.log('--- TEST 1: Initial State Verification ---');
  const stats = getProcessingPipelineStats(batchId);
  assert(stats !== null, 'Stats must exist for batch');
  console.log(`Pipeline stats: AI Search Pending = ${stats.aiSearchPending}, Ready to Send = ${stats.readyToSend}`);
  assert.strictEqual(stats.aiSearchPending, 1, 'AI Search Pending must be 1');
  assert.strictEqual(stats.readyToSend, 1, 'Ready to Send must be 1');
  assert.strictEqual(stats.emailsGenerating, 0, 'Emails Generating must be 0 (barrier blocked)');

  const isClassComplete = isBatchClassificationComplete(db, batchId);
  assert.strictEqual(isClassComplete, false, 'Batch classification must be incomplete');
  console.log('✔ [PASS] Initial state confirmed: AI Search Pending > 0 and Ready to Send > 0\n');

  // -------------------------------------------------------------------------
  // TEST 2: Classification Barrier STILL BLOCKS New Email Generation
  // -------------------------------------------------------------------------
  console.log('--- TEST 2: Proving Classification Barrier Still Blocks Generation ---');
  const genResult = await reconcilePendingEmailGenerations({ batchId });
  assert.strictEqual(genResult.processed, 0, 'Generation reconciler must process 0 contacts');
  assert.strictEqual(genResult.skippedReason, 'CLASSIFICATION_INCOMPLETE', 'Skipped reason must be CLASSIFICATION_INCOMPLETE');

  const ungenContact = db.select().from(contacts).where(eq(contacts.id, 'c-relevant-not-gen')).get();
  assert.strictEqual(ungenContact?.status, 'discovered', 'Un-generated contact must remain in discovered status');
  console.log('✔ [PASS] Classification barrier strictly prevents new email generation while AI Search is pending\n');

  // -------------------------------------------------------------------------
  // TEST 3: Scheduler Successfully Acquires Ready-to-Send Email Despite Barrier
  // -------------------------------------------------------------------------
  console.log('--- TEST 3: Proving Scheduler Acquires Ready-to-Send Email ---');
  const acquired = acquireNextEligibleJob('worker_regression_test');
  assert(acquired !== null, 'acquireNextEligibleJob MUST lease the Ready-to-Send job');
  assert.strictEqual(acquired.contact.id, 'c-ready-1', 'Leased job must be the ready contact c-ready-1');
  assert.strictEqual(acquired.queueItem.status, 'processing', 'Queue item status must be updated to processing');
  assert.strictEqual(acquired.queueItem.workerId, 'worker_regression_test', 'Worker ID must be recorded on lease');
  console.log(`✔ [PASS] acquireNextEligibleJob successfully acquired "${acquired.contact.email}" independently of AI Search Pending\n`);

  // -------------------------------------------------------------------------
  // TEST 4: Sending Execution Succeeds
  // -------------------------------------------------------------------------
  console.log('--- TEST 4: Proving Sending Pipeline Dispatches the Email ---');
  const sendResult = await sendOutreachEmail(acquired.contact.id);
  assert.strictEqual(sendResult.success, true, 'sendOutreachEmail must succeed in dry-run mode');

  const sentContact = db.select().from(contacts).where(eq(contacts.id, 'c-ready-1')).get();
  assert(sentContact, 'Contact must exist');
  assert.strictEqual(sentContact.status, 'simulated', 'Contact must transition to simulated status');
  assert(sentContact.gmailMessageId !== null, 'gmailMessageId must be populated with simulated ID');

  const updatedQueueItem = db.select().from(outreachQueue).where(eq(outreachQueue.id, 'oq-ready-1')).get();
  assert.strictEqual(updatedQueueItem?.status, 'completed', 'Queue item must transition to completed');

  // Re-verify dashboard stats
  const postSendStats = getProcessingPipelineStats(batchId);
  assert(postSendStats !== null, 'Stats must exist');
  assert.strictEqual(postSendStats.readyToSend, 0, 'Ready to Send dropped to 0 after send');
  assert.strictEqual(postSendStats.aiSearchPending, 1, 'AI Search Pending remains 1 (unaffected by send)');
  console.log('✔ [PASS] Ready-to-Send email successfully dispatched while AI Search Pending remains active\n');

  // -------------------------------------------------------------------------
  // Clean up test directory
  // -------------------------------------------------------------------------
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {}

  console.log('======================================================================');
  console.log('ALL REGRESSION TESTS PASSED CLEANLY: READY-TO-SEND IS FULLY INDEPENDENT');
  console.log('======================================================================\n');
}

runRegressionSuite().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
