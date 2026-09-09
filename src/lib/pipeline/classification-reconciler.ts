import { getDb } from '@/db';
import { companyClassifications, contacts, batches, outreachQueue } from '@/db/schema';
import { eq, sql, and, or, inArray } from 'drizzle-orm';
import { ulid } from 'ulid';
import {
  classifyWithGeminiBatch,
  type CompanyEvaluationInput,
  type CompanyClassificationResult,
  type ClassificationStatus,
  type ClassificationSource,
} from '@/lib/ai/company-classifier';
import { categorizeGeminiError, globalGeminiLimiter } from '@/lib/ai/gemini-client';
import { isOpenRouterConfigured, isOpenRouterError } from '@/lib/ai/openrouter-client';
import { isAiProviderUnavailableError } from '@/lib/ai/ai-dispatcher';
import { normalizeCompanyName, formatCompanyDisplayName } from '@/lib/utils/company';
import { searchCompanyDatabaseBatch, resolveCanonicalAndPersist } from '@/lib/kb/relevant-companies-kb';
import { generateCanonicalCompanyNames } from '@/lib/ai/canonical-name-generator';

export interface ReconcileResult {
  processed: number;
  succeeded: number;
  promotedToQueue: number;
  stillPending: number;
  failed: number;
  promotedToNextRound?: number;
  rateLimitEncountered?: boolean;
}

export const MAX_CLASSIFICATION_ROUNDS = 5;

// In-memory set to prevent duplicate classification operations within the same process
const activeClassificationOperations = new Set<string>();

export function getActiveClassificationClaims(): string[] {
  return Array.from(activeClassificationOperations);
}

export function resetActiveClassificationClaimsForTesting(): void {
  activeClassificationOperations.clear();
}

/**
 * Retrieves the normalized company names associated with unclassified contacts in a given batch.
 */
export function getUnclassifiedCompanyNamesForBatch(
  db: ReturnType<typeof getDb>,
  batchId: string
): string[] {
  const rows = db
    .select({
      companyName: contacts.companyName,
    })
    .from(contacts)
    .where(
      and(
        eq(contacts.batchId, batchId),
        sql`contacts.company_name IS NOT NULL AND TRIM(contacts.company_name) != ''`,
        sql`contacts.is_relevant IS NULL`
      )
    )
    .all();

  const nameSet = new Set<string>();
  for (const r of rows) {
    if (!r.companyName) continue;
    const norm = normalizeCompanyName(r.companyName);
    if (norm) nameSet.add(norm);
    const simple = r.companyName.trim().toLowerCase();
    if (simple) nameSet.add(simple);
  }
  return Array.from(nameSet);
}

/**
 * Returns the current persistent state of company classification rounds, optionally scoped to a batch.
 */
export function getClassificationRoundState(
  db: ReturnType<typeof getDb> = getDb(),
  batchId?: string
): {
  activePendingCount: number;
  retryWaitingCount: number;
  currentMaxRound: number;
  isCurrentRoundDrained: boolean;
} {
  if (batchId) {
    const unclassifiedNames = getUnclassifiedCompanyNamesForBatch(db, batchId);
    if (unclassifiedNames.length === 0) {
      return {
        activePendingCount: 0,
        retryWaitingCount: 0,
        currentMaxRound: 0,
        isCurrentRoundDrained: true,
      };
    }

    let activePendingCount = 0;
    let retryWaitingCount = 0;
    let currentMaxRound = 0;

    const CHUNK_SIZE = 200;
    for (let i = 0; i < unclassifiedNames.length; i += CHUNK_SIZE) {
      const chunk = unclassifiedNames.slice(i, i + CHUNK_SIZE);
      const rows = db
        .select({
          classificationResult: companyClassifications.classificationResult,
          retryRound: companyClassifications.retryRound,
        })
        .from(companyClassifications)
        .where(inArray(companyClassifications.normalizedName, chunk))
        .all();

      for (const r of rows) {
        if (r.classificationResult === 'PENDING') {
          activePendingCount++;
        } else if (r.classificationResult === 'RETRY_WAITING') {
          retryWaitingCount++;
        }
        if (r.retryRound && r.retryRound > currentMaxRound) {
          currentMaxRound = r.retryRound;
        }
      }
    }

    return {
      activePendingCount,
      retryWaitingCount,
      currentMaxRound,
      isCurrentRoundDrained: activePendingCount === 0,
    };
  }

  const row = db.get<{
    activePending: number;
    retryWaiting: number;
    maxRound: number;
  }>(sql`
    SELECT
      SUM(CASE WHEN classification_result = 'PENDING' THEN 1 ELSE 0 END) as activePending,
      SUM(CASE WHEN classification_result = 'RETRY_WAITING' THEN 1 ELSE 0 END) as retryWaiting,
      COALESCE(MAX(retry_round), 0) as maxRound
    FROM company_classifications
  `);

  const activePendingCount = row?.activePending ?? 0;
  const retryWaitingCount = row?.retryWaiting ?? 0;
  const currentMaxRound = row?.maxRound ?? 0;

  return {
    activePendingCount,
    retryWaitingCount,
    currentMaxRound,
    isCurrentRoundDrained: activePendingCount === 0,
  };
}

/**
 * Discovers active companies in contacts where is_relevant IS NULL and either:
 * - Immediately cascades to contacts if an authoritative classification already exists.
 * - Seeds a PENDING row in company_classifications (retryCount: 0, nextRetryAt: nowIso)
 *   without resetting FAILED records or duplicating rows.
 */
