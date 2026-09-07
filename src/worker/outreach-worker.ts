import { initializeDatabase } from '@/db/migrate';
import { getDb } from '@/db';
import { schedulerState, batches, outreachQueue } from '@/db/schema';
import { eq, sql } from 'drizzle-orm';
import {
  acquireWorkerLease,
  renewWorkerLease,
  releaseWorkerLease,
} from '@/lib/scheduler/worker-lease';
import {
  reconcileDailyQuota,
  recoverStaleProcessingItems,
  acquireNextEligibleJob,
  checkBatchCompletions,
} from '@/lib/scheduler/queue-manager';
import {
  getConfiguredTimezone,
  isWithinDailyWindow,
  getNextDailyWindowDate,
  hasIntervalElapsed,
  computeNextEligibleSendTime,
} from '@/lib/scheduler/time-utils';
import { getGmailConnectionStatus } from '@/lib/gmail/gmail-client';
import { sendOutreachEmail } from '@/lib/gmail/send-email';
import { reconcilePendingClassifications } from '@/lib/pipeline/classification-reconciler';
import { reconcilePendingEmailGenerations } from '@/lib/pipeline/generation-reconciler';

const WORKER_ID = `worker_${process.pid}_${Math.random().toString(36).substring(2, 8)}`;
let isShuttingDown = false;

// Initialize database schema and default records
initializeDatabase();

console.log('======================================================================');
console.log(`[Outreach Worker] Starting persistent queue worker: ${WORKER_ID}`);
console.log(`[Outreach Worker] Timezone: ${getConfiguredTimezone()}`);
console.log(`[Outreach Worker] Dry-run mode: ${process.env.OUTREACH_DRY_RUN === 'true' ? 'ENABLED (Safe simulation)' : 'DISABLED (Real Gmail API)'}`);
console.log('======================================================================');

