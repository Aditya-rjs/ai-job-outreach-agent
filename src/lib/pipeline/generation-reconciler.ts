import { getDb } from '@/db';
import { contacts, batches, resume, outreachQueue, globalEmailHistory } from '@/db/schema';
import { eq, and, sql, asc, desc } from 'drizzle-orm';
import { ulid } from 'ulid';
import { generatePersonalizedEmail } from '@/lib/ai/email-generator';
import { categorizeGeminiError, globalGeminiLimiter } from '@/lib/ai/gemini-client';
import { isOpenRouterConfigured, isOpenRouterError } from '@/lib/ai/openrouter-client';
import { isAiProviderUnavailableError } from '@/lib/ai/ai-dispatcher';
import { isAiOutputInvalidError } from '@/lib/ai/json-parser';
import { normalizeGenerationError } from '@/lib/pipeline/generation-error-boundary';
import { getCooldownCutoffIso } from '@/lib/scheduler/time-utils';
import { getUserVerifiedLinks } from '@/lib/resume/profile-links';
import { getCandidateProfile, isCandidateProfileConfigured } from '@/lib/candidate-profile/candidate-profile-service';
import { isBatchClassificationComplete, getClassificationCompleteBatchIds } from '@/lib/pipeline/classification-reconciler';
import type { StructuredResumeProfile, CandidateProfile, Contact, VerifiedProfileLinks } from '@/types';

export const GENERATION_LEASE_MS = 150 * 1000; // 150-second lease (headroom over 120s active turn budget)
export const RETRY_TURN_BUDGET_MS = 120 * 1000; // 120-second active turn budget per retry contact
export const MAX_GENERATION_RETRIES = 5; // Retained for telemetry/audit reference; retryable errors circulate indefinitely

export interface GenerationReconcileResult {
  processed: number;
  succeeded: number;
  retryPending: number;
  failed: number;
  recovered: number;
  skippedReason?: string;
  activePass?: 'ACTIVE_GENERATION' | 'GENERATION_RETRY' | 'IDLE';
  activePendingCount?: number;
  retryWaitingCount?: number;
}

/**
 * Computes next retry time using exponential backoff:
 * Attempt 1: 2 minutes
 * Attempt 2: 4 minutes
 * Attempt 3: 8 minutes
 * Attempt 4+: 15 minutes max
 */
export function computeGenerationRetryTime(retryCount: number, baseDate: Date = new Date()): string {
  const minutes = Math.min(15, Math.pow(2, Math.max(1, retryCount)));
  return new Date(baseDate.getTime() + minutes * 60 * 1000).toISOString();
}

/**
 * Recovers stale contacts stuck in GENERATING state (e.g. after worker crash / container restart).
 * Accurately tracks accumulated turn execution time across crashes.
 *
 * Edge Case Handling:
 * If retryTurnStartedAt is missing, the contact is conservatively treated as having exhausted
 * its active turn (rotating to the back of the queue and resetting consumed budget to 0).
 * This explicitly prevents unlimited retry loops or unfair queue hogging.
 */
export function recoverStaleGeneratingContacts(): number {
  const db = getDb();
  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  const staleRows = db
    .select({
      id: contacts.id,
      email: contacts.email,
      attemptCount: contacts.generationAttemptCount,
      retryQueueEnqueuedAt: contacts.retryQueueEnqueuedAt,
      retryTurnStartedAt: contacts.retryTurnStartedAt,
      retryTurnConsumedMs: contacts.retryTurnConsumedMs,
      generationStatus: contacts.generationStatus,
    })
    .from(contacts)
    .where(
      and(
        eq(contacts.generationStatus, 'GENERATING'),
        sql`generation_lease_expires_at IS NOT NULL AND generation_lease_expires_at < ${nowIso}`
      )
    )
    .all();

  if (staleRows.length === 0) return 0;

  for (const row of staleRows) {
    let sessionElapsed = 0;
    let turnExpired = false;

    if (row.retryTurnStartedAt) {
      const startedAtMs = new Date(row.retryTurnStartedAt).getTime();
      // Cap session elapsed to lease duration (150s) to prevent unbounded values if machine was offline
      sessionElapsed = Math.min(GENERATION_LEASE_MS, Math.max(0, now - startedAtMs));
    } else {
      // Conservative handling for missing retryTurnStartedAt:
      // Treat the missing timestamp conservatively as having exhausted its active turn (150s),
      // rotating it to the back of the queue and resetting consumed budget.
      // This explicitly prevents unlimited 0ms loops or unfair queue hogging.
      sessionElapsed = GENERATION_LEASE_MS;
      turnExpired = true;
    }

    const totalConsumed = (row.retryTurnConsumedMs || 0) + sessionElapsed;
    if (totalConsumed >= RETRY_TURN_BUDGET_MS) {
      turnExpired = true;
    }

    db.update(contacts)
      .set({
        generationStatus: 'RETRY_PENDING',
        generationClaimToken: null,
        generationLeaseExpiresAt: null,
        retryTurnStartedAt: null,
        retryTurnConsumedMs: turnExpired ? 0 : totalConsumed,
        retryQueueEnqueuedAt: turnExpired ? nowIso : row.retryQueueEnqueuedAt,
        nextGenerationRetryAt: computeGenerationRetryTime(row.attemptCount || 1, new Date(now)),
        status: 'queued',
        updatedAt: nowIso,
      })
      .where(eq(contacts.id, row.id))
      .run();

    console.warn(
      `[GenerationReconciler] Recovered expired generation lease for ${row.email}. ` +
      `Turn expired: ${turnExpired} (consumed ${turnExpired ? 0 : totalConsumed}ms). Reset to RETRY_PENDING.`
    );
  }

  return staleRows.length;
}