export function discoverAndSeedOrphanedCompanies(
  db: ReturnType<typeof getDb>,
  nowIso: string = new Date().toISOString(),
  batchId?: string
): { seeded: number; cascaded: number } {
  let seeded = 0;
  let cascaded = 0;

  const whereConditions = [
    sql`contacts.company_name IS NOT NULL AND TRIM(contacts.company_name) != ''`,
    sql`contacts.is_relevant IS NULL`,
    sql`batches.status NOT IN ('deleted', 'cancelled')`,
  ];
  if (batchId) {
    whereConditions.push(eq(contacts.batchId, batchId));
  }

  // Find contacts in active batches where is_relevant IS NULL and company_name is present
  const unclassifiedContacts = db
    .select({
      companyName: contacts.companyName,
    })
    .from(contacts)
    .innerJoin(batches, eq(contacts.batchId, batches.id))
    .where(and(...whereConditions))
    .all();

  if (unclassifiedContacts.length === 0) {
    return { seeded: 0, cascaded: 0 };
  }

  // Deduplicate by normalized name
  const companyMap = new Map<string, string>(); // normalized -> original name
  const candidateKeys = new Set<string>();
  for (const c of unclassifiedContacts) {
    if (!c.companyName) continue;
    const norm = normalizeCompanyName(c.companyName);
    const simple = c.companyName.trim().toLowerCase();
    if (norm) candidateKeys.add(norm);
    if (simple) candidateKeys.add(simple);
    if (norm && !companyMap.has(norm)) {
      companyMap.set(norm, c.companyName.trim());
    }
  }

  const searchKeyList = Array.from(candidateKeys);
  if (searchKeyList.length === 0) {
    return { seeded: 0, cascaded: 0 };
  }

  // Query existing classifications in chunks to avoid SQLite variable limits
  const existingRows: (typeof companyClassifications.$inferSelect)[] = [];
  const CHUNK_SIZE = 200;
  for (let i = 0; i < searchKeyList.length; i += CHUNK_SIZE) {
    const chunk = searchKeyList.slice(i, i + CHUNK_SIZE);
    const rows = db
      .select()
      .from(companyClassifications)
      .where(
        or(
          inArray(companyClassifications.normalizedName, chunk),
          inArray(sql`LOWER(${companyClassifications.companyName})`, chunk)
        )
      )
      .all();
    existingRows.push(...rows);
  }

  const existingMap = new Map<string, typeof companyClassifications.$inferSelect>();
  for (const r of existingRows) {
    existingMap.set(r.normalizedName, r);
    existingMap.set(r.companyName.trim().toLowerCase(), r);
    const n = normalizeCompanyName(r.companyName);
    if (n) existingMap.set(n, r);
  }

  // Check Relevant Company Knowledge Base first (FOUND -> RELEVANT -> 0 AI calls)
  const kbMatches = searchCompanyDatabaseBatch(Array.from(companyMap.values()), db);
  for (const [norm, rawName] of Array.from(companyMap.entries())) {
    if (kbMatches.has(norm)) {
      const match = kbMatches.get(norm)!;
      const newlyPromoted = cascadeClassificationToContacts(db, {
        companyName: formatCompanyDisplayName(rawName),
        normalizedName: norm,
        relevant: true,
        confidence: 1.0,
        reason: `Relevant — Known Company Knowledge Base: ${match.canonicalName}`,
        status: 'RELEVANT',
        source: 'gemini',
        geminiModel: 'knowledge-base',
        retryCount: 0,
      });
      cascaded += newlyPromoted;
      companyMap.delete(norm);
    }
  }

  for (const [norm, rawName] of companyMap.entries()) {
    const existing = existingMap.get(norm) || existingMap.get(rawName.toLowerCase());

    if (existing) {
      if (
        existing.classificationResult === 'RELEVANT' ||
        existing.classificationResult === 'IRRELEVANT' ||
        existing.classificationResult === 'NEEDS_REVIEW'
      ) {
        // Cascade completed classification immediately to newly discovered contacts without AI call
        const newlyPromoted = cascadeClassificationToContacts(db, {
          companyName: existing.companyName,
          normalizedName: existing.normalizedName,
          relevant: existing.isRelevant,
          confidence: existing.confidence,
          reason: existing.reason || (existing.isRelevant ? 'Relevant — Gemini' : 'Not Relevant — Gemini'),
          status: existing.classificationResult as ClassificationStatus,
          source: (existing.classificationSource as ClassificationSource) || 'gemini',
          geminiModel: existing.geminiModel || 'gemini-3.8-flash',
          retryCount: existing.retryCount,
        });
        cascaded += newlyPromoted;
      }
      // If FAILED, RETRY_WAITING, or PENDING: respect existing state, do not reset
      continue;
    }

    // No existing classification: insert as PENDING (Round 0 / First Pass)
    try {
      db.insert(companyClassifications)
        .values({
          normalizedName: norm,
          companyName: formatCompanyDisplayName(rawName),
          isRelevant: null,
          confidence: null,
          reason: 'Classification Pending — Discovered unclassified company from active batch.',
          classificationSource: 'gemini',
          geminiModel: 'gemini-3.8-flash',
          classificationResult: 'PENDING',
          retryRound: 0,
          retryCount: 0,
          nextRetryAt: nowIso,
          createdAt: nowIso,
          updatedAt: nowIso,
        })
        .onConflictDoNothing()
        .run();
      seeded++;
    } catch (err) {
      console.warn(`[ClassificationReconciler] Failed to seed orphaned company ${norm}:`, err);
    }
  }

  return { seeded, cascaded };
}