// Register graceful shutdown handlers
function handleShutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\n[Outreach Worker] Received ${signal}. Releasing worker lease and shutting down gracefully...`);
  try {
    releaseWorkerLease(WORKER_ID);
  } catch (err) {
    console.error('[Outreach Worker] Error releasing lease during shutdown:', err);
  }
  process.exit(0);
}

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

let lastClassificationReconcileAt = 0;
let lastEmailGenerationReconcileAt = 0;

/**
 * Main persistent worker loop.
 */
async function runWorkerLoop() {
  while (!isShuttingDown) {
    try {
      // 1. Acquire or renew persistent worker lease
      const lease = acquireWorkerLease(WORKER_ID);
      if (!lease.acquired) {
        console.log(`[Outreach Worker] Waiting for worker lease... (${lease.reason})`);
        await sleep(15000);
        continue;
      }
      // Renew lease heartbeat
      renewWorkerLease(WORKER_ID);

      // 2. Crash Recovery: reconcile stale processing records
      const recovered = recoverStaleProcessingItems();
      if (recovered > 0) {
        console.log(`[Outreach Worker] Recovered ${recovered} stale queue items after crash.`);
      }

      // Reconcile any pending company classifications due for retry
      if (Date.now() - lastClassificationReconcileAt >= 30000) {
        lastClassificationReconcileAt = Date.now();
        await reconcilePendingClassifications().catch((err) =>
          console.warn('[Outreach Worker] Error reconciling pending classifications:', err)
        );
      }

      // Autonomous AI Email Generation: continuous background preparation (send-ahead)
      if (Date.now() - lastEmailGenerationReconcileAt >= 15000) {
        lastEmailGenerationReconcileAt = Date.now();
        await reconcilePendingEmailGenerations({ claimWorkerId: WORKER_ID }).catch((err) =>
          console.warn('[Outreach Worker] Error reconciling pending email generations:', err)
        );
      }


      // 3. Check scheduler pause / stop controls
      const db = getDb();
      const state = db.select().from(schedulerState).where(eq(schedulerState.id, 'singleton')).get();

      if (!state) {
        await sleep(5000);
        continue;
      }

      if (state.isStopped) {
        // Stop state: complete halt until user explicitly resumes
        await sleep(10000);
        continue;
      }

      if (state.isPaused) {
        // Paused state: wait until unpaused
        await sleep(5000);
        continue;
      }

      // 4. Check Gmail connection status (unless dry-run)
      const isDryRun = process.env.OUTREACH_DRY_RUN === 'true';
      if (!isDryRun) {
        const gmailStatus = await getGmailConnectionStatus();
        if (!gmailStatus.connected) {
          console.warn('[Outreach Worker] Gmail account not connected. Automatic outreach paused.');
          await sleep(20000);
          continue;
        }
      }

      // 5. Daily Counter Reconciliation (Asia/Kolkata date boundary)
      reconcileDailyQuota();
      const timezone = state.timezone || getConfiguredTimezone();
      const startHour = state.startHour ?? 10;
      const startMinute = state.startMinute ?? 0;
      const endHour = state.endHour ?? 16;
      const endMinute = state.endMinute ?? 0;
      const intervalMinutes = state.intervalMinutes ?? 3;

      // 6. Check 10:00 AM - 4:00 PM Daily Sending Window (IST)
      const now = new Date();
      if (!isWithinDailyWindow(now, timezone, startHour, startMinute, endHour, endMinute)) {
        const nextWindow = getNextDailyWindowDate(now, timezone, startHour, startMinute, endHour, endMinute);
        const nextIso = nextWindow.toISOString();

        db.update(schedulerState)
          .set({ nextSendAt: nextIso })
          .where(eq(schedulerState.id, 'singleton'))
          .run();

        console.log(`[Outreach Worker] Outside daily sending window (10:00 AM - 4:00 PM ${timezone}). Next window opens at ${nextIso}.`);
        await sleep(30000);
        continue;
      }

      // 7. Check 3-Minute Interval Spacing
      const lastAttempt = state.lastSendAttemptAt;
      if (!hasIntervalElapsed(lastAttempt, intervalMinutes)) {
        const nextEligibleIso = computeNextEligibleSendTime({
          lastSendAttemptAt: lastAttempt,
          intervalMinutes,
          timezone,
          startHour,
          startMinute,
          endHour,
          endMinute,
          now,
        });

        db.update(schedulerState)
          .set({ nextSendAt: nextEligibleIso })
          .where(eq(schedulerState.id, 'singleton'))
          .run();

        const waitMs = Math.max(5000, new Date(nextEligibleIso).getTime() - now.getTime());
        console.log(`[Outreach Worker] Enforcing ${intervalMinutes}-min interval spacing. Waiting ${Math.ceil(waitMs / 1000)}s...`);
        await sleep(Math.min(waitMs, 30000));
        continue;
      }

      // 8. Fetch Next Eligible Job
      const nextJob = acquireNextEligibleJob(WORKER_ID);

      if (!nextJob) {
        // No pending items to send right now
        checkBatchCompletions();

        db.update(schedulerState)
          .set({ nextSendAt: null })
          .where(eq(schedulerState.id, 'singleton'))
          .run();

        await sleep(10000);
        continue;
      }

      // 9. Execute Outreach Send
      const { queueItem, contact } = nextJob;
      const attemptTimestamp = new Date().toISOString();

      // Verify parent batch is still active and has not been deleted/cancelled
      const parentBatch = db.select().from(batches).where(eq(batches.id, contact.batchId)).get();
      if (!parentBatch || parentBatch.status === 'deleted' || parentBatch.status === 'cancelled') {
        console.warn(`[Outreach Worker] Parent batch ${contact.batchId} was deleted/cancelled. Aborting send for ${contact.email}.`);
        db.update(outreachQueue)
          .set({ status: 'cancelled', updatedAt: attemptTimestamp })
          .where(eq(outreachQueue.id, queueItem.id))
          .run();
        continue;
      }

      console.log(`\n----------------------------------------------------------------------`);
      console.log(`[Outreach Worker] Processing queue item ${queueItem.id} for: ${contact.email} (${contact.companyName || 'Unknown Company'})`);
      console.log(`[Outreach Worker] Attempt count: ${queueItem.attempts + 1}`);

      const sendResult = await sendOutreachEmail(contact.id);

      if (sendResult.success) {
        if (isDryRun) {
          console.log(`[Outreach Worker] SIMULATED SEND — no Gmail message dispatched for ${contact.email} (Simulated ID: ${sendResult.messageId})`);
          // Dry-run simulation: increment todaySimulatedCount; do NOT consume real todaySentCount!
          db.update(schedulerState)
            .set({
              todaySimulatedCount: sql`${schedulerState.todaySimulatedCount} + 1`,
              lastSendAt: attemptTimestamp,
              lastSendAttemptAt: attemptTimestamp,
              nextSendAt: new Date(Date.now() + intervalMinutes * 60 * 1000).toISOString(),
            })
            .where(eq(schedulerState.id, 'singleton'))
            .run();
        } else {
          console.log(`[Outreach Worker] Gmail send successful for ${contact.email}! Message ID: ${sendResult.messageId}`);
          // Real send: increment todaySentCount for daily tracking and dashboard metrics (no hard daily send limit)
          db.update(schedulerState)
            .set({
              todaySentCount: sql`${schedulerState.todaySentCount} + 1`,
              lastSendAt: attemptTimestamp,
              lastSendAttemptAt: attemptTimestamp,
              nextSendAt: new Date(Date.now() + intervalMinutes * 60 * 1000).toISOString(),
            })
            .where(eq(schedulerState.id, 'singleton'))
            .run();
        }

        // Check if this send completed a batch
        checkBatchCompletions();

        // Enforce the 3-minute gap
        console.log(`[Outreach Worker] Send complete. Sleeping for ${intervalMinutes} minutes before next eligible send attempt...`);
        await sleep(intervalMinutes * 60 * 1000);
      } else {
        console.warn(`[Outreach Worker] Send failed for ${contact.email}: ${sendResult.error} (${sendResult.errorCategory})`);
        checkBatchCompletions();

        if (sendResult.errorCategory === 'validation' || sendResult.errorCategory === 'duplicate') {
          // Validation/duplicate checks failed prior to Gmail dispatch.
          // No send was attempted. Do NOT advance 3-minute send pacing; proceed immediately to next eligible send.
          console.log(`[Outreach Worker] Non-dispatch validation/duplicate resolution. Proceeding to next job without 3-minute wait.`);
          await sleep(1000);
        } else if (sendResult.errorCategory === 'uncertain') {
          // Uncertain outcome: Gmail API call was made but connection dropped.
          // Anti-duplicate protection: Preserved as uncertain; never retried.
          // Enforce 3-minute pacing to protect network.
          db.update(schedulerState)
            .set({
              lastSendAttemptAt: attemptTimestamp,
              nextSendAt: new Date(Date.now() + intervalMinutes * 60 * 1000).toISOString(),
            })
            .where(eq(schedulerState.id, 'singleton'))
            .run();

          console.log(`[Outreach Worker] Uncertain outcome recorded. Enforcing ${intervalMinutes}-min gap before next send attempt...`);
          await sleep(intervalMinutes * 60 * 1000);
        } else {
          // Dispatch attempt failed (auth, network, etc.).
          // Enforce 3-minute pacing.
          db.update(schedulerState)
            .set({
              lastSendAttemptAt: attemptTimestamp,
              nextSendAt: new Date(Date.now() + intervalMinutes * 60 * 1000).toISOString(),
            })
            .where(eq(schedulerState.id, 'singleton'))
            .run();

          console.log(`[Outreach Worker] Send error encountered. Sleeping for ${intervalMinutes} minutes before next attempt...`);
          await sleep(intervalMinutes * 60 * 1000);
        }
      }
    } catch (loopErr) {
      console.error('[Outreach Worker] Unexpected error in worker loop:', loopErr);
      await sleep(10000);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Start the worker process
runWorkerLoop();
