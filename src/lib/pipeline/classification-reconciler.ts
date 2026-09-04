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
import { categorizeGeminiError } from '@/lib/ai/gemini-client';

export interface ReconcileResult {
  processed: number;
  succeeded: number;
  promotedToQueue: number;
  stillPending: number;
  failed: number;
}

/**
 * Periodically processes company classifications that are PENDING and due for retry.
 * Survives application and container restarts by reading and persisting state in SQLite.
 */
export async function reconcilePendingClassifications(
  geminiCallerOverride?: (prompt: string) => Promise<string>
): Promise<ReconcileResult> {
  const db = getDb();
  const now = new Date();
  const nowIso = now.toISOString();

  // 1. Fetch pending company classifications due for retry
  const pendingRecords = db
    .select()
    .from(companyClassifications)
    .where(
      and(
        eq(companyClassifications.classificationResult, 'PENDING'),
        sql`(${companyClassifications.nextRetryAt} IS NULL OR ${companyClassifications.nextRetryAt} <= ${nowIso})`
      )
    )
    .all();

  if (pendingRecords.length === 0) {
    return { processed: 0, succeeded: 0, promotedToQueue: 0, stillPending: 0, failed: 0 };
  }

  console.log(`[ClassificationReconciler] Found ${pendingRecords.length} pending company classifications due for retry.`);

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
    const chunkRecords = pendingRecords.slice(i, i + BATCH_SIZE);
    const chunkInputs: CompanyEvaluationInput[] = chunkRecords.map((r) => {
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
      const results = await classifyWithGeminiBatch(chunkInputs, geminiCallerOverride);

      for (const res of results) {
        // Persist final resolution in SQLite
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

      for (const r of chunkRecords) {
        if (diag.isTransient) {
          const newRetryCount = r.retryCount + 1;
          const nextRetry = computeNextRetryTime(newRetryCount, now);

          db.update(companyClassifications)
            .set({
              retryCount: newRetryCount,
              lastErrorCategory: diag.code,
              nextRetryAt: nextRetry,
              updatedAt: new Date().toISOString(),
            })
            .where(eq(companyClassifications.normalizedName, r.normalizedName))
            .run();

          stillPending++;
        } else {
          // Permanent configuration error -> mark FAILED
          db.update(companyClassifications)
            .set({
              classificationResult: 'FAILED',
              lastErrorCategory: diag.code,
              nextRetryAt: null,
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
    processed: pendingRecords.length,
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
function cascadeClassificationToContacts(
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
        // Promote eligible contact to queued
        db.update(contacts)
          .set({
            isRelevant: true,
            relevanceConfidence: result.confidence,
            relevanceReason: result.reason,
            status: 'queued',
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