/**
 * Atomically promotes RETRY_WAITING records for a specific batch to the next retry round.
 * Scoped strictly to companies associated with unclassified contacts in batchId.
 * Only promotes when active PENDING for this batch is strictly 0.
 * Identifies the current retry round and atomically promotes only those records.
 */
export function promoteBatchRetryWaitingToNextRound(
  db: ReturnType<typeof getDb>,
  batchId: string,
  nowIso: string = new Date().toISOString()
): number {
  let promoted = 0;

  db.transaction((tx) => {
    // 1. Get unclassified company normalized names for this batch
    const unclassifiedNames = getUnclassifiedCompanyNamesForBatch(tx as unknown as ReturnType<typeof getDb>, batchId);
    if (unclassifiedNames.length === 0) {
      return;
    }

    // 2. Verify active PENDING is strictly 0 for this batch
    let pendingCount = 0;
    const CHUNK_SIZE = 200;
    for (let i = 0; i < unclassifiedNames.length; i += CHUNK_SIZE) {
      const chunk = unclassifiedNames.slice(i, i + CHUNK_SIZE);
      const rows = tx
        .select({
          normalizedName: companyClassifications.normalizedName,
        })
        .from(companyClassifications)
        .where(
          and(
            inArray(companyClassifications.normalizedName, chunk),
            eq(companyClassifications.classificationResult, 'PENDING')
          )
        )
        .all();
      pendingCount += rows.length;
    }

    if (pendingCount > 0) {
      // Current round for this batch is NOT drained; cannot promote
      return;
    }

    // 3. Find all RETRY_WAITING companies belonging to this batch
    const waitingRows: { normalizedName: string; retryRound: number }[] = [];
    for (let i = 0; i < unclassifiedNames.length; i += CHUNK_SIZE) {
      const chunk = unclassifiedNames.slice(i, i + CHUNK_SIZE);
      const rows = tx
        .select({
          normalizedName: companyClassifications.normalizedName,
          retryRound: companyClassifications.retryRound,
        })
        .from(companyClassifications)
        .where(
          and(
            inArray(companyClassifications.normalizedName, chunk),
            eq(companyClassifications.classificationResult, 'RETRY_WAITING')
          )
        )
        .all();
      for (const r of rows) {
        waitingRows.push({
          normalizedName: r.normalizedName,
          retryRound: r.retryRound ?? 0,
        });
      }
    }

    if (waitingRows.length === 0) {
      return;
    }

    // 4. Identify the current classification round (minimum round among waiting rows for this batch)
    const targetRound = Math.min(...waitingRows.map((r) => r.retryRound));
    const targetNames = waitingRows
      .filter((r) => r.retryRound === targetRound)
      .map((r) => r.normalizedName);

    if (targetNames.length === 0) {
      return;
    }

    // 5. Atomically promote ONLY unresolved RETRY_WAITING records belonging to that round for this batch
    for (let i = 0; i < targetNames.length; i += CHUNK_SIZE) {
      const chunk = targetNames.slice(i, i + CHUNK_SIZE);
      const promoteRes = tx
        .update(companyClassifications)
        .set({
          classificationResult: 'PENDING',
          retryRound: sql`retry_round + 1`,
          claimToken: null,
          leaseExpiresAt: null,
          reason: 'Classification Pending — Promoted to next retry round for batch.',
          updatedAt: nowIso,
        })
        .where(
          and(
            inArray(companyClassifications.normalizedName, chunk),
            eq(companyClassifications.classificationResult, 'RETRY_WAITING'),
            eq(companyClassifications.retryRound, targetRound)
          )
        )
        .run();

      promoted += promoteRes.changes;
    }
  });

  return promoted;
}

/**
 * Fallback promotion for environments without active batch records.
 */
function promoteGlobalRetryWaitingToNextRound(
  db: ReturnType<typeof getDb>,
  nowIso: string = new Date().toISOString()
): number {
  let promoted = 0;
  db.transaction((tx) => {
    const activePendingCount = tx.get<{ count: number }>(sql`
      SELECT COUNT(*) as count FROM company_classifications
      WHERE classification_result = 'PENDING'
    `)?.count ?? 0;

    if (activePendingCount === 0) {
      const waitingRows = tx.all<{ normalized_name: string; retry_round: number }>(sql`
        SELECT normalized_name, retry_round
        FROM company_classifications
        WHERE classification_result = 'RETRY_WAITING'
      `);

      if (waitingRows.length > 0) {
        const targetRound = Math.min(...waitingRows.map((r) => r.retry_round ?? 0));
        const promoteRes = tx.run(sql`
          UPDATE company_classifications
          SET classification_result = 'PENDING',
              retry_round = retry_round + 1,
              claim_token = NULL,
              lease_expires_at = NULL,
              reason = 'Classification Pending — Promoted to next retry round.',
              updated_at = ${nowIso}
          WHERE classification_result = 'RETRY_WAITING'
            AND retry_round = ${targetRound}
        `);
        promoted = promoteRes.changes;
      }
    }
  });
  return promoted;
}

/**
 * Reconciles company classifications for a single batch with full isolation.
 */
