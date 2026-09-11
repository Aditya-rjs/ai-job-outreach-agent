import { getDb } from '@/db';
import { contacts, batches, outreachQueue, schedulerState, settings, resume, candidateProfile } from '@/db/schema';
import { eq, and, sql, asc, desc, inArray, ne, or, isNotNull } from 'drizzle-orm';
import { getLocalDateString, getConfiguredTimezone, getCooldownCutoffIso } from './time-utils';
import { isBatchClassificationComplete } from '@/lib/pipeline/classification-reconciler';
import type { QueueItem, Contact } from '@/types';

const QUEUE_ITEM_LEASE_MS = 60 * 1000; // 60 seconds lease per item
const MAX_TRANSIENT_ATTEMPTS = 3;

/**
 * Safely marks a contact as having a stale resume, routing it back to PENDING_GENERATION
 * and settling its outreach_queue item so it cannot block or starve the send queue.
 */
export function markContactStaleResumeForRegeneration(contactId: string): void {
  const db = getDb();
  const nowIso = new Date().toISOString();

  db.update(contacts)
    .set({
      status: 'queued',
      generationStatus: 'PENDING_GENERATION',
      generationAttemptCount: 0,
      generationClaimToken: null,
      generationLeaseExpiresAt: null,
      nextGenerationRetryAt: null,
      lastGenerationErrorCategory: null,
      errorMessage: 'Active resume updated after email generated. Queued for autonomous regeneration.',
      emailSubject: null,
      emailBody: null,
      emailStrategy: null,
      personalizationPoints: null,
      resumeVersion: null,
      updatedAt: nowIso,
    })
    .where(eq(contacts.id, contactId))
    .run();

  db.delete(outreachQueue)
    .where(eq(outreachQueue.contactId, contactId))
    .run();
}

/**
 * Batch invalidates all existing generated/queued contacts that were generated
 * using a prior resume version, making them immediately eligible for autonomous
 * regeneration with the new resume.
 */
export function invalidateStaleResumeContacts(activeResumeVersion: string): number {
  const db = getDb();
  const nowIso = new Date().toISOString();

  const staleRows = db
    .select({ id: contacts.id })
    .from(contacts)
    .where(
      and(
        sql`contacts.status NOT IN ('sent', 'simulated', 'failed', 'skipped', 'uncertain')`,
        or(
          and(isNotNull(contacts.resumeVersion), ne(contacts.resumeVersion, activeResumeVersion)),
          and(eq(contacts.status, 'generated'), ne(sql`COALESCE(${contacts.resumeVersion}, '')`, activeResumeVersion))
        )
      )
    )
    .all();

  if (staleRows.length === 0) {
    return 0;
  }

  const staleIds = staleRows.map((r) => r.id);

  db.update(contacts)
    .set({
      status: 'queued',
      generationStatus: 'PENDING_GENERATION',
      generationAttemptCount: 0,
      generationClaimToken: null,
      generationLeaseExpiresAt: null,
      nextGenerationRetryAt: null,
      lastGenerationErrorCategory: null,
      errorMessage: 'Active resume updated after email generated. Queued for autonomous regeneration.',
      emailSubject: null,
      emailBody: null,
      emailStrategy: null,
      personalizationPoints: null,
      resumeVersion: null,
      updatedAt: nowIso,
    })
    .where(inArray(contacts.id, staleIds))
    .run();

  db.delete(outreachQueue)
    .where(inArray(outreachQueue.contactId, staleIds))
    .run();

  return staleIds.length;
}

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
  emailsSimulated?: number;
  emailsFailed: number;
  emailsSkipped: number;
  emailsUncertain: number;
  completedAt: string;
  message: string;
}

/**
 * Reconciles the daily sent counter at midnight in the configured timezone (Asia/Kolkata).
 * Real sends are governed by the 10:00 AM - 4:00 PM IST sending window (hard 30/day ceiling removed).
 */
