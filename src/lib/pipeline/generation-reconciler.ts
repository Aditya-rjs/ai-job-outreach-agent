import { getDb } from '@/db';
import { contacts, batches, resume, outreachQueue, globalEmailHistory } from '@/db/schema';
import { eq, and, sql, asc, desc } from 'drizzle-orm';
import { ulid } from 'ulid';
import { generatePersonalizedEmail } from '@/lib/ai/email-generator';
import { categorizeGeminiError, globalGeminiLimiter } from '@/lib/ai/gemini-client';
import { isOpenRouterConfigured, isOpenRouterError } from '@/lib/ai/openrouter-client';
import { isAiProviderUnavailableError } from '@/lib/ai/ai-dispatcher';
import { getCooldownCutoffIso } from '@/lib/scheduler/time-utils';
import type { StructuredResumeProfile, Contact } from '@/types';

export const GENERATION_LEASE_MS = 90 * 1000; // 90-second lease per contact
export const MAX_GENERATION_RETRIES = 5;

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
 */
export function recoverStaleGeneratingContacts(): number {
  const db = getDb();
  const nowIso = new Date().toISOString();

  const staleRows = db
    .select({ id: contacts.id, email: contacts.email, attemptCount: contacts.generationAttemptCount })
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
    const nextRetry = computeGenerationRetryTime((row.attemptCount || 0) + 1, new Date());
    db.update(contacts)
      .set({
        generationStatus: 'RETRY_PENDING',
        generationClaimToken: null,
        generationLeaseExpiresAt: null,
        nextGenerationRetryAt: nextRetry,
        status: 'queued',
        updatedAt: nowIso,
      })
      .where(eq(contacts.id, row.id))
      .run();

    console.warn(`[GenerationReconciler] Recovered expired generation lease for ${row.email}. Reset to RETRY_PENDING.`);
  }

  return staleRows.length;
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
  const batchCondition = batchId
    ? sql`AND contacts.batch_id = ${batchId}`
    : sql`AND batches.status NOT IN ('deleted', 'cancelled')`;

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
            AND contacts.generation_status != 'GENERATED'
            AND (
              contacts.generation_status IN ('PENDING_GENERATION', 'GENERATING')
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
            AND contacts.generation_status = 'RETRY_PENDING'
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

  // 3. Verify active verified resume exists as source of truth
  const resumeRecord = db.select().from(resume).where(eq(resume.id, 'current')).get();
  if (!resumeRecord || !resumeRecord.parsedData) {
    return {
      processed: 0,
      succeeded: 0,
      retryPending: 0,
      failed: 0,
      recovered,
      skippedReason: 'NO_ACTIVE_RESUME',
    };
  }

  let profile: StructuredResumeProfile;
  try {
    profile = JSON.parse(resumeRecord.parsedData);
  } catch {
    return {
      processed: 0,
      succeeded: 0,
      retryPending: 0,
      failed: 0,
      recovered,
      skippedReason: 'INVALID_RESUME_DATA',
    };
  }

  const resumeVersion = resumeRecord.version || resumeRecord.uploadedAt;

  // 4. Evaluate Round State: Active Generation Pass vs Generation Retry Pass
  // Invariant: Generation Retry may begin ONLY when current active Email Gen Pending count is strictly zero.
  const roundState = getGenerationRoundState(db, options.batchId);

  const cooldownCutoffIso = getCooldownCutoffIso(now.getTime());
  const batchFilter = options.batchId
    ? sql`AND contacts.batch_id = ${options.batchId}`
    : sql`AND batches.status NOT IN ('deleted', 'cancelled')`;

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
              AND contacts.status = 'queued'
              AND (contacts.email_subject IS NULL OR contacts.email_body IS NULL)
            )
          )
          AND (contacts.generation_lease_expires_at IS NULL OR contacts.generation_lease_expires_at < ${nowIso})
          AND contacts.generation_status != 'GENERATED'
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
    // Generation Retry is now eligible to process waiting transient generation failures.
    // Order by lowest generationAttemptCount first (Round 1 retries, then Round 2 retries, etc.)
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
        asc(contacts.generationAttemptCount),
        asc(contacts.createdAt),
        asc(contacts.id)
      )
      .limit(batchLimit)
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
    if (globalGeminiLimiter.isCooldownActive() && !isOpenRouterConfigured()) {
      console.log(
        `[GenerationReconciler] Global Gemini 429 cooldown active until ${globalGeminiLimiter.getCooldownUntilIso()} and OpenRouter not configured. Stopping candidate generation loop.`
      );
      break;
    }

    const claimToken = `${workerId}_${ulid()}`;
    const leaseExpiresAt = new Date(Date.now() + GENERATION_LEASE_MS).toISOString();

    const isRetryCandidate = contact.generationStatus === 'RETRY_PENDING';

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
              ${options.batchId ? sql`AND b2.id = ${options.batchId}` : sql`AND b2.status NOT IN ('deleted', 'cancelled')`}
              AND c2.is_relevant = 1
              AND c2.email_valid = 1
              AND c2.is_duplicate = 0
              AND c2.sent_at IS NULL
              AND c2.generation_status != 'GENERATED'
              AND (
                c2.generation_status IN ('PENDING_GENERATION', 'GENERATING')
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
          AND generation_status != 'GENERATED'
      `);
    }

    if (claimResult.changes === 0) {
      // Claimed by another worker, already generated, or an active pending job appeared preventing retry claim
      continue;
    }

    processed++;

    const isRetry = contact.generationStatus === 'RETRY_PENDING' || (contact.generationAttemptCount || 0) > 0;

    try {
      // 5. Generate personalized email with Gemini (or test caller override)
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
          isRetry,
          strictGemini: true,
        });
      }

      const finishTimestamp = new Date().toISOString();

      // 6. Transition to GENERATED
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
          status: 'generated',
          errorMessage: null,
          updatedAt: finishTimestamp,
        })
        .where(eq(contacts.id, contact.id))
        .run();

      // Ensure presence in outreach_queue so the send scheduler can pick it up
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
      // If both providers are in WAITING state, DO NOT mark GENERATION_FAILED or burn attempts
      if (isAiProviderUnavailableError(genErr)) {
        console.warn(
          `[GenerationReconciler] AI providers temporarily in WAITING state (${Math.ceil(
            genErr.waitRemainingMs / 1000
          )}s). Releasing contact ${contact.email} claim without burning attempt count.`
        );
        const revertStatus = isRetryCandidate ? 'RETRY_PENDING' : 'PENDING_GENERATION';
        db.update(contacts)
          .set({
            generationStatus: revertStatus,
            generationClaimToken: null,
            generationLeaseExpiresAt: null,
            status: 'queued',
            updatedAt: new Date().toISOString(),
          })
          .where(eq(contacts.id, contact.id))
          .run();
        break;
      }

      const isFromOpenRouter = isOpenRouterError(genErr);
      const isLocalBug =
        genErr instanceof SyntaxError ||
        genErr instanceof TypeError ||
        genErr instanceof RangeError;

      const diag = categorizeGeminiError(genErr);
      const attemptTimestamp = new Date().toISOString();
      const currentAttempts = (contact.generationAttemptCount || 0) + 1;

      const isRateLimit =
        diag.code === 'RATE_LIMIT_EXCEEDED' ||
        /\b429\b/.test(diag.safeDetail) ||
        /RESOURCE_EXHAUSTED/i.test(diag.safeDetail) ||
        Boolean((genErr as { isRateLimit?: boolean })?.isRateLimit);

      // ONLY record Gemini limiter cooldown if the error originated from Gemini
      if (isRateLimit && !isFromOpenRouter) {
        globalGeminiLimiter.recordError(genErr);
      }

      // If it's a local programming bug (SyntaxError, TypeError), or exceeded max retries, mark as GENERATION_FAILED
      const shouldRetry =
        diag.isTransient &&
        !isLocalBug &&
        currentAttempts < MAX_GENERATION_RETRIES;

      if (shouldRetry) {
        const nextRetry = computeGenerationRetryTime(currentAttempts, new Date());
        const providerPrefix = isFromOpenRouter ? 'OpenRouter' : 'AI';
        db.update(contacts)
          .set({
            generationStatus: 'RETRY_PENDING',
            generationAttemptCount: currentAttempts,
            lastGenerationErrorCategory: diag.code,
            nextGenerationRetryAt: nextRetry,
            generationClaimToken: null,
            generationLeaseExpiresAt: null,
            status: 'queued',
            errorMessage: `${providerPrefix} transient error (${diag.code}, attempt ${currentAttempts}/${MAX_GENERATION_RETRIES}): ${diag.safeDetail}`,
            updatedAt: attemptTimestamp,
          })
          .where(eq(contacts.id, contact.id))
          .run();

        retryPending++;
        console.warn(`[GenerationReconciler] Transient generation failure for ${contact.email} (${diag.code}, attempt ${currentAttempts}/${MAX_GENERATION_RETRIES}). Next retry at ${nextRetry}.`);
      } else {
        // Permanent error or exceeded max retries or local programming bug
        const failReason = isLocalBug
          ? `Deterministic local error (${genErr instanceof Error ? genErr.name : 'Bug'}): ${diag.safeDetail}`
          : currentAttempts >= MAX_GENERATION_RETRIES
            ? `Max retries (${MAX_GENERATION_RETRIES}) exceeded: ${diag.safeDetail}`
            : `Permanent error (${diag.code}): ${diag.safeDetail}`;

        db.update(contacts)
          .set({
            generationStatus: 'GENERATION_FAILED',
            generationAttemptCount: currentAttempts,
            lastGenerationErrorCategory: isLocalBug ? 'LOCAL_BUG' : diag.code,
            generationClaimToken: null,
            generationLeaseExpiresAt: null,
            status: 'failed',
            errorMessage: failReason,
            updatedAt: attemptTimestamp,
          })
          .where(eq(contacts.id, contact.id))
          .run();

        failed++;
        console.error(`[GenerationReconciler] Permanent generation failure for ${contact.email}: ${failReason}`);
      }

      if (isRateLimit && !isOpenRouterConfigured()) {
        console.warn(
          `[GenerationReconciler] 429 Rate limit encountered for ${contact.email} and OpenRouter not available. Stopping generation loop immediately.`
        );
        break;
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