/**
 * Checks whether any fresh, initial email generation work is pending or actively in its first pass.
 * If excludeContactId is passed, that contact is excluded so a running retry contact never preempts itself.
 */
export function hasActiveFreshPendingGeneration(
  db: ReturnType<typeof getDb> = getDb(),
  batchId?: string,
  excludeContactId?: string
): boolean {
  let eligibleBatchIds: string[];
  if (batchId) {
    if (!isBatchClassificationComplete(db, batchId)) {
      return false;
    }
    eligibleBatchIds = [batchId];
  } else {
    const completeBatchIds = getClassificationCompleteBatchIds(db);
    if (completeBatchIds.length === 0) {
      return false;
    }
    eligibleBatchIds = completeBatchIds;
  }

  const batchCondition = sql`AND contacts.batch_id IN (${sql.join(eligibleBatchIds.map((id) => sql`${id}`), sql`, `)})`;

  const excludeCondition = excludeContactId
    ? sql`AND contacts.id != ${excludeContactId}`
    : sql``;

  const row = db.get<{ activePending: number }>(sql`
    SELECT
      COALESCE(SUM(
        CASE
          WHEN contacts.is_relevant = 1
            AND contacts.email_valid = 1
            AND contacts.is_duplicate = 0
            AND contacts.sent_at IS NULL
            AND (contacts.generation_status IS NULL OR contacts.generation_status != 'GENERATED')
            AND (
              contacts.generation_status = 'PENDING_GENERATION'
              OR (
                contacts.generation_status = 'GENERATING'
                AND (contacts.generation_attempt_count = 0 AND contacts.retry_queue_enqueued_at IS NULL)
              )
              OR (
                contacts.generation_status IS NULL
                AND contacts.status IN ('queued', 'generating', 'discovered')
                AND (contacts.email_subject IS NULL OR contacts.email_body IS NULL OR TRIM(contacts.email_subject) = '' OR TRIM(contacts.email_body) = '')
              )
            )
          THEN 1
          ELSE 0
        END
      ), 0) as activePending
    FROM contacts
    INNER JOIN batches ON contacts.batch_id = batches.id
    WHERE 1=1
      ${batchCondition}
      ${excludeCondition}
  `);

  return (row?.activePending ?? 0) > 0;
}

/**
 * Sleeps for ms milliseconds, checking every sliceMs (default 1000ms) whether preemption has occurred.
 * Returns true if preempted, false if full sleep completed.
 */
export async function sleepWithPreemptionCheck(
  ms: number,
  isPreempted: () => boolean,
  sliceMs: number = 1000
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (isPreempted()) {
      return true;
    }
    const remaining = ms - (Date.now() - start);
    const toWait = Math.min(sliceMs, remaining);
    if (toWait <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, toWait));
  }
  return isPreempted();
}

export function resetGenerationActiveClaimsForTesting(): void {
  // SQLite-based leases do not hold process-level memory state
}

/**
 * Returns the current persistent state of generation rounds:
 * - activePendingCount: fresh contacts waiting for initial generation (PENDING_GENERATION or actively GENERATING)
 * - retryWaitingCount: contacts with transient errors waiting for active generation to drain (RETRY_PENDING)
 * - isCurrentRoundDrained: true when activePendingCount === 0
 */
export function getGenerationRoundState(
  db: ReturnType<typeof getDb> = getDb(),
  batchId?: string
): {
  activePendingCount: number;
  retryWaitingCount: number;
  isCurrentRoundDrained: boolean;
} {
  let eligibleBatchIds: string[];
  if (batchId) {
    if (!isBatchClassificationComplete(db, batchId)) {
      return {
        activePendingCount: 0,
        retryWaitingCount: 0,
        isCurrentRoundDrained: false,
      };
    }
    eligibleBatchIds = [batchId];
  } else {
    const completeBatchIds = getClassificationCompleteBatchIds(db);
    if (completeBatchIds.length === 0) {
      return {
        activePendingCount: 0,
        retryWaitingCount: 0,
        isCurrentRoundDrained: false,
      };
    }
    eligibleBatchIds = completeBatchIds;
  }

  const batchCondition = sql`AND contacts.batch_id IN (${sql.join(eligibleBatchIds.map((id) => sql`${id}`), sql`, `)})`;

  const row = db.get<{
    activePending: number;
    retryWaiting: number;
  }>(sql`
    SELECT
      COALESCE(SUM(
        CASE
          WHEN contacts.is_relevant = 1
            AND contacts.email_valid = 1
            AND contacts.is_duplicate = 0
            AND contacts.sent_at IS NULL
            AND (contacts.generation_status IS NULL OR contacts.generation_status != 'GENERATED')
            AND (
              contacts.generation_status = 'PENDING_GENERATION'
              OR (
                contacts.generation_status = 'GENERATING'
                AND (contacts.generation_attempt_count = 0 AND contacts.retry_queue_enqueued_at IS NULL)
              )
              OR (
                contacts.generation_status IS NULL
                AND contacts.status IN ('queued', 'generating', 'discovered')
                AND (contacts.email_subject IS NULL OR contacts.email_body IS NULL OR TRIM(contacts.email_subject) = '' OR TRIM(contacts.email_body) = '')
              )
            )
          THEN 1
          ELSE 0
        END
      ), 0) as activePending,
      COALESCE(SUM(
        CASE
          WHEN contacts.is_relevant = 1
            AND contacts.email_valid = 1
            AND contacts.is_duplicate = 0
            AND contacts.sent_at IS NULL
            AND contacts.generation_status != 'GENERATED'
            AND (
              contacts.generation_status = 'RETRY_PENDING'
              OR (
                contacts.generation_status = 'GENERATING'
                AND (contacts.generation_attempt_count > 0 OR contacts.retry_queue_enqueued_at IS NOT NULL)
              )
            )
          THEN 1
          ELSE 0
        END
      ), 0) as retryWaiting
    FROM contacts
    INNER JOIN batches ON contacts.batch_id = batches.id
    WHERE 1=1
      ${batchCondition}
  `);

  const activePendingCount = row?.activePending ?? 0;
  const retryWaitingCount = row?.retryWaiting ?? 0;

  return {
    activePendingCount,
    retryWaitingCount,
    isCurrentRoundDrained: activePendingCount === 0,
  };
}

