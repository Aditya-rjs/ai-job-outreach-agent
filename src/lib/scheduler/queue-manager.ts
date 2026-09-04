import { getDb } from '@/db';
import { contacts, batches, outreachQueue, schedulerState, settings } from '@/db/schema';
import { eq, and, sql, asc, desc } from 'drizzle-orm';
import { getLocalDateString, getConfiguredTimezone } from './time-utils';
import type { QueueItem, Contact } from '@/types';

const QUEUE_ITEM_LEASE_MS = 60 * 1000; // 60 seconds lease per item
const MAX_TRANSIENT_ATTEMPTS = 3;

export interface NextEligibleJob {
  queueItem: QueueItem;
  contact: Contact;
}

export interface BatchCompletionSummary {
  batchId: string;
  filename: string;
  totalRecords: number;
  relevantCompanies: number;
  emailsSent: number;
  emailsFailed: number;
  emailsSkipped: number;
  emailsUncertain: number;
  completedAt: string;
  message: string;
}

/**
 * Reconciles the daily sent counter at midnight in the configured timezone.
 */
export function reconcileDailyQuota(): { todayDate: string; todaySentCount: number; dailyLimit: number; isQuotaReached: boolean } {
  const db = getDb();
  const tz = getConfiguredTimezone();
  const currentLocalDate = getLocalDateString(new Date(), tz);

  const state = db.select().from(schedulerState).where(eq(schedulerState.id, 'singleton')).get();
  const dailyLimit = state?.dailyLimit ?? 30;

  if (!state || state.todayDate !== currentLocalDate) {
    // Midnight rolled over in configured timezone: reset daily counter
    db.update(schedulerState)
      .set({
        todayDate: currentLocalDate,
        todaySentCount: 0,
      })
      .where(eq(schedulerState.id, 'singleton'))
      .run();

    return {
      todayDate: currentLocalDate,
      todaySentCount: 0,
      dailyLimit,
      isQuotaReached: false,
    };
  }

  return {
    todayDate: currentLocalDate,
    todaySentCount: state.todaySentCount,
    dailyLimit,
    isQuotaReached: state.todaySentCount >= dailyLimit,
  };
}

/**
 * Recovers stale processing records resulting from unexpected worker crashes.
 */
export function recoverStaleProcessingItems(): number {
  const db = getDb();
  const nowIso = new Date().toISOString();

  // Find queue items stuck in 'processing' whose lease has expired
  const staleItems = db
    .select()
    .from(outreachQueue)
    .where(
      and(
        eq(outreachQueue.status, 'processing'),
        sql`lease_expires_at IS NOT NULL AND lease_expires_at < ${nowIso}`
      )
    )
    .all();

  let recoveredCount = 0;

  for (const item of staleItems) {
    const contact = db.select().from(contacts).where(eq(contacts.id, item.contactId)).get();

    if (!contact) {
      db.update(outreachQueue)
        .set({ status: 'failed', errorMessage: 'Contact record missing during recovery', updatedAt: nowIso })
        .where(eq(outreachQueue.id, item.id))
        .run();
      continue;
    }

    // Check if definitely sent
    if (contact.status === 'sent' || contact.sentAt) {
      db.update(outreachQueue)
        .set({ status: 'completed', leaseExpiresAt: null, workerId: null, updatedAt: nowIso })
        .where(eq(outreachQueue.id, item.id))
        .run();
      continue;
    }

    // Check if uncertain (NEVER automatically retry an uncertain dispatch!)
    if (contact.status === 'uncertain') {
      db.update(outreachQueue)
        .set({ status: 'uncertain', leaseExpiresAt: null, workerId: null, updatedAt: nowIso })
        .where(eq(outreachQueue.id, item.id))
        .run();
      console.warn(`[Crash Recovery] Preserved uncertain status for queue item ${item.id} (${contact.email}) to prevent duplicate.`);
      continue;
    }

    // Definitely not sent - check attempt count
    if (item.attempts >= MAX_TRANSIENT_ATTEMPTS) {
      db.update(outreachQueue)
        .set({
          status: 'failed',
          leaseExpiresAt: null,
          workerId: null,
          errorMessage: 'Maximum retry attempts exceeded after worker crash recovery.',
          updatedAt: nowIso,
        })
        .where(eq(outreachQueue.id, item.id))
        .run();

      db.update(contacts)
        .set({ status: 'failed', updatedAt: nowIso })
        .where(eq(contacts.id, contact.id))
        .run();
    } else {
      // Safe to return to pending
      db.update(outreachQueue)
        .set({
          status: 'pending',
          leaseExpiresAt: null,
          workerId: null,
          updatedAt: nowIso,
        })
        .where(eq(outreachQueue.id, item.id))
        .run();

      db.update(contacts)
        .set({ status: 'generated', updatedAt: nowIso })
        .where(eq(contacts.id, contact.id))
        .run();

      recoveredCount++;
      console.log(`[Crash Recovery] Recovered stale queue item ${item.id} (${contact.email}) back to pending.`);
    }
  }

  return recoveredCount;
}

/**
 * Fetches the next eligible queue item and acquires an atomic lease for processing.
 */