async function reconcileSingleBatch(
  db: ReturnType<typeof getDb>,
  batchId: string,
  nowIso: string,
  geminiCallerOverride?: (prompt: string) => Promise<string>,
  options?: { batchSize?: number }
): Promise<ReconcileResult> {
  let promotedToQueue = 0;

  // 1. Discover unclassified companies from this batch and seed them or cascade completed
  try {
    const discovery = discoverAndSeedOrphanedCompanies(db, nowIso, batchId);
    promotedToQueue += discovery.cascaded;
    if (discovery.seeded > 0 || discovery.cascaded > 0) {
      console.log(
        `[ClassificationReconciler] [Batch ${batchId}] Discovered unclassified companies: ${discovery.seeded} seeded as PENDING, ${discovery.cascaded} cascaded from existing classifications.`
      );
    }
  } catch (err) {
    console.warn(`[ClassificationReconciler] [Batch ${batchId}] Error during orphan discovery:`, err);
  }

  // Check if global Gemini 429 cooldown is currently active and OpenRouter is not available
  if (globalGeminiLimiter.isCooldownActive() && !isOpenRouterConfigured()) {
    console.log(
      `[ClassificationReconciler] Global Gemini 429 cooldown active until ${globalGeminiLimiter.getCooldownUntilIso()} and OpenRouter not configured. Skipping reconciliation AI calls.`
    );
    return { processed: 0, succeeded: 0, promotedToQueue, stillPending: 0, failed: 0 };
  }

  // 2. Fetch unclassified companies belonging to this batch
  const batchCompanyNames = getUnclassifiedCompanyNamesForBatch(db, batchId);
  if (batchCompanyNames.length === 0) {
    return { processed: 0, succeeded: 0, promotedToQueue, stillPending: 0, failed: 0 };
  }

  // 3. Fetch active PENDING company classifications belonging to this batch and current round
  let pendingRecords = db
    .select()
    .from(companyClassifications)
    .where(
      and(
        inArray(companyClassifications.normalizedName, batchCompanyNames),
        eq(companyClassifications.classificationResult, 'PENDING'),
        sql`(${companyClassifications.nextRetryAt} IS NULL OR ${companyClassifications.nextRetryAt} <= ${nowIso})`,
        sql`(${companyClassifications.claimToken} IS NULL OR ${companyClassifications.leaseExpiresAt} < ${nowIso})`
      )
    )
    .all()
    .filter((r) => !activeClassificationOperations.has(r.normalizedName));

  let promotedToNextRound = 0;

  // 4. BATCH-SCOPED ROUND RULE: If current round for this batch is completely drained (active PENDING == 0),
  // promote only RETRY_WAITING companies belonging to this batch
  if (pendingRecords.length === 0) {
    promotedToNextRound = promoteBatchRetryWaitingToNextRound(db, batchId, nowIso);

    if (promotedToNextRound > 0) {
      console.log(
        `[ClassificationReconciler] [Batch ${batchId}] Current round drained (Classification Pending = 0). Promoted ${promotedToNextRound} RETRY_WAITING companies to PENDING for the next retry round.`
      );

      // Re-fetch pending records for this batch so the newly started retry round begins processing immediately
      pendingRecords = db
        .select()
        .from(companyClassifications)
        .where(
          and(
            inArray(companyClassifications.normalizedName, batchCompanyNames),
            eq(companyClassifications.classificationResult, 'PENDING'),
            sql`(${companyClassifications.nextRetryAt} IS NULL OR ${companyClassifications.nextRetryAt} <= ${nowIso})`,
            sql`(${companyClassifications.claimToken} IS NULL OR ${companyClassifications.leaseExpiresAt} < ${nowIso})`
          )
        )
        .all()
        .filter((r) => !activeClassificationOperations.has(r.normalizedName));
    }
  }

  if (pendingRecords.length === 0) {
    return { processed: 0, succeeded: 0, promotedToQueue, stillPending: 0, failed: 0, promotedToNextRound };
  }

  // Sort pendingRecords to preserve batch FIFO contact appearance order
  const orderMap = new Map<string, number>();
  batchCompanyNames.forEach((name, idx) => orderMap.set(name, idx));
  pendingRecords.sort((a, b) => (orderMap.get(a.normalizedName) ?? 0) - (orderMap.get(b.normalizedName) ?? 0));

  console.log(`[ClassificationReconciler] [Batch ${batchId}] Found ${pendingRecords.length} active PENDING company classifications to process.`);

  let processed = 0;
  let succeeded = 0;
  let stillPending = 0;
  let failed = 0;
  let rateLimitEncountered = false;

  // 5. Fetch supplementary company context from contacts for Gemini / OpenRouter prompt (website only)
  const normalizedNames = pendingRecords.map((r) => r.normalizedName);
  const contextMap = new Map<string, { website?: string }>();

  try {
    const contactContexts = db
      .select({
        companyName: contacts.companyName,
        website: contacts.companyWebsite,
      })
      .from(contacts)
      .where(
        and(
          eq(contacts.batchId, batchId),
          sql`contacts.company_name IS NOT NULL`,
          sql`contacts.company_website IS NOT NULL AND TRIM(contacts.company_website) != ''`
        )
      )
      .all();

    for (const c of contactContexts) {
      if (!c.companyName) continue;
      const norm = normalizeCompanyName(c.companyName);
      if (norm && normalizedNames.includes(norm) && !contextMap.has(norm)) {
        contextMap.set(norm, {
          website: c.website || undefined,
        });
      }
    }
  } catch (err) {
    console.warn(`[ClassificationReconciler] [Batch ${batchId}] Failed to fetch contact contexts:`, err);
  }

  // 6. Process in controlled batches of 20 (or custom batchSize if specified)
  const BATCH_SIZE = options?.batchSize && options.batchSize > 0 ? options.batchSize : 20;
  for (let i = 0; i < pendingRecords.length; i += BATCH_SIZE) {
    if (globalGeminiLimiter.isCooldownActive() && !isOpenRouterConfigured()) {
      console.log(
        `[ClassificationReconciler] Global Gemini cooldown active until ${globalGeminiLimiter.getCooldownUntilIso()} and OpenRouter not configured. Stopping chunk loop.`
      );
      break;
    }

    const chunkRecords = pendingRecords.slice(i, i + BATCH_SIZE);
    const claimToken = `reconcile_batch_${batchId}_${ulid()}`;
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
      };
    });

    try {
      const results = await classifyWithGeminiBatch(chunkInputs, geminiCallerOverride, { isRetry: true });

      // Persist newly confirmed RELEVANT companies to Relevant Company KB
      const relevantResults = results.filter((r) => r.status === 'RELEVANT');
      if (relevantResults.length > 0) {
        try {
          const canonicalMap = await generateCanonicalCompanyNames(
            relevantResults.map((r) => r.companyName)
          );
          for (const rel of relevantResults) {
            const canonical = canonicalMap.get(formatCompanyDisplayName(rel.companyName)) || rel.companyName;
            const persisted = resolveCanonicalAndPersist(canonical, rel.companyName, db);
            rel.reason += ` (KB Canonical: ${persisted.canonicalName})`;
          }
        } catch (kbErr) {
          console.warn('[ClassificationReconciler] Notice while persisting to RelevantCompanyKB:', kbErr);
        }
      }

      for (const res of results) {
        activeClassificationOperations.delete(res.normalizedName);

        // Persist final resolution in SQLite and release lease
        db.update(companyClassifications)
          .set({
            isRelevant: res.relevant,
            confidence: res.confidence,
            reason: res.reason,
            classificationSource: res.source || 'gemini',
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

        // Cascade resolution to associated contacts in active batches immediately (progressive downstream pipeline)
        const newlyPromoted = cascadeClassificationToContacts(db, res);
        promotedToQueue += newlyPromoted;
        succeeded++;
      }
    } catch (err: unknown) {
      const diag = categorizeGeminiError(err);
      console.warn(`[ClassificationReconciler] Batch classification failed (${diag.code}): ${diag.safeDetail}`);

      // Release in-memory claims
      for (const r of claimedChunk) {
        activeClassificationOperations.delete(r.normalizedName);
      }

      // If both providers are temporarily unavailable in WAITING state, DO NOT burn retries or mark FAILED
      if (isAiProviderUnavailableError(err)) {
        console.warn(
          `[ClassificationReconciler] AI providers temporarily in WAITING state (${Math.ceil(
            err.waitRemainingMs / 1000
          )}s). Keeping ${claimedChunk.length} companies in current state without burning retry rounds.`
        );
        for (const r of claimedChunk) {
          db.update(companyClassifications)
            .set({
              claimToken: null,
              leaseExpiresAt: null,
              updatedAt: new Date().toISOString(),
            })
            .where(eq(companyClassifications.normalizedName, r.normalizedName))
            .run();
        }
        rateLimitEncountered = true;
        break;
      }

      const isFromOpenRouter = isOpenRouterError(err);
      const isRateLimit =
        diag.code === 'RATE_LIMIT_EXCEEDED' ||
        /\b429\b/.test(diag.safeDetail) ||
        /RESOURCE_EXHAUSTED/i.test(diag.safeDetail) ||
        Boolean((err as { isRateLimit?: boolean })?.isRateLimit);

      if (isRateLimit) {
        // ONLY update Gemini limiter cooldown if the 429 originated from Gemini
        if (!isFromOpenRouter) {
          globalGeminiLimiter.recordError(err);
        }

        for (const r of claimedChunk) {
          const newRetryCount = r.retryCount + 1;
          if (newRetryCount >= MAX_CLASSIFICATION_ROUNDS) {
            db.update(companyClassifications)
              .set({
                classificationResult: 'FAILED',
                retryCount: newRetryCount,
                lastErrorCategory: diag.code,
                nextRetryAt: null,
                claimToken: null,
                leaseExpiresAt: null,
                reason: `Classification failed: maximum retry rounds (${MAX_CLASSIFICATION_ROUNDS}) exceeded.`,
                updatedAt: new Date().toISOString(),
              })
              .where(eq(companyClassifications.normalizedName, r.normalizedName))
              .run();

            failed++;
          } else {
            db.update(companyClassifications)
              .set({
                classificationResult: 'RETRY_WAITING',
                retryCount: newRetryCount,
                lastErrorCategory: diag.code,
                nextRetryAt: null,
                claimToken: null,
                leaseExpiresAt: null,
                reason: 'Classification Retry Waiting — Rate limit encountered. Waiting for current round to drain before next retry round.',
                updatedAt: new Date().toISOString(),
              })
              .where(eq(companyClassifications.normalizedName, r.normalizedName))
              .run();

            stillPending++;
          }
        }

        rateLimitEncountered = true;
        console.warn(
          `[ClassificationReconciler] 429 Rate limit encountered. Marked ${claimedChunk.length} companies as RETRY_WAITING. Stopping reconciliation run immediately to protect quota.`
        );
        break;
      } else if (diag.isTransient) {
        for (const r of claimedChunk) {
          const newRetryCount = r.retryCount + 1;
          if (newRetryCount >= MAX_CLASSIFICATION_ROUNDS) {
            db.update(companyClassifications)
              .set({
                classificationResult: 'FAILED',
                retryCount: newRetryCount,
                lastErrorCategory: diag.code,
                nextRetryAt: null,
                claimToken: null,
                leaseExpiresAt: null,
                reason: `Classification failed: maximum retry rounds (${MAX_CLASSIFICATION_ROUNDS}) exceeded.`,
                updatedAt: new Date().toISOString(),
              })
              .where(eq(companyClassifications.normalizedName, r.normalizedName))
              .run();

            failed++;
          } else {
            db.update(companyClassifications)
              .set({
                classificationResult: 'RETRY_WAITING',
                retryCount: newRetryCount,
                lastErrorCategory: diag.code,
                nextRetryAt: null,
                claimToken: null,
                leaseExpiresAt: null,
                reason: `Classification Retry Waiting — Transient error (${diag.code}). Waiting for current round to drain before next retry round.`,
                updatedAt: new Date().toISOString(),
              })
              .where(eq(companyClassifications.normalizedName, r.normalizedName))
              .run();

            stillPending++;
          }
        }

        console.warn(
          `[ClassificationReconciler] Transient error encountered. Marked ${claimedChunk.length} companies as RETRY_WAITING. Continuing next chunk.`
        );
      } else {
        // Permanent error
        for (const r of claimedChunk) {
          db.update(companyClassifications)
            .set({
              classificationResult: 'FAILED',
              lastErrorCategory: diag.code,
              nextRetryAt: null,
              claimToken: null,
              leaseExpiresAt: null,
              reason: `Classification permanently failed (${diag.code}): ${diag.safeDetail}`,
              updatedAt: new Date().toISOString(),
            })
            .where(eq(companyClassifications.normalizedName, r.normalizedName))
            .run();

          failed++;
        }
      }
    }

    if (i + BATCH_SIZE < pendingRecords.length) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  return {
    processed,
    succeeded,
    promotedToQueue,
    stillPending,
    failed,
    promotedToNextRound,
    rateLimitEncountered,
  };
}

/**
 * Fallback reconciliation when no active batches exist in batches table.
 */
async function reconcileGlobalClassifications(
  db: ReturnType<typeof getDb>,
  nowIso: string,
  geminiCallerOverride?: (prompt: string) => Promise<string>,
  options?: { batchSize?: number }
): Promise<ReconcileResult> {
  let promotedToQueue = 0;

  try {
    const discovery = discoverAndSeedOrphanedCompanies(db, nowIso);
    promotedToQueue += discovery.cascaded;
  } catch (err) {
    console.warn('[ClassificationReconciler] Error during orphan discovery:', err);
  }

  if (globalGeminiLimiter.isCooldownActive() && !isOpenRouterConfigured()) {
    return { processed: 0, succeeded: 0, promotedToQueue, stillPending: 0, failed: 0 };
  }

  let pendingRecords = db
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

  let promotedToNextRound = 0;

  if (pendingRecords.length === 0) {
    promotedToNextRound = promoteGlobalRetryWaitingToNextRound(db, nowIso);
    if (promotedToNextRound > 0) {
      pendingRecords = db
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
    }
  }

  if (pendingRecords.length === 0) {
    return { processed: 0, succeeded: 0, promotedToQueue, stillPending: 0, failed: 0, promotedToNextRound };
  }

  let processed = 0;
  let succeeded = 0;
  let stillPending = 0;
  let failed = 0;

  const BATCH_SIZE = options?.batchSize && options.batchSize > 0 ? options.batchSize : 20;
  for (let i = 0; i < pendingRecords.length; i += BATCH_SIZE) {
    if (globalGeminiLimiter.isCooldownActive() && !isOpenRouterConfigured()) {
      break;
    }

    const chunkRecords = pendingRecords.slice(i, i + BATCH_SIZE);
    const claimToken = `reconcile_global_${ulid()}`;
    const leaseExpiresAt = new Date(Date.now() + 60000).toISOString();

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
        activeClassificationOperations.add(r.normalizedName);
        claimedChunk.push(r);
      }
    }

    if (claimedChunk.length === 0) continue;
    processed += claimedChunk.length;

    const chunkInputs: CompanyEvaluationInput[] = claimedChunk.map((r) => ({
      companyName: r.companyName,
      normalizedName: r.normalizedName,
    }));

    try {
      const results = await classifyWithGeminiBatch(chunkInputs, geminiCallerOverride, { isRetry: true });

      // Persist newly confirmed RELEVANT companies to Relevant Company KB
      const relevantResults = results.filter((r) => r.status === 'RELEVANT');
      if (relevantResults.length > 0) {
        try {
          const canonicalMap = await generateCanonicalCompanyNames(
            relevantResults.map((r) => r.companyName)
          );
          for (const rel of relevantResults) {
            const canonical = canonicalMap.get(formatCompanyDisplayName(rel.companyName)) || rel.companyName;
            const persisted = resolveCanonicalAndPersist(canonical, rel.companyName, db);
            rel.reason += ` (KB Canonical: ${persisted.canonicalName})`;
          }
        } catch (kbErr) {
          console.warn('[ClassificationReconciler] Notice while persisting to RelevantCompanyKB:', kbErr);
        }
      }

      for (const res of results) {
        activeClassificationOperations.delete(res.normalizedName);

        db.update(companyClassifications)
          .set({
            isRelevant: res.relevant,
            confidence: res.confidence,
            reason: res.reason,
            classificationSource: res.source || 'gemini',
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

        const newlyPromoted = cascadeClassificationToContacts(db, res);
        promotedToQueue += newlyPromoted;
        succeeded++;
      }
    } catch (err: unknown) {
      if (isAiProviderUnavailableError(err)) {
        console.warn(
          `[ClassificationReconciler] AI providers temporarily in WAITING state (${Math.ceil(
            err.waitRemainingMs / 1000
          )}s). Keeping ${claimedChunk.length} retry-round companies in current state.`
        );
        for (const r of claimedChunk) {
          db.update(companyClassifications)
            .set({
              claimToken: null,
              leaseExpiresAt: null,
              updatedAt: new Date().toISOString(),
            })
            .where(eq(companyClassifications.normalizedName, r.normalizedName))
            .run();
        }
        break;
      }

      const diag = categorizeGeminiError(err);
      for (const r of claimedChunk) {
        activeClassificationOperations.delete(r.normalizedName);
      }

      const isFromOpenRouter = isOpenRouterError(err);
      const isRateLimit =
        diag.code === 'RATE_LIMIT_EXCEEDED' ||
        /\b429\b/.test(diag.safeDetail) ||
        /RESOURCE_EXHAUSTED/i.test(diag.safeDetail) ||
        Boolean((err as { isRateLimit?: boolean })?.isRateLimit);

      if (isRateLimit) {
        if (!isFromOpenRouter) {
          globalGeminiLimiter.recordError(err);
        }
        for (const r of claimedChunk) {
          const newRetryCount = r.retryCount + 1;
          if (newRetryCount >= MAX_CLASSIFICATION_ROUNDS) {
            db.update(companyClassifications)
              .set({
                classificationResult: 'FAILED',
                retryCount: newRetryCount,
                lastErrorCategory: diag.code,
                nextRetryAt: null,
                claimToken: null,
                leaseExpiresAt: null,
                reason: `Classification failed: maximum retry rounds (${MAX_CLASSIFICATION_ROUNDS}) exceeded.`,
                updatedAt: new Date().toISOString(),
              })
              .where(eq(companyClassifications.normalizedName, r.normalizedName))
              .run();
            failed++;
          } else {
            db.update(companyClassifications)
              .set({
                classificationResult: 'RETRY_WAITING',
                retryCount: newRetryCount,
                lastErrorCategory: diag.code,
                nextRetryAt: null,
                claimToken: null,
                leaseExpiresAt: null,
                reason: 'Classification Retry Waiting — Rate limit encountered.',
                updatedAt: new Date().toISOString(),
              })
              .where(eq(companyClassifications.normalizedName, r.normalizedName))
              .run();
            stillPending++;
          }
        }
        break;
      } else if (diag.isTransient) {
        for (const r of claimedChunk) {
          const newRetryCount = r.retryCount + 1;
          if (newRetryCount >= MAX_CLASSIFICATION_ROUNDS) {
            db.update(companyClassifications)
              .set({
                classificationResult: 'FAILED',
                retryCount: newRetryCount,
                lastErrorCategory: diag.code,
                nextRetryAt: null,
                claimToken: null,
                leaseExpiresAt: null,
                reason: `Classification failed: maximum retry rounds (${MAX_CLASSIFICATION_ROUNDS}) exceeded.`,
                updatedAt: new Date().toISOString(),
              })
              .where(eq(companyClassifications.normalizedName, r.normalizedName))
              .run();
            failed++;
          } else {
            db.update(companyClassifications)
              .set({
                classificationResult: 'RETRY_WAITING',
                retryCount: newRetryCount,
                lastErrorCategory: diag.code,
                nextRetryAt: null,
                claimToken: null,
                leaseExpiresAt: null,
                reason: `Classification Retry Waiting — Transient error (${diag.code}).`,
                updatedAt: new Date().toISOString(),
              })
              .where(eq(companyClassifications.normalizedName, r.normalizedName))
              .run();
            stillPending++;
          }
        }
      } else {
        for (const r of claimedChunk) {
          db.update(companyClassifications)
            .set({
              classificationResult: 'FAILED',
              lastErrorCategory: diag.code,
              nextRetryAt: null,
              claimToken: null,
              leaseExpiresAt: null,
              reason: `Classification permanently failed (${diag.code}): ${diag.safeDetail}`,
              updatedAt: new Date().toISOString(),
            })
            .where(eq(companyClassifications.normalizedName, r.normalizedName))
            .run();
          failed++;
        }
      }
    }
  }

  return { processed, succeeded, promotedToQueue, stillPending, failed, promotedToNextRound };
}

/**
 * Periodically processes company classifications that are PENDING and due for retry.
 * Supports batch-scoped execution or iterating across all active batches.
 * Survives application and container restarts by reading and persisting state in SQLite.
 */
export async function reconcilePendingClassifications(
  geminiCallerOverride?: (prompt: string) => Promise<string>,
  options?: { batchId?: string; batchSize?: number }
): Promise<ReconcileResult> {
  const db = getDb();
  const now = new Date();
  const nowIso = now.toISOString();

  // 0. Stale Lease Recovery: Reclaim any abandoned claims where lease expired
  try {
    db.run(sql`
      UPDATE company_classifications
      SET claim_token = NULL,
          lease_expires_at = NULL,
          updated_at = ${nowIso}
      WHERE claim_token IS NOT NULL
        AND lease_expires_at < ${nowIso}
    `);
  } catch (err) {
    console.warn('[ClassificationReconciler] Error recovering stale leases:', err);
  }

  // If a specific batch is requested, execute strictly for that batch
  if (options?.batchId) {
    const res = await reconcileSingleBatch(db, options.batchId, nowIso, geminiCallerOverride, options);
    reconcileActiveBatchCounters(db);
    return res;
  }

  // Otherwise, find all active batches and process each with batch isolation
  const activeBatches = db
    .select({ id: batches.id })
    .from(batches)
    .where(sql`batches.status NOT IN ('deleted', 'cancelled')`)
    .orderBy(batches.createdAt)
    .all();

  if (activeBatches.length > 0) {
    let totalProcessed = 0;
    let totalSucceeded = 0;
    let totalPromotedToQueue = 0;
    let totalStillPending = 0;
    let totalFailed = 0;
    let totalPromotedToNextRound = 0;

    let rateLimitHit = false;
    for (const b of activeBatches) {
      const res = await reconcileSingleBatch(db, b.id, nowIso, geminiCallerOverride, options);
      totalProcessed += res.processed;
      totalSucceeded += res.succeeded;
      totalPromotedToQueue += res.promotedToQueue;
      totalStillPending += res.stillPending;
      totalFailed += res.failed;
      totalPromotedToNextRound += (res.promotedToNextRound ?? 0);
      if (res.rateLimitEncountered) {
        rateLimitHit = true;
        break;
      }
    }

    // Check if there are unassigned or test-seeded PENDING records not tied to active batch contacts
    if (!rateLimitHit && !(globalGeminiLimiter.isCooldownActive() && !isOpenRouterConfigured())) {
      const activeBatchCompanyNames = new Set<string>();
      for (const b of activeBatches) {
        const names = getUnclassifiedCompanyNamesForBatch(db, b.id);
        for (const n of names) activeBatchCompanyNames.add(n);
      }

      const remainingPending = db
        .select({ normalizedName: companyClassifications.normalizedName })
        .from(companyClassifications)
        .where(
          and(
            eq(companyClassifications.classificationResult, 'PENDING'),
            sql`(${companyClassifications.nextRetryAt} IS NULL OR ${companyClassifications.nextRetryAt} <= ${nowIso})`,
            sql`(${companyClassifications.claimToken} IS NULL OR ${companyClassifications.leaseExpiresAt} < ${nowIso})`
          )
        )
        .all()
        .filter((r) => !activeBatchCompanyNames.has(r.normalizedName));

      if (remainingPending.length > 0) {
        const remainingRes = await reconcileGlobalClassifications(db, nowIso, geminiCallerOverride, options);
        totalProcessed += remainingRes.processed;
        totalSucceeded += remainingRes.succeeded;
        totalPromotedToQueue += remainingRes.promotedToQueue;
        totalStillPending += remainingRes.stillPending;
        totalFailed += remainingRes.failed;
        totalPromotedToNextRound += (remainingRes.promotedToNextRound ?? 0);
      }
    }

    reconcileActiveBatchCounters(db);

    return {
      processed: totalProcessed,
      succeeded: totalSucceeded,
      promotedToQueue: totalPromotedToQueue,
      stillPending: totalStillPending,
      failed: totalFailed,
      promotedToNextRound: totalPromotedToNextRound,
    };
  }

  // Fallback if no active batches in batches table (e.g. isolated mock unit test)
  const globalRes = await reconcileGlobalClassifications(db, nowIso, geminiCallerOverride, options);
  reconcileActiveBatchCounters(db);
  return globalRes;
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

  // Find candidate contacts in active batches where company name is present
  const candidateContacts = db
    .select({
      id: contacts.id,
      batchId: contacts.batchId,
      companyName: contacts.companyName,
      emailValid: contacts.emailValid,
      isDuplicate: contacts.isDuplicate,
      status: contacts.status,
    })
    .from(contacts)
    .innerJoin(batches, eq(contacts.batchId, batches.id))
    .where(
      and(
        sql`contacts.company_name IS NOT NULL AND TRIM(contacts.company_name) != ''`,
        sql`batches.status NOT IN ('deleted', 'cancelled')`
      )
    )
    .all();

  const matchingContacts = candidateContacts.filter((c) => {
    if (!c.companyName) return false;
    const norm = normalizeCompanyName(c.companyName);
    const rawLower = c.companyName.trim().toLowerCase();
    return norm === result.normalizedName || rawLower === result.normalizedName;
  });

  for (const c of matchingContacts) {
    if (result.status === 'RELEVANT') {
      const isEligible = c.emailValid && !c.isDuplicate;

      if (isEligible) {
        const targetStatus =
          c.status === 'sent' || c.status === 'processing' || c.status === 'generating' || c.status === 'generated'
            ? c.status
            : 'queued';

        // Promote eligible contact to queued and schedule for generation if not already generated
        db.update(contacts)
          .set({
            isRelevant: true,
            relevanceConfidence: result.confidence,
            relevanceReason: result.reason,
            status: targetStatus,
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

        if (!existingQueue && targetStatus !== 'sent') {
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
