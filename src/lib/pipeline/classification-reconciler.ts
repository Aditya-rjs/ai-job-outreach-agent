import { getDb } from '@/db';
import { companyClassifications, contacts, batches, outreachQueue } from '@/db/schema';
import { eq, sql, and, inArray } from 'drizzle-orm';
import { ulid } from 'ulid';
import {
  classifyWithGeminiBatch,
  computeNextRetryTime,
  type CompanyEvaluationInput,
  type CompanyClassificationResult,
} from '@/lib/ai/company-classifier';
import { categorizeGeminiError, globalGeminiLimiter } from '@/lib/ai/gemini-client';

export interface ReconcileResult {
  processed: number;
  succeeded: number;
  promotedToQueue: number;
  stillPending: number;
  failed: number;
}

// In-memory set to prevent duplicate classification operations within the same process
const activeClassificationOperations = new Set<string>();

export function getActiveClassificationClaims(): string[] {
  return Array.from(activeClassificationOperations);
}

export function resetActiveClassificationClaimsForTesting(): void {
  activeClassificationOperations.clear();
}

/**
 * Periodically processes company classifications that are PENDING and due for retry.
 * Survives application and container restarts by reading and persisting state in SQLite.
 */
export async function reconcilePendingClassifications(
  geminiCallerOverride?: (prompt: string) => Promise<string>
): Promise<ReconcileResult> {
  // Check if global Gemini 429 cooldown is currently active
  if (globalGeminiLimiter.isCooldownActive()) {
    console.log(
      `[ClassificationReconciler] Global Gemini 429 cooldown active until ${globalGeminiLimiter.getCooldownUntilIso()}. Skipping reconciliation run.`
    );
    return { processed: 0, succeeded: 0, promotedToQueue: 0, stillPending: 0, failed: 0 };
  }

  const db = getDb();
  const now = new Date();
  const nowIso = now.toISOString();

  // 1. Fetch pending company classifications due for retry and not leased
  const pendingRecords = db
    .select()
    .from(companyClassifications)
    .where(
      and(
        eq(companyClassifications.classificationResult, 'PENDING'),
        sql`(${companyClassifications.nextRetryAt} IS NULL OR ${companyClassifications.nextRetryAt} <= ${nowIso})`,
        sql`(${companyClassifications.claimToken} IS NULL OR ${companyClassifications.leaseExpiresAt} < ${nowIso})`
      )
    )
    .all()
    .filter((r) => !activeClassificationOperations.has(r.normalizedName));

  if (pendingRecords.length === 0) {
    return { processed: 0, succeeded: 0, promotedToQueue: 0, stillPending: 0, failed: 0 };
  }

  console.log(`[ClassificationReconciler] Found ${pendingRecords.length} pending company classifications due for retry.`);

  let processed = 0;
  let succeeded = 0;
  let promotedToQueue = 0;
  let stillPending = 0;
  let failed = 0;

  // 2. Fetch supplementary company context from contacts for richer Gemini prompt
  const normalizedNames = pendingRecords.map((r) => r.normalizedName);
  const contextMap = new Map<string, { website?: string; location?: string; designation?: string }>();

  try {
    const contactContexts = db
      .select({
        companyName: contacts.companyName,
        website: contacts.companyWebsite,
        location: contacts.companyLocation,
        designation: contacts.designation,
      })
      .from(contacts)
      .where(sql`contacts.company_name IS NOT NULL`)
      .limit(500)
      .all();

    for (const c of contactContexts) {
      if (!c.companyName) continue;
      const norm = c.companyName.trim().toLowerCase();
      if (normalizedNames.includes(norm) && !contextMap.has(norm)) {
        contextMap.set(norm, {
          website: c.website || undefined,
          location: c.location || undefined,
          designation: c.designation || undefined,
        });
      }
    }
  } catch (err) {
    console.warn('[ClassificationReconciler] Failed to fetch contact contexts:', err);
  }

  // 3. Process in controlled batches of 10
  const BATCH_SIZE = 10;
  for (let i = 0; i < pendingRecords.length; i += BATCH_SIZE) {
    // Check if cooldown became active during execution of earlier chunks
    if (globalGeminiLimiter.isCooldownActive()) {
      console.log(
        `[ClassificationReconciler] Global Gemini cooldown active until ${globalGeminiLimiter.getCooldownUntilIso()}. Stopping chunk loop.`
      );
      break;
    }

    const chunkRecords = pendingRecords.slice(i, i + BATCH_SIZE);
    const claimToken = `reconcile_${ulid()}`;
    const leaseExpiresAt = new Date(Date.now() + 60000).toISOString();

    // Atomic claim lease per company record
    const claimedChunk: typeof chunkRecords = [];
    for (const r of chunkRecords) {
      try {
        const claimRes = db.run(sql`
          UPDATE company_classifications
          SET claim_token = ${claimToken},
              lease_expires_at = ${leaseExpiresAt},
              updated_at = ${nowIso}
          WHERE normalized_name = ${r.normalizedName}
            AND classification_result = 'PENDING'
            AND (claim_token IS NULL OR lease_expires_at < ${nowIso})
        `);
        if (claimRes.changes > 0) {
          activeClassificationOperations.add(r.normalizedName);
          claimedChunk.push(r);
        }
      } catch {
        // Fallback for environments where migration is pending
        activeClassificationOperations.add(r.normalizedName);
        claimedChunk.push(r);
      }
    }

    if (claimedChunk.length === 0) {
      continue;
    }

    processed += claimedChunk.length;

    const chunkInputs: CompanyEvaluationInput[] = claimedChunk.map((r) => {
      const ctx = contextMap.get(r.normalizedName);
      return {
        companyName: r.companyName,
        normalizedName: r.normalizedName,
        website: ctx?.website,
        location: ctx?.location,
        designationContext: ctx?.designation,
      };
    });

    try {
      const results = await classifyWithGeminiBatch(chunkInputs, geminiCallerOverride, { isRetry: true });

      for (const res of results) {
        activeClassificationOperations.delete(res.normalizedName);

        // Persist final resolution in SQLite and release lease
        db.update(companyClassifications)
          .set({
            isRelevant: res.relevant,
            confidence: res.confidence,
            reason: res.reason,
            classificationSource: 'gemini',
            geminiModel: res.geminiModel,
            classificationResult: res.status,
            lastErrorCategory: null,
            nextRetryAt: null,
            claimToken: null,
            leaseExpiresAt: null,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(companyClassifications.normalizedName, res.normalizedName))
          .run();

        // Cascade resolution to associated contacts in active batches
        const newlyPromoted = cascadeClassificationToContacts(db, res);
        promotedToQueue += newlyPromoted;
        succeeded++;
      }
    } catch (err: unknown) {
      const diag = categorizeGeminiError(err);
      console.warn(`[ClassificationReconciler] Batch retry failed (${diag.code}): ${diag.safeDetail}`);

      // Release in-memory claims
      for (const r of claimedChunk) {
        activeClassificationOperations.delete(r.normalizedName);
      }

      const isRateLimit =
        diag.code === 'RATE_LIMIT_EXCEEDED' ||
        /\b429\b/.test(diag.safeDetail) ||
        /RESOURCE_EXHAUSTED/i.test(diag.safeDetail);

      if (isRateLimit) {
        // Propagate into global rate limiter if custom caller was passed
        globalGeminiLimiter.recordError(err);

        // Persist failure and increment retryCount EXACTLY ONCE for this attempted chunk
        for (const r of claimedChunk) {
          const newRetryCount = r.retryCount + 1;
          const nextRetry = computeNextRetryTime(newRetryCount, now);

          db.update(companyClassifications)
            .set({
              retryCount: newRetryCount,
              lastErrorCategory: diag.code,
              nextRetryAt: nextRetry,
              claimToken: null,
              leaseExpiresAt: null,
              updatedAt: new Date().toISOString(),
            })
            .where(eq(companyClassifications.normalizedName, r.normalizedName))
            .run();

          stillPending++;
        }

        console.warn(
          `[ClassificationReconciler] 429 Rate limit encountered on chunk. Stopping reconciliation run immediately to protect quota. 0 subsequent chunks attempted.`
        );

        // STOP THE CURRENT RUN IMMEDIATELY — DO NOT ATTEMPT REMAINING CHUNKS!
        break;
      } else if (diag.isTransient) {
        for (const r of claimedChunk) {
          const newRetryCount = r.retryCount + 1;
          const nextRetry = computeNextRetryTime(newRetryCount, now);

          db.update(companyClassifications)
            .set({
              retryCount: newRetryCount,
              lastErrorCategory: diag.code,
              nextRetryAt: nextRetry,
              claimToken: null,
              leaseExpiresAt: null,
              updatedAt: new Date().toISOString(),
            })
            .where(eq(companyClassifications.normalizedName, r.normalizedName))
            .run();

          stillPending++;
        }
      } else {
        // Permanent configuration error -> mark FAILED
        for (const r of claimedChunk) {
          db.update(companyClassifications)
            .set({
              classificationResult: 'FAILED',
              lastErrorCategory: diag.code,
              nextRetryAt: null,
              claimToken: null,
              leaseExpiresAt: null,
              reason: `Gemini configuration error: ${diag.explanation}`,
              updatedAt: new Date().toISOString(),
            })
            .where(eq(companyClassifications.normalizedName, r.normalizedName))
            .run();

          failed++;
        }
      }
    }

    // Pacing delay between batches
    if (i + BATCH_SIZE < pendingRecords.length) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  // 4. Reconcile batch-level counters for affected batches
  reconcileActiveBatchCounters(db);

  return {
    processed,
    succeeded,
    promotedToQueue,
    stillPending,
    failed,
  };
}


/**
 * Cascades a resolved company classification to all contacts of that company across active batches.
 * Returns the number of eligible contacts newly promoted into the outreach queue.
 */
export function cascadeClassificationToContacts(
  db: ReturnType<typeof getDb>,
  result: CompanyClassificationResult
): number {

  let promotedCount = 0;
  const nowIso = new Date().toISOString();

  // Find matching contacts in active batches
  const matchingContacts = db
    .select({
      id: contacts.id,
      batchId: contacts.batchId,
      emailValid: contacts.emailValid,
      isDuplicate: contacts.isDuplicate,
      status: contacts.status,
    })
    .from(contacts)
    .innerJoin(batches, eq(contacts.batchId, batches.id))
    .where(
      and(
        sql`LOWER(TRIM(contacts.company_name)) = ${result.normalizedName}`,
        sql`batches.status NOT IN ('deleted', 'cancelled')`
      )
    )
    .all();

  for (const c of matchingContacts) {
    if (result.status === 'RELEVANT') {
      const isEligible = c.emailValid && !c.isDuplicate;

      if (isEligible) {
        // Promote eligible contact to queued and schedule for generation if not already generated
        db.update(contacts)
          .set({
            isRelevant: true,
            relevanceConfidence: result.confidence,
            relevanceReason: result.reason,
            status: 'queued',
            generationStatus: sql`CASE WHEN generation_status = 'GENERATED' THEN 'GENERATED' ELSE 'PENDING_GENERATION' END`,
            updatedAt: nowIso,
          })
          .where(eq(contacts.id, c.id))
          .run();

        // Check if queue entry already exists
        const existingQueue = db
          .select({ id: outreachQueue.id })
          .from(outreachQueue)
          .where(eq(outreachQueue.contactId, c.id))
          .get();

        if (!existingQueue) {
          db.insert(outreachQueue)
            .values({
              id: `queue_${ulid()}`,
              contactId: c.id,
              priority: 0,
              status: 'pending',
              attempts: 0,
              createdAt: nowIso,
              updatedAt: nowIso,
            })
            .run();
          promotedCount++;
        }
      } else {
        // Duplicate or invalid email: mark relevant but keep skipped
        db.update(contacts)
          .set({
            isRelevant: true,
            relevanceConfidence: result.confidence,
            relevanceReason: result.reason,
            generationStatus: null,
            updatedAt: nowIso,
          })
          .where(eq(contacts.id, c.id))
          .run();
      }
    } else if (result.status === 'IRRELEVANT') {
      // Mark as irrelevant and skipped
      db.update(contacts)
        .set({
          isRelevant: false,
          relevanceConfidence: result.confidence,
          relevanceReason: result.reason,
          status: 'skipped',
          generationStatus: null,
          updatedAt: nowIso,
        })
        .where(eq(contacts.id, c.id))
        .run();

      // Remove from queue if it was somehow queued
      db.delete(outreachQueue).where(eq(outreachQueue.contactId, c.id)).run();
    } else if (result.status === 'NEEDS_REVIEW') {
      // Ambiguous -> uncertain, keep out of queue
      db.update(contacts)
        .set({
          isRelevant: null,
          relevanceConfidence: result.confidence,
          relevanceReason: result.reason,
          status: 'uncertain',
          generationStatus: null,
          updatedAt: nowIso,
        })
        .where(eq(contacts.id, c.id))
        .run();

      db.delete(outreachQueue).where(eq(outreachQueue.contactId, c.id)).run();
    }
  }


  return promotedCount;
}

/**
 * Reconciles batch-level aggregated metrics after classifications change.
 */
function reconcileActiveBatchCounters(db: ReturnType<typeof getDb>): void {
  try {
    const activeBatches = db
      .select({ id: batches.id })
      .from(batches)
      .where(sql`status NOT IN ('deleted', 'cancelled')`)
      .all();

    for (const b of activeBatches) {
      const stats = db
        .select({
          relevantCompanies: sql<number>`COUNT(DISTINCT CASE WHEN is_relevant = 1 THEN LOWER(TRIM(company_name)) END)`,
          irrelevantCompanies: sql<number>`COUNT(DISTINCT CASE WHEN is_relevant = 0 THEN LOWER(TRIM(company_name)) END)`,
          emailsPending: sql<number>`SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END)`,
        })
        .from(contacts)
        .where(eq(contacts.batchId, b.id))
        .get();

      if (stats) {
        db.update(batches)
          .set({
            relevantCompanies: stats.relevantCompanies || 0,
            irrelevantCompanies: stats.irrelevantCompanies || 0,
            emailsPending: stats.emailsPending || 0,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(batches.id, b.id))
          .run();
      }
    }
  } catch (err) {
    console.warn('[ClassificationReconciler] Error reconciling batch counters:', err);
  }
}