/**
 * Periodically processes contacts pending AI email generation in the background.
 * Completely autonomous: runs independently of browser activity.
 */
export async function reconcilePendingEmailGenerations(options: {
  batchId?: string;
  batchSize?: number;
  claimWorkerId?: string;
  aiCallerOverride?: (prompt: string) => Promise<string>;
  turnBudgetMs?: number;
  backoffMsOverride?: number;
} = {}): Promise<GenerationReconcileResult> {
  const db = getDb();
  const now = new Date();
  const nowIso = now.toISOString();
  const workerId = options.claimWorkerId || `gen_worker_${process.pid}`;
  const batchLimit = options.batchSize || parseInt(process.env.EMAIL_GEN_BATCH_SIZE || '4', 10);

  // 1. Recover any expired generation leases from crashed workers
  const recovered = recoverStaleGeneratingContacts();

  // 2. Check if global Gemini 429 cooldown is active and OpenRouter is not available
  if (globalGeminiLimiter.isCooldownActive() && !isOpenRouterConfigured()) {
    console.log(
      `[GenerationReconciler] Global Gemini 429 cooldown active until ${globalGeminiLimiter.getCooldownUntilIso()} and OpenRouter not configured. Skipping generation run.`
    );
    return {
      processed: 0,
      succeeded: 0,
      retryPending: 0,
      failed: 0,
      recovered,
      skippedReason: 'GEMINI_COOLDOWN_ACTIVE',
    };
  }

  // 3. Verify active persistent candidate profile exists as authoritative source of truth
  const profile = getCandidateProfile(db);
  if (!isCandidateProfileConfigured(profile)) {
    return {
      processed: 0,
      succeeded: 0,
      retryPending: 0,
      failed: 0,
      recovered,
      skippedReason: 'NO_CANDIDATE_PROFILE',
    };
  }

  // Strict Batch Classification Barrier:
  let eligibleBatchIds: string[];
  if (options.batchId) {
    if (!isBatchClassificationComplete(db, options.batchId)) {
      return {
        processed: 0,
        succeeded: 0,
        retryPending: 0,
        failed: 0,
        recovered,
        skippedReason: 'CLASSIFICATION_INCOMPLETE',
        activePass: 'IDLE',
        activePendingCount: 0,
        retryWaitingCount: 0,
      };
    }
    eligibleBatchIds = [options.batchId];
  } else {
    const activeBatches = db
      .select({ id: batches.id })
      .from(batches)
      .where(sql`batches.status NOT IN ('completed', 'deleted', 'cancelled')`)
      .all();

    if (activeBatches.length === 0) {
      return {
        processed: 0,
        succeeded: 0,
        retryPending: 0,
        failed: 0,
        recovered,
        activePass: 'IDLE',
        activePendingCount: 0,
        retryWaitingCount: 0,
      };
    }

    eligibleBatchIds = activeBatches
      .filter((b) => isBatchClassificationComplete(db, b.id))
      .map((b) => b.id);

    if (eligibleBatchIds.length === 0) {
      return {
        processed: 0,
        succeeded: 0,
        retryPending: 0,
        failed: 0,
        recovered,
        skippedReason: 'CLASSIFICATION_INCOMPLETE',
        activePass: 'IDLE',
        activePendingCount: 0,
        retryWaitingCount: 0,
      };
    }
  }

  const verifiedLinks: VerifiedProfileLinks = {
    linkedin: profile.linkedin || null,
    github: profile.github || null,
    portfolio: profile.portfolio || null,
  };
  const resumeRecord = db.select().from(resume).where(eq(resume.id, 'current')).get();
  const resumeVersion = resumeRecord?.version || resumeRecord?.uploadedAt || profile.version;

  // 4. Evaluate Round State: Active Generation Pass vs Generation Retry Pass
  // Invariant: Generation Retry may begin ONLY when current active Email Gen Pending count is strictly zero.
  const roundState = getGenerationRoundState(db, options.batchId);

  const cooldownCutoffIso = getCooldownCutoffIso(now.getTime());
  const batchFilter = sql`AND contacts.batch_id IN (${sql.join(eligibleBatchIds.map((id) => sql`${id}`), sql`, `)})`;

  let candidates: Contact[] = [];
  let activePass: 'ACTIVE_GENERATION' | 'GENERATION_RETRY' | 'IDLE' = 'IDLE';

  if (roundState.activePendingCount > 0) {
    // PASS 1: ACTIVE GENERATION PASS
    // Email Gen Pending > 0: Retries must WAIT. Only fresh pending generation contacts are eligible.
    activePass = 'ACTIVE_GENERATION';
    candidates = db
      .select({
        contact: contacts,
      })
      .from(contacts)
      .innerJoin(batches, eq(contacts.batchId, batches.id))
      .where(
        sql`
          1=1
          ${batchFilter}
          AND contacts.is_relevant = 1
          AND contacts.email_valid = 1
          AND contacts.is_duplicate = 0
          AND contacts.sent_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM global_email_history
            WHERE global_email_history.email = LOWER(TRIM(contacts.email))
              AND global_email_history.status = 'sent'
              AND global_email_history.sent_at IS NOT NULL
              AND global_email_history.sent_at > ${cooldownCutoffIso}
          )
          AND (
            contacts.generation_status = 'PENDING_GENERATION'
            OR (
              contacts.generation_status IS NULL
              AND contacts.status IN ('queued', 'generating', 'discovered')
              AND (contacts.email_subject IS NULL OR contacts.email_body IS NULL)
            )
          )
          AND (contacts.generation_lease_expires_at IS NULL OR contacts.generation_lease_expires_at < ${nowIso})
          AND (contacts.generation_status IS NULL OR contacts.generation_status != 'GENERATED')
        `
      )
      .orderBy(
        asc(contacts.createdAt),
        asc(contacts.id)
      )
      .limit(batchLimit)
      .all()
      .map((r) => r.contact as Contact);
  } else if (roundState.retryWaitingCount > 0) {
    // PASS 2: GENERATION RETRY PASS
    // Email Gen Pending === 0: Active generation pass has completely drained.
    // Persistent Circular FIFO Queue: lease 1 contact sequentially by oldest queue timestamp
    activePass = 'GENERATION_RETRY';
    candidates = db
      .select({
        contact: contacts,
      })
      .from(contacts)
      .innerJoin(batches, eq(contacts.batchId, batches.id))
      .where(
        sql`
          1=1
          ${batchFilter}
          AND contacts.is_relevant = 1
          AND contacts.email_valid = 1
          AND contacts.is_duplicate = 0
          AND contacts.sent_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM global_email_history
            WHERE global_email_history.email = LOWER(TRIM(contacts.email))
              AND global_email_history.status = 'sent'
              AND global_email_history.sent_at IS NOT NULL
              AND global_email_history.sent_at > ${cooldownCutoffIso}
          )
          AND contacts.generation_status = 'RETRY_PENDING'
          AND (contacts.generation_lease_expires_at IS NULL OR contacts.generation_lease_expires_at < ${nowIso})
          AND contacts.generation_status != 'GENERATED'
        `
      )
      .orderBy(
        asc(sql`COALESCE(contacts.retry_queue_enqueued_at, contacts.created_at)`),
        asc(contacts.id)
      )
      .limit(batchLimit) // Process up to batchLimit retry turns sequentially!
      .all()
      .map((r) => r.contact as Contact);
  }

  if (candidates.length === 0) {
    return {
      processed: 0,
      succeeded: 0,
      retryPending: 0,
      failed: 0,
      recovered,
      activePass,
      activePendingCount: roundState.activePendingCount,
      retryWaitingCount: roundState.retryWaitingCount,
    };
  }

  // Fetch recent email bodies for natural similarity avoidance
  const recentRecords = db
    .select({ emailBody: contacts.emailBody })
    .from(contacts)
    .where(sql`${contacts.emailBody} IS NOT NULL AND ${contacts.emailBody} != ''`)
    .limit(30)
    .all();
  const recentBodies = recentRecords.map((r) => r.emailBody).filter((b): b is string => Boolean(b));

  let processed = 0;
  let succeeded = 0;
  let retryPending = 0;
  let failed = 0;

  for (const contact of candidates) {
    if (!isBatchClassificationComplete(db, contact.batchId)) {
      continue;
    }

    if (globalGeminiLimiter.isCooldownActive() && !isOpenRouterConfigured()) {
      console.log(
        `[GenerationReconciler] Global Gemini 429 cooldown active until ${globalGeminiLimiter.getCooldownUntilIso()} and OpenRouter not configured. Stopping candidate generation loop.`
      );
      break;
    }

    const claimToken = `${workerId}_${ulid()}`;
    const leaseExpiresAt = new Date(Date.now() + GENERATION_LEASE_MS).toISOString();

    const isRetryCandidate = contact.generationStatus === 'RETRY_PENDING';

    if (isRetryCandidate && hasActiveFreshPendingGeneration(db, options.batchId, contact.id)) {
      console.log(
        `[GenerationReconciler] Fresh Email Gen Pending work arrived. Stopping retry candidate loop.`
      );
      break;
    }

    // 5. Atomic claim lease with round safety invariant
    let claimResult;
    if (isRetryCandidate) {
      // Invariant: Generation Retry may begin ONLY when the active Email Gen Pending count is strictly zero.
      // Under SQLite write lock, verify no active pending generation contacts exist before leasing a retry item.
      claimResult = db.run(sql`
        UPDATE contacts
        SET generation_status = 'GENERATING',
            generation_claim_token = ${claimToken},
            generation_lease_expires_at = ${leaseExpiresAt},
            retry_turn_started_at = ${nowIso},
            last_generation_attempt_at = ${nowIso},
            status = 'generating',
            updated_at = ${nowIso}
        WHERE id = ${contact.id}
          AND generation_status = 'RETRY_PENDING'
          AND (generation_lease_expires_at IS NULL OR generation_lease_expires_at < ${nowIso})
          AND NOT EXISTS (
            SELECT 1 FROM contacts c2
            INNER JOIN batches b2 ON c2.batch_id = b2.id
            WHERE 1=1
              AND b2.id IN (${sql.join(eligibleBatchIds.map((id) => sql`${id}`), sql`, `)})
              AND c2.is_relevant = 1
              AND c2.email_valid = 1
              AND c2.is_duplicate = 0
              AND c2.sent_at IS NULL
              AND (c2.generation_status IS NULL OR c2.generation_status != 'GENERATED')
              AND (
                c2.generation_status = 'PENDING_GENERATION'
                OR (
                  c2.generation_status IS NULL
                  AND c2.status IN ('queued', 'generating', 'discovered')
                  AND (c2.email_subject IS NULL OR c2.email_body IS NULL OR TRIM(c2.email_subject) = '' OR TRIM(c2.email_body) = '')
                )
              )
          )
      `);
    } else {
      claimResult = db.run(sql`
        UPDATE contacts
        SET generation_status = 'GENERATING',
            generation_claim_token = ${claimToken},
            generation_lease_expires_at = ${leaseExpiresAt},
            last_generation_attempt_at = ${nowIso},
            status = 'generating',
            updated_at = ${nowIso}
        WHERE id = ${contact.id}
          AND (
            generation_status = 'PENDING_GENERATION'
            OR generation_status IS NULL
            OR generation_lease_expires_at < ${nowIso}
          )
          AND (generation_status IS NULL OR generation_status != 'GENERATED')
      `);
    }

    if (claimResult.changes === 0) {
      // Claimed by another worker, already generated, or an active pending job appeared preventing retry claim
      continue;
    }

    processed++;

    if (isRetryCandidate) {
      // =========================================================================
      // PASS 2: CIRCULAR RETRY QUEUE TURN EXECUTION (Sequential, 120s Budget)
      // =========================================================================
      const turnBudget = options.turnBudgetMs || RETRY_TURN_BUDGET_MS;
      const turnSessionStartMs = Date.now();
      const priorConsumedMs = contact.retryTurnConsumedMs || 0;
      let sessionElapsedMs = 0;
      let turnSucceeded = false;
      let turnTerminalFailed = false;
      let turnPreempted = false;
      let turnWaitingPaused = false;

      while (true) {
        sessionElapsedMs = Date.now() - turnSessionStartMs;
        const effectiveConsumedMs = priorConsumedMs + sessionElapsedMs;
        const remainingBudgetMs = turnBudget - effectiveConsumedMs;

        if (remainingBudgetMs <= 0) {
          // 120s active turn budget genuinely exhausted!
          break;
        }

        // 1. Preemption check: did fresh Email Gen Pending work arrive?
        if (hasActiveFreshPendingGeneration(db, options.batchId, contact.id)) {
          console.log(`[GenerationReconciler] Mid-turn preemption for ${contact.email}: fresh Email Gen Pending work arrived.`);
          turnPreempted = true;
          break;
        }

        // 2. Check provider cooldown / fallback
        if (globalGeminiLimiter.isCooldownActive() && !isOpenRouterConfigured()) {
          console.warn(
            `[GenerationReconciler] AI provider (Gemini) in cooldown (${globalGeminiLimiter.getCooldownRemainingMs()}ms) and OpenRouter not configured. Pausing turn for ${contact.email} in WAITING state without burning budget.`
          );
          turnWaitingPaused = true;
          break;
        }

        try {
          let generated: {
            subject: string;
            body: string;
            strategy?: string;
            personalization_points?: string[];
          };

          if (options.aiCallerOverride) {
            const text = await options.aiCallerOverride(contact.companyName || '');
            const subjectMatch = text.match(/Subject:\s*([^\n]+)/i);
            const subject = subjectMatch ? subjectMatch[1].trim() : 'Engineering Opportunities';
            const body = text.replace(/Subject:\s*[^\n]+\n*/i, '').trim();
            generated = { subject, body, strategy: 'direct', personalization_points: ['Engineering skills'] };
          } else {
            generated = await generatePersonalizedEmail({
              profile,
              companyName: contact.companyName || 'the company',
              contactName: contact.contactName,
              designation: contact.designation,
              companyWebsite: contact.companyWebsite,
              companyLocation: contact.companyLocation,
              relevanceReason: contact.relevanceReason,
              recentEmails: recentBodies,
              isRetry: true,
              strictGemini: true,
              verifiedLinks,
            });
          }

          const finishTimestamp = new Date().toISOString();
          db.update(contacts)
            .set({
              emailSubject: generated.subject,
              emailBody: generated.body,
              emailStrategy: generated.strategy,
              personalizationPoints: JSON.stringify(generated.personalization_points),
              resumeVersion,
              generatedAt: finishTimestamp,
              generationStatus: 'GENERATED',
              generationClaimToken: null,
              generationLeaseExpiresAt: null,
              retryTurnStartedAt: null,
              retryTurnConsumedMs: 0,
              retryQueueEnqueuedAt: null,
              status: 'generated',
              errorMessage: null,
              updatedAt: finishTimestamp,
            })
            .where(eq(contacts.id, contact.id))
            .run();

          // Ensure presence in outreach_queue
          const existingQueue = db
            .select({ id: outreachQueue.id })
            .from(outreachQueue)
            .where(eq(outreachQueue.contactId, contact.id))
            .get();

          if (!existingQueue) {
            db.insert(outreachQueue)
              .values({
                id: `queue_${ulid()}`,
                contactId: contact.id,
                priority: 0,
                status: 'pending',
                attempts: 0,
                createdAt: finishTimestamp,
                updatedAt: finishTimestamp,
              })
              .run();
          } else {
            db.update(outreachQueue)
              .set({
                status: 'pending',
                attempts: 0,
                workerId: null,
                leaseExpiresAt: null,
                lastAttemptAt: null,
                errorMessage: null,
                updatedAt: finishTimestamp,
              })
              .where(eq(outreachQueue.id, existingQueue.id))
              .run();
          }

          recentBodies.unshift(generated.body);
          if (recentBodies.length > 50) recentBodies.pop();

          succeeded++;
          turnSucceeded = true;
          console.log(`[GenerationReconciler] Successfully generated email for ${contact.email} (${contact.companyName}). Ready for outreach sending.`);
          break; // Done with this retry contact!
        } catch (genErr: unknown) {
          if (isAiProviderUnavailableError(genErr)) {
            console.warn(
              `[GenerationReconciler] AI providers temporarily in WAITING state. Pausing turn for ${contact.email} without burning attempts or budget.`
            );
            turnWaitingPaused = true;
            break;
          }

          const diag = normalizeGenerationError(genErr, {
            provider: (genErr as { provider?: string })?.provider,
            contactEmail: contact.email,
          });

          const isFromOpenRouter = diag.provider === 'openrouter';
          const isFromGemini = diag.provider === 'gemini';
          const attemptTimestamp = new Date().toISOString();
          const currentAttempts = (contact.generationAttemptCount || 0) + 1;

          const isRateLimit = diag.category === 'PROVIDER_RATE_LIMIT';

          if (isRateLimit && !isFromOpenRouter) {
            globalGeminiLimiter.recordError(genErr);
            if (globalGeminiLimiter.isCooldownActive() && !isOpenRouterConfigured()) {
              console.warn(
                `[GenerationReconciler] AI provider (Gemini) entered cooldown (${globalGeminiLimiter.getCooldownRemainingMs()}ms) and OpenRouter not configured. Pausing turn for ${contact.email} in WAITING state.`
              );
              turnWaitingPaused = true;
              break;
            }
          }

          const providerPrefix = isFromOpenRouter
            ? 'OpenRouter'
            : isFromGemini
              ? 'Gemini'
              : 'AI';

          if (diag.isDeterministicDefect) {
            // TERMINAL DETERMINISTIC DATA/APPLICATION DEFECT:
            const failReason = `Deterministic defect (${diag.originalErrorName}): ${diag.safeMessage}`;
            db.update(contacts)
              .set({
                generationStatus: 'GENERATION_FAILED',
                generationAttemptCount: currentAttempts,
                lastGenerationErrorCategory: diag.category,
                generationClaimToken: null,
                generationLeaseExpiresAt: null,
                retryTurnStartedAt: null,
                retryTurnConsumedMs: 0,
                status: 'failed',
                errorMessage: failReason,
                updatedAt: attemptTimestamp,
              })
              .where(eq(contacts.id, contact.id))
              .run();

            failed++;
            turnTerminalFailed = true;
            console.error(`[GenerationReconciler] Terminal generation failure for ${contact.email}: ${failReason}`);
            break;
          }

          // Recoverable error (NETWORK_TRANSPORT_ERROR, PROVIDER_RATE_LIMIT, PROVIDER_OUTAGE_5XX,
          // PROVIDER_AUTH_ERROR, PROVIDER_SAFETY_REFUSAL, AI_OUTPUT_MALFORMED, DATABASE_TRANSIENT_ERROR,
          // UNANTICIPATED_RUNTIME_ERROR): update attempt telemetry (indefinite retries in circular queue)
          db.update(contacts)
            .set({
              generationAttemptCount: currentAttempts,
              lastGenerationErrorCategory: diag.category,
              errorMessage: `${providerPrefix} error (${diag.category}, attempt #${currentAttempts}): ${diag.safeMessage}`,
              updatedAt: attemptTimestamp,
            })
            .where(eq(contacts.id, contact.id))
            .run();

          // Check remaining budget after this attempt
          sessionElapsedMs = Date.now() - turnSessionStartMs;
          const currentEffective = priorConsumedMs + sessionElapsedMs;
          const remainingAfter = turnBudget - currentEffective;

          if (remainingAfter <= 2000) {
            // Budget exhausted
            break;
          }

          // Authoritative backoff
          let backoffMs = options.backoffMsOverride ?? 3000;
          if (isRateLimit) {
            backoffMs = options.backoffMsOverride ?? (isFromOpenRouter
              ? 5000
              : Math.min(remainingAfter, globalGeminiLimiter.getCooldownRemainingMs() || 5000));
          }

          if (backoffMs > remainingAfter) {
            // Cooldown exceeds remaining budget, end turn
            break;
          }

          const preempted = await sleepWithPreemptionCheck(
            backoffMs,
            () => hasActiveFreshPendingGeneration(db, options.batchId, contact.id)
          );
          if (preempted) {
            turnPreempted = true;
            break;
          }
        }
      }

      if (turnSucceeded || turnTerminalFailed) {
        // Already finalized in DB
      } else if (turnWaitingPaused) {
        // Both providers in WAITING state:
        // Clear retryTurnStartedAt, keep retryTurnConsumedMs unchanged, keep retryQueueEnqueuedAt unchanged
        db.update(contacts)
          .set({
            generationStatus: 'RETRY_PENDING',
            generationClaimToken: null,
            generationLeaseExpiresAt: null,
            retryTurnStartedAt: null,
            status: 'queued',
            updatedAt: new Date().toISOString(),
          })
          .where(eq(contacts.id, contact.id))
          .run();
        retryPending++;
      } else if (turnPreempted) {
        // Preempted mid-turn by fresh Email Gen Pending work:
        // Accumulate active session time, keep retryQueueEnqueuedAt unchanged (retains front position)
        const sessionDuration = Math.max(0, Date.now() - turnSessionStartMs);
        const totalConsumed = priorConsumedMs + sessionDuration;
        db.update(contacts)
          .set({
            generationStatus: 'RETRY_PENDING',
            generationClaimToken: null,
            generationLeaseExpiresAt: null,
            retryTurnStartedAt: null,
            retryTurnConsumedMs: totalConsumed,
            status: 'queued',
            updatedAt: new Date().toISOString(),
          })
          .where(eq(contacts.id, contact.id))
          .run();
        retryPending++;
      } else {
        // 120-second active turn genuinely exhausted:
        // Move to BACK of circular queue, reset retryTurnConsumedMs to 0
        const finishIso = new Date().toISOString();
        db.update(contacts)
          .set({
            generationStatus: 'RETRY_PENDING',
            generationClaimToken: null,
            generationLeaseExpiresAt: null,
            retryTurnStartedAt: null,
            retryTurnConsumedMs: 0,
            retryQueueEnqueuedAt: finishIso, // ROTATES TO BACK OF CIRCULAR QUEUE!
            status: 'queued',
            updatedAt: finishIso,
          })
          .where(eq(contacts.id, contact.id))
          .run();
        retryPending++;
        console.log(`[GenerationReconciler] 120s turn exhausted for ${contact.email}. Rotated to back of circular queue.`);
      }

      if (turnPreempted || turnWaitingPaused) {
        break;
      }
    } else {
      // =========================================================================
      // PASS 1: FRESH INITIAL EMAIL GENERATION
      // =========================================================================
      try {
        let generated: {
          subject: string;
          body: string;
          strategy?: string;
          personalization_points?: string[];
        };

        if (options.aiCallerOverride) {
          const text = await options.aiCallerOverride(contact.companyName || '');
          const subjectMatch = text.match(/Subject:\s*([^\n]+)/i);
          const subject = subjectMatch ? subjectMatch[1].trim() : 'Engineering Opportunities';
          const body = text.replace(/Subject:\s*[^\n]+\n*/i, '').trim();
          generated = {
            subject,
            body,
            strategy: 'direct',
            personalization_points: ['Engineering skills'],
          };
        } else {
          generated = await generatePersonalizedEmail({
            profile,
            companyName: contact.companyName || 'the company',
            contactName: contact.contactName,
            designation: contact.designation,
            companyWebsite: contact.companyWebsite,
            companyLocation: contact.companyLocation,
            relevanceReason: contact.relevanceReason,
            recentEmails: recentBodies,
            isRetry: false,
            strictGemini: true,
            verifiedLinks,
          });
        }

        const finishTimestamp = new Date().toISOString();

        db.update(contacts)
          .set({
            emailSubject: generated.subject,
            emailBody: generated.body,
            emailStrategy: generated.strategy,
            personalizationPoints: JSON.stringify(generated.personalization_points),
            resumeVersion,
            generatedAt: finishTimestamp,
            generationStatus: 'GENERATED',
            generationClaimToken: null,
            generationLeaseExpiresAt: null,
            retryTurnStartedAt: null,
            retryTurnConsumedMs: 0,
            retryQueueEnqueuedAt: null,
            status: 'generated',
            errorMessage: null,
            updatedAt: finishTimestamp,
          })
          .where(eq(contacts.id, contact.id))
          .run();

        const existingQueue = db
          .select({ id: outreachQueue.id })
          .from(outreachQueue)
          .where(eq(outreachQueue.contactId, contact.id))
          .get();

        if (!existingQueue) {
          db.insert(outreachQueue)
            .values({
              id: `queue_${ulid()}`,
              contactId: contact.id,
              priority: 0,
              status: 'pending',
              attempts: 0,
              createdAt: finishTimestamp,
              updatedAt: finishTimestamp,
            })
            .run();
        } else {
          db.update(outreachQueue)
            .set({
              status: 'pending',
              attempts: 0,
              workerId: null,
              leaseExpiresAt: null,
              lastAttemptAt: null,
              errorMessage: null,
              updatedAt: finishTimestamp,
            })
            .where(eq(outreachQueue.id, existingQueue.id))
            .run();
        }

        recentBodies.unshift(generated.body);
        if (recentBodies.length > 50) recentBodies.pop();

        succeeded++;
        console.log(`[GenerationReconciler] Successfully generated email for ${contact.email} (${contact.companyName}). Ready for outreach sending.`);
      } catch (genErr: unknown) {
        if (isAiProviderUnavailableError(genErr)) {
          console.warn(
            `[GenerationReconciler] AI providers temporarily in WAITING state. Releasing fresh contact ${contact.email} claim without burning attempt count.`
          );
          db.update(contacts)
            .set({
              generationStatus: 'PENDING_GENERATION',
              generationClaimToken: null,
              generationLeaseExpiresAt: null,
              status: 'queued',
              updatedAt: new Date().toISOString(),
            })
            .where(eq(contacts.id, contact.id))
            .run();
          break;
        }

        const diag = normalizeGenerationError(genErr, {
          provider: (genErr as { provider?: string })?.provider,
          contactEmail: contact.email,
        });

        const isFromOpenRouter = diag.provider === 'openrouter';
        const isFromGemini = diag.provider === 'gemini';
        const attemptTimestamp = new Date().toISOString();
        const currentAttempts = (contact.generationAttemptCount || 0) + 1;

        const isRateLimit = diag.category === 'PROVIDER_RATE_LIMIT';

        if (isRateLimit && !isFromOpenRouter) {
          globalGeminiLimiter.recordError(genErr);
        }

        const providerPrefix = isFromOpenRouter
          ? 'OpenRouter'
          : isFromGemini
            ? 'Gemini'
            : 'AI';

        if (diag.isDeterministicDefect) {
          const failReason = `Deterministic defect (${diag.originalErrorName}): ${diag.safeMessage}`;
          db.update(contacts)
            .set({
              generationStatus: 'GENERATION_FAILED',
              generationAttemptCount: currentAttempts,
              lastGenerationErrorCategory: diag.category,
              generationClaimToken: null,
              generationLeaseExpiresAt: null,
              retryTurnStartedAt: null,
              retryTurnConsumedMs: 0,
              status: 'failed',
              errorMessage: failReason,
              updatedAt: attemptTimestamp,
            })
            .where(eq(contacts.id, contact.id))
            .run();

          failed++;
          console.error(`[GenerationReconciler] Permanent generation failure for ${contact.email}: ${failReason}`);
        } else {
          // Recoverable error: enters circular retry queue for the first time
          const nextRetry = computeGenerationRetryTime(currentAttempts, new Date());
          db.update(contacts)
            .set({
              generationStatus: 'RETRY_PENDING',
              generationAttemptCount: currentAttempts,
              retryQueueEnqueuedAt: attemptTimestamp, // initial circular queue order
              retryTurnStartedAt: null,
              retryTurnConsumedMs: 0,
              lastGenerationErrorCategory: diag.category,
              nextGenerationRetryAt: nextRetry,
              generationClaimToken: null,
              generationLeaseExpiresAt: null,
              status: 'queued',
              errorMessage: `${providerPrefix} error (${diag.category}, attempt #${currentAttempts}): ${diag.safeMessage}`,
              updatedAt: attemptTimestamp,
            })
            .where(eq(contacts.id, contact.id))
            .run();

          retryPending++;
          console.warn(
            `[GenerationReconciler] Generation failure for ${contact.email} (${diag.category}, attempt #${currentAttempts}). Added to circular retry queue.`
          );
        }

        if (isRateLimit && !isOpenRouterConfigured()) {
          console.warn(
            `[GenerationReconciler] 429 Rate limit encountered for ${contact.email} and OpenRouter not available. Stopping generation loop immediately.`
          );
          break;
        }
      }
    }
  }

  return {
    processed,
    succeeded,
    retryPending,
    failed,
    recovered,
    activePass,
    activePendingCount: roundState.activePendingCount,
    retryWaitingCount: roundState.retryWaitingCount,
  };
}