export function reconcileDailyQuota(date: Date = new Date()): {
  todayDate: string;
  todaySentCount: number;
  todaySimulatedCount: number;
  dailyLimit: number;
  isQuotaReached: boolean;
} {
  const db = getDb();
  const tz = getConfiguredTimezone();
  const currentLocalDate = getLocalDateString(date, tz);

  const state = db.select().from(schedulerState).where(eq(schedulerState.id, 'singleton')).get();
  const dailyLimit = state?.dailyLimit ?? 30;

  if (!state || state.todayDate !== currentLocalDate) {
    // Midnight rolled over in Asia/Kolkata timezone: reset daily counters and audit existing sends for today
    const sentRows = db
      .select({ sentAt: contacts.sentAt })
      .from(contacts)
      .where(and(eq(contacts.status, 'sent'), sql`sent_at IS NOT NULL`))
      .all();

    let verifiedRealCount = 0;
    for (const row of sentRows) {
      if (row.sentAt && getLocalDateString(new Date(row.sentAt), tz) === currentLocalDate) {
        verifiedRealCount++;
      }
    }

    db.update(schedulerState)
      .set({
        todayDate: currentLocalDate,
        todaySentCount: verifiedRealCount,
        todaySimulatedCount: 0,
      })
      .where(eq(schedulerState.id, 'singleton'))
      .run();

    return {
      todayDate: currentLocalDate,
      todaySentCount: verifiedRealCount,
      todaySimulatedCount: 0,
      dailyLimit,
      isQuotaReached: false,
    };
  }

  // Audit check: Verify real sends in database for current calendar date in Asia/Kolkata
  const sentRows = db
    .select({ sentAt: contacts.sentAt })
    .from(contacts)
    .where(and(eq(contacts.status, 'sent'), sql`sent_at IS NOT NULL`))
    .all();

  let verifiedRealCount = 0;
  for (const row of sentRows) {
    if (row.sentAt && getLocalDateString(new Date(row.sentAt), tz) === currentLocalDate) {
      verifiedRealCount++;
    }
  }

  const effectiveSentCount = Math.max(state.todaySentCount, verifiedRealCount);
  if (effectiveSentCount !== state.todaySentCount) {
    db.update(schedulerState)
      .set({ todaySentCount: effectiveSentCount })
      .where(eq(schedulerState.id, 'singleton'))
      .run();
  }

  return {
    todayDate: currentLocalDate,
    todaySentCount: effectiveSentCount,
    todaySimulatedCount: state.todaySimulatedCount ?? 0,
    dailyLimit,
    isQuotaReached: false,
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

    // Check if definitely sent or simulated in dry-run
    if (contact.status === 'sent' || contact.status === 'simulated' || contact.sentAt) {
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

    // Check if candidate profile or resume was updated since this email was generated
    const profileRecord = db.select({ version: candidateProfile.version }).from(candidateProfile).where(eq(candidateProfile.id, 'singleton')).get();
    const resumeRecord = db.select().from(resume).where(eq(resume.id, 'current')).get();
    const activeProfileVersion = profileRecord?.version || null;
    const activeResumeVersion = resumeRecord ? (resumeRecord.version || resumeRecord.uploadedAt) : null;

    const isMatch = (activeProfileVersion && contact.resumeVersion === activeProfileVersion) ||
                    (activeResumeVersion && contact.resumeVersion === activeResumeVersion);

    if (contact.resumeVersion && !isMatch) {
      markContactStaleResumeForRegeneration(contact.id);
      recoveredCount++;
      console.log(`[Crash Recovery] Stale credentials detected for item ${item.id} (${contact.email}). Routed to PENDING_GENERATION.`);
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
 * Sending is allowed during 10:00 AM - 4:00 PM IST (30/day limit removed).
 * Deduplication enforces 6-day (144-hour) cooldown on confirmed successful sends.
 */
export function acquireNextEligibleJob(workerId: string): NextEligibleJob | null {
  const db = getDb();
  const now = new Date();
  const nowIso = now.toISOString();
  const leaseExpiresAt = new Date(now.getTime() + QUEUE_ITEM_LEASE_MS).toISOString();
  const cooldownCutoffIso = getCooldownCutoffIso(now.getTime());

  // Check active candidate profile or resume version
  const profileRecord = db.select({ version: candidateProfile.version }).from(candidateProfile).where(eq(candidateProfile.id, 'singleton')).get();
  const resumeRecord = db.select().from(resume).where(eq(resume.id, 'current')).get();
  const activeProfileVersion = profileRecord?.version || null;
  const activeResumeVersion = resumeRecord ? (resumeRecord.version || resumeRecord.uploadedAt) : null;

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
          SELECT 1 FROM contacts c2
          LEFT JOIN company_classifications cc ON (
            cc.normalized_name = LOWER(TRIM(c2.company_name))
            OR cc.company_name = c2.company_name
            OR cc.company_name = TRIM(c2.company_name)
          )
          WHERE c2.batch_id = contacts.batch_id
            AND c2.company_name IS NOT NULL
            AND TRIM(c2.company_name) != ''
            AND (
              cc.classification_result IN ('PENDING', 'RETRY_WAITING')
              OR (cc.classification_result IS NULL AND c2.is_relevant IS NULL)
            )
        )
        AND NOT EXISTS (
          SELECT 1 FROM global_email_history
          WHERE global_email_history.email = LOWER(TRIM(contacts.email))
            AND global_email_history.status = 'sent'
            AND global_email_history.sent_at IS NOT NULL
            AND global_email_history.sent_at > ${cooldownCutoffIso}
        )
      `
    )
    .orderBy(
      desc(outreachQueue.priority),
      asc(outreachQueue.createdAt),
      asc(outreachQueue.id)
    )
    .limit(10)
    .all();

  if (candidates.length === 0) {
    return null;
  }

  for (const { queue: candidateQueue, contact: candidateContact } of candidates) {
    // Classification Barrier: Ensure contact's batch has completely finished company classification
    if (!isBatchClassificationComplete(db, candidateContact.batchId)) {
      continue;
    }

    // If contact's resumeVersion is outdated compared to active profile and resume, auto-heal to PENDING_GENERATION
    const isMatch = (activeProfileVersion && candidateContact.resumeVersion === activeProfileVersion) ||
                    (activeResumeVersion && candidateContact.resumeVersion === activeResumeVersion);

    if (candidateContact.resumeVersion && !isMatch) {
      console.log(`[Queue Manager] Stale credentials detected for contact ${candidateContact.id} (${candidateContact.email}). Auto-healing to PENDING_GENERATION.`);
      markContactStaleResumeForRegeneration(candidateContact.id);
      continue;
    }

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
      continue;
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

  return null;
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
          emailsSimulated: sql<number>`SUM(CASE WHEN status = 'simulated' THEN 1 ELSE 0 END)`,
          emailsFailed: sql<number>`SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END)`,
          emailsSkipped: sql<number>`SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END)`,
          emailsUncertain: sql<number>`SUM(CASE WHEN status = 'uncertain' THEN 1 ELSE 0 END)`,
        })
        .from(contacts)
        .where(eq(contacts.batchId, batch.id))
        .get();

      const nowIso = new Date().toISOString();
      const isDryRun = process.env.OUTREACH_DRY_RUN === 'true';

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
        emailsSimulated: stats?.emailsSimulated ?? 0,
        emailsFailed: stats?.emailsFailed ?? batch.emailsFailed,
        emailsSkipped: stats?.emailsSkipped ?? (batch.irrelevantCompanies + batch.duplicateContacts),
        emailsUncertain: stats?.emailsUncertain ?? 0,
        completedAt: nowIso,
        message: isDryRun
          ? 'All eligible outreach simulations for this file have finished. (Dry-run: 0 real emails sent)'
          : 'All eligible emails from this file have been sent. Upload another file.',
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