export function acquireNextEligibleJob(workerId: string): NextEligibleJob | null {
  const db = getDb();
  const now = new Date();
  const nowIso = now.toISOString();
  const leaseExpiresAt = new Date(now.getTime() + QUEUE_ITEM_LEASE_MS).toISOString();

  // Find candidate items ordered by: priority desc, scheduledFor asc, createdAt asc, id asc
  const candidates = db
    .select({
      queue: outreachQueue,
      contact: contacts,
    })
    .from(outreachQueue)
    .innerJoin(contacts, eq(outreachQueue.contactId, contacts.id))
    .innerJoin(batches, eq(contacts.batchId, batches.id))
    .where(
      sql`
        (
          outreach_queue.status = 'pending'
          OR (
            outreach_queue.status = 'failed'
            AND outreach_queue.attempts < ${MAX_TRANSIENT_ATTEMPTS}
            AND outreach_queue.next_retry_at IS NOT NULL
            AND outreach_queue.next_retry_at <= ${nowIso}
          )
        )
        AND batches.status NOT IN ('cancelled', 'deleted')
        AND contacts.status IN ('generated', 'queued')
        AND (contacts.is_relevant IS NULL OR contacts.is_relevant = 1)
        AND contacts.is_duplicate = 0
        AND contacts.email_valid = 1
        AND contacts.sent_at IS NULL
        AND contacts.email_subject IS NOT NULL
        AND contacts.email_body IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM global_email_history
          WHERE global_email_history.email = LOWER(TRIM(contacts.email))
            AND (global_email_history.status = 'sent' OR global_email_history.sent_at IS NOT NULL)
        )
      `
    )
    .orderBy(
      desc(outreachQueue.priority),
      asc(outreachQueue.createdAt),
      asc(outreachQueue.id)
    )
    .limit(1)
    .all();

  if (candidates.length === 0) {
    return null;
  }

  const { queue: candidateQueue, contact: candidateContact } = candidates[0];

  // Atomically claim the queue item with worker lease
  const claimResult = db.run(sql`
    UPDATE outreach_queue
    SET
      status = 'processing',
      worker_id = ${workerId},
      lease_expires_at = ${leaseExpiresAt},
      last_attempt_at = ${nowIso},
      updated_at = ${nowIso}
    WHERE id = ${candidateQueue.id}
      AND (status = 'pending' OR (status = 'failed' AND attempts < ${MAX_TRANSIENT_ATTEMPTS}))
  `);

  if (claimResult.changes === 0) {
    // Another worker grabbed it simultaneously
    return null;
  }

  return {
    queueItem: {
      ...candidateQueue,
      status: 'processing',
      workerId,
      leaseExpiresAt,
      lastAttemptAt: nowIso,
    } as QueueItem,
    contact: candidateContact as Contact,
  };
}

/**
 * Checks for completed batches and persists completion notifications.
 */
export function checkBatchCompletions(): BatchCompletionSummary[] {
  const db = getDb();
  // Strictly ignore batches that are already completed, deleted, or cancelled
  const allBatches = db
    .select()
    .from(batches)
    .where(sql`status NOT IN ('completed', 'deleted', 'cancelled')`)
    .all();
  const completedSummaries: BatchCompletionSummary[] = [];

  for (const batch of allBatches) {
    if (batch.status === 'deleted' || batch.status === 'cancelled' || batch.status === 'completed') {
      continue;
    }

    // Check if there are any remaining pending, generating, queued, or processing contacts
    const remaining = db
      .select({ count: sql<number>`count(*)` })
      .from(contacts)
      .where(
        and(
          eq(contacts.batchId, batch.id),
          sql`status IN ('discovered', 'queued', 'generating', 'generated', 'processing', 'sending')`
        )
      )
      .get()?.count ?? 0;

    if (remaining === 0) {
      const stats = db
        .select({
          totalRecords: sql<number>`count(*)`,
          relevantCompanies: sql<number>`SUM(CASE WHEN is_relevant = 1 THEN 1 ELSE 0 END)`,
          emailsSent: sql<number>`SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END)`,
          emailsFailed: sql<number>`SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END)`,
          emailsSkipped: sql<number>`SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END)`,
          emailsUncertain: sql<number>`SUM(CASE WHEN status = 'uncertain' THEN 1 ELSE 0 END)`,
        })
        .from(contacts)
        .where(eq(contacts.batchId, batch.id))
        .get();

      const nowIso = new Date().toISOString();

      // Mark batch as completed - enforcing status integrity guard
      db.update(batches)
        .set({
          status: 'completed',
          updatedAt: nowIso,
        })
        .where(
          and(
            eq(batches.id, batch.id),
            sql`status NOT IN ('completed', 'deleted', 'cancelled')`
          )
        )
        .run();

      // Check if completion notification has already been recorded
      const notificationKey = `batch_completed_notice_${batch.id}`;
      const existingNotice = db.select().from(settings).where(eq(settings.key, notificationKey)).get();

      const summary: BatchCompletionSummary = {
        batchId: batch.id,
        filename: batch.filename,
        totalRecords: stats?.totalRecords ?? batch.totalRecords,
        relevantCompanies: stats?.relevantCompanies ?? batch.relevantCompanies,
        emailsSent: stats?.emailsSent ?? batch.emailsSent,
        emailsFailed: stats?.emailsFailed ?? batch.emailsFailed,
        emailsSkipped: stats?.emailsSkipped ?? (batch.irrelevantCompanies + batch.duplicateContacts),
        emailsUncertain: stats?.emailsUncertain ?? 0,
        completedAt: nowIso,
        message: 'All eligible emails from this file have been sent. Upload another file.',
      };

      if (!existingNotice) {
        db.insert(settings)
          .values({
            key: notificationKey,
            value: JSON.stringify(summary),
            updatedAt: nowIso,
          })
          .run();
      }

      completedSummaries.push(summary);
    }
  }

  return completedSummaries;
}