/**
 * Resets a stuck or failed contact's generation state to PENDING_GENERATION.
 * Useful for recovering specific contacts after code fixes (e.g. regex escaping fix).
 */
export function resetStuckGenerationContact(contactId: string): boolean {
  const db = getDb();
  const nowIso = new Date().toISOString();

  const result = db.run(sql`
    UPDATE contacts
    SET generation_status = 'PENDING_GENERATION',
        generation_attempt_count = 0,
        generation_claim_token = NULL,
        generation_lease_expires_at = NULL,
        next_generation_retry_at = NULL,
        last_generation_error_category = NULL,
        error_message = NULL,
        status = 'queued',
        updated_at = ${nowIso}
    WHERE id = ${contactId}
      AND (generation_status != 'GENERATED' OR generation_status IS NULL)
  `);

  return result.changes > 0;
}

/**
 * Resets multiple stuck or failed contacts by their IDs.
 */
export function recoverStuckGenerationContacts(contactIds: string[]): { resetCount: number; notFoundOrSkipped: string[] } {
  let resetCount = 0;
  const notFoundOrSkipped: string[] = [];

  for (const id of contactIds) {
    const success = resetStuckGenerationContact(id);
    if (success) {
      resetCount++;
    } else {
      notFoundOrSkipped.push(id);
    }
  }

  return { resetCount, notFoundOrSkipped };
}
