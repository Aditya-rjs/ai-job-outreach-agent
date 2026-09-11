import { getDb } from '@/db';
import { sql } from 'drizzle-orm';
import { getCooldownCutoffIso } from '@/lib/scheduler/time-utils';
import { normalizeCompanyName } from '@/lib/utils/company';

export interface ProcessingPipelineStats {
  // 13 Canonical Dashboard Metrics in exact required order
  companiesFound: number;
  duplicateCompanies: number;
  aiSearchPending: number;
  aiSearchRetry: number;
  aiProcessed: number;
  irrelevantCompanies: number;
  csItRelevant: number;
  contactsFound: number;
  duplicateContacts: number;
  emailsGenerating: number;
  generationRetry: number;
  generationFailed: number;
  readyToSend: number;

  // Backward-compatibility aliases
  classificationPendingCount: number;
  classificationRetryWaitingCount: number;
  emailGenerationPendingCount: number;
  generationRetryCount: number;
  generationFailedCount: number;
  readyToSendCount: number;

  lastUpdated: string;
  currentBatchId: string | null;
  currentBatchFilename: string | null;
}

export interface ClassificationPendingRecord {
  companyName: string;
  normalizedName: string;
  contactCount: number;
  contactEmails: string[];
  representativeContacts: string[]; // e.g. ["Garima Mohan — gmohan@xebia.com"]
  classificationResult: string;
  retryRound: number;
  retryCount: number;
  lastErrorCategory: string | null;
  nextRetryAt: string | null;
  geminiModel: string;
  confidence: number | null;
  reason: string | null;
  createdAt: string;
  isWaitingForNextRound?: boolean;
}

export interface CompanyContactItem {
  id: string;
  contactName: string | null;
  email: string;
  designation: string | null;
  companyName: string | null;
  batchFilename: string;
}

export interface GenerationPendingRecord {
  id: string;
  contactName: string | null;
  companyName: string | null;
  email: string;
  generationStatus: 'PENDING_GENERATION' | 'GENERATING';
  generationAttemptCount: number;
  nextGenerationRetryAt: string | null;
  batchFilename: string;
  createdAt: string;
}

export interface GenerationRetryRecord {
  id: string;
  contactName: string | null;
  companyName: string | null;
  email: string;
  generationStatus: 'RETRY_PENDING';
  generationAttemptCount: number;
  lastGenerationErrorCategory: string | null;
  nextGenerationRetryAt: string | null;
  batchFilename: string;
  createdAt: string;
}

export interface GenerationFailedRecord {
  id: string;
  contactName: string | null;
  companyName: string | null;
  email: string;
  classificationResult: string;
  classificationSource: string;
  geminiModel: string | null;
  generationStatus: 'GENERATION_FAILED';
  generationProvider: string;
  generationAttemptCount: number;
  lastGenerationErrorCategory: string | null;
  errorMessage: string | null;
  failureTimestamp: string | null;
  isRetryable: boolean;
  status: string;
  batchFilename: string;
  createdAt: string;
}

export interface ReadyToSendRecord {
  id: string;
  contactName: string | null;
  companyName: string | null;
  email: string;
  emailSubject: string;
  emailBody: string;
  emailStrategy: string | null;
  generatedAt: string | null;
  queueStatus: string;
  queuePriority: number;
  batchFilename: string;
  status: string;
}

export interface ProcessingPaginationOptions {
  batchId?: string;
  search?: string;
  page?: number;
  limit?: number;
}

/**
 * Retrieves the latest active uploaded batch.
 */
export function getLatestActiveBatch(db: ReturnType<typeof getDb> = getDb()): {
  id: string;
  filename: string;
} | null {
  const row = db.get<{ id: string; filename: string }>(sql`
    SELECT id, filename
    FROM batches
    WHERE status NOT IN ('deleted', 'cancelled')
    ORDER BY created_at DESC
    LIMIT 1
  `);
  return row || null;
}

// ---------------------------------------------------------------------------
// 1. CANONICAL STATS FOR AI OUTREACH PROCESSING (13 Metrics, Batch-Scoped)
// ---------------------------------------------------------------------------

export function getProcessingPipelineStats(batchId?: string): ProcessingPipelineStats {
  const db = getDb();
  const nowIso = new Date().toISOString();

  // Resolve current / latest batch
  const activeBatch = batchId
    ? db.get<{ id: string; filename: string }>(sql`SELECT id, filename FROM batches WHERE id = ${batchId} AND status NOT IN ('deleted', 'cancelled')`)
    : getLatestActiveBatch(db);

  // Zero State: If no active uploaded file/batch exists, return strictly 0 for all metrics
  if (!activeBatch) {
    return {
      companiesFound: 0,
      duplicateCompanies: 0,
      aiSearchPending: 0,
      aiSearchRetry: 0,
      aiProcessed: 0,
      irrelevantCompanies: 0,
      csItRelevant: 0,
      contactsFound: 0,
      duplicateContacts: 0,
      emailsGenerating: 0,
      generationRetry: 0,
      generationFailed: 0,
      readyToSend: 0,
      classificationPendingCount: 0,
      classificationRetryWaitingCount: 0,
      emailGenerationPendingCount: 0,
      generationRetryCount: 0,
      generationFailedCount: 0,
      readyToSendCount: 0,
      lastUpdated: nowIso,
      currentBatchId: null,
      currentBatchFilename: null,
    };
  }

  const currentBatchId = activeBatch.id;
  const currentBatchFilename = activeBatch.filename;

  // 1. Companies Found & 2. Duplicate Companies
  // Group distinct raw company names and normalize them using the application's company normalizer.
  // Multiple contacts belonging to the same company are NOT counted as duplicate companies.
  const companyRows = db.all<{ rawCompany: string }>(sql`
    SELECT DISTINCT TRIM(company_name) as rawCompany
    FROM contacts
    WHERE batch_id = ${currentBatchId}
      AND company_name IS NOT NULL
      AND TRIM(company_name) != ''
  `);

  const rawDistinctCount = companyRows.length;
  const normalizedSet = new Set<string>();
  for (const r of companyRows) {
    const norm = normalizeCompanyName(r.rawCompany);
    if (norm) normalizedSet.add(norm);
  }
  const uniqueNormalizedCount = normalizedSet.size;
  const companiesFound = rawDistinctCount;
  const duplicateCompanies = Math.max(0, rawDistinctCount - uniqueNormalizedCount);

  // 3. AI Search Pending: Unique companies in the current batch still awaiting initial/next-round AI classification
  const classPendingRow = db.get<{ count: number }>(sql`
    SELECT COUNT(DISTINCT LOWER(TRIM(c.company_name))) as count
    FROM contacts c
    LEFT JOIN company_classifications cc ON (
      cc.normalized_name = LOWER(TRIM(c.company_name))
      OR cc.company_name = c.company_name
      OR cc.company_name = TRIM(c.company_name)
    )
    WHERE c.batch_id = ${currentBatchId}
      AND c.company_name IS NOT NULL
      AND TRIM(c.company_name) != ''
      AND (
        cc.classification_result = 'PENDING'
        OR (cc.classification_result IS NULL AND c.is_relevant IS NULL)
      )
  `);
  const aiSearchPending = classPendingRow?.count ?? 0;

  // 4. AI Search Retry: Unique companies in the current batch currently RETRY_WAITING
  const classRetryWaitingRow = db.get<{ count: number }>(sql`
    SELECT COUNT(DISTINCT LOWER(TRIM(c.company_name))) as count
    FROM contacts c
    INNER JOIN company_classifications cc ON (
      cc.normalized_name = LOWER(TRIM(c.company_name))
      OR cc.company_name = c.company_name
      OR cc.company_name = TRIM(c.company_name)
    )
    WHERE c.batch_id = ${currentBatchId}
      AND c.company_name IS NOT NULL
      AND TRIM(c.company_name) != ''
      AND cc.classification_result = 'RETRY_WAITING'
  `);
  const aiSearchRetry = classRetryWaitingRow?.count ?? 0;

  // 5. AI Processed: Unique companies in the current batch with terminal classification
  const classProcessedRow = db.get<{ count: number }>(sql`
    SELECT COUNT(DISTINCT LOWER(TRIM(c.company_name))) as count
    FROM contacts c
    LEFT JOIN company_classifications cc ON (
      cc.normalized_name = LOWER(TRIM(c.company_name))
      OR cc.company_name = c.company_name
      OR cc.company_name = TRIM(c.company_name)
    )
    WHERE c.batch_id = ${currentBatchId}
      AND c.company_name IS NOT NULL
      AND TRIM(c.company_name) != ''
      AND (
        cc.classification_result IN ('RELEVANT', 'IRRELEVANT', 'NEEDS_REVIEW', 'FAILED')
        OR (cc.classification_result IS NULL AND c.is_relevant IS NOT NULL)
      )
  `);
  const aiProcessed = classProcessedRow?.count ?? 0;

  // 6. Irrelevant Companies: Unique companies classified as IRRELEVANT
  const irrelevantRow = db.get<{ count: number }>(sql`
    SELECT COUNT(DISTINCT LOWER(TRIM(c.company_name))) as count
    FROM contacts c
    LEFT JOIN company_classifications cc ON (
      cc.normalized_name = LOWER(TRIM(c.company_name))
      OR cc.company_name = c.company_name
      OR cc.company_name = TRIM(c.company_name)
    )
    WHERE c.batch_id = ${currentBatchId}
      AND c.company_name IS NOT NULL
      AND TRIM(c.company_name) != ''
      AND (
        cc.classification_result = 'IRRELEVANT'
        OR (cc.classification_result IS NULL AND c.is_relevant = 0)
      )
  `);
  const irrelevantCompanies = irrelevantRow?.count ?? 0;

  // 7. CS/IT Relevant: Unique companies classified as RELEVANT
  const relevantRow = db.get<{ count: number }>(sql`
    SELECT COUNT(DISTINCT LOWER(TRIM(c.company_name))) as count
    FROM contacts c
    LEFT JOIN company_classifications cc ON (
      cc.normalized_name = LOWER(TRIM(c.company_name))
      OR cc.company_name = c.company_name
      OR cc.company_name = TRIM(c.company_name)
    )
    WHERE c.batch_id = ${currentBatchId}
      AND c.company_name IS NOT NULL
      AND TRIM(c.company_name) != ''
      AND (
        cc.classification_result = 'RELEVANT'
        OR (cc.classification_result IS NULL AND c.is_relevant = 1)
      )
  `);
  const csItRelevant = relevantRow?.count ?? 0;

  // 8. Contacts Found: All contacts imported from the current file
  const contactsFoundRow = db.get<{ count: number }>(sql`
    SELECT COUNT(c.id) as count
    FROM contacts c
    WHERE c.batch_id = ${currentBatchId}
  `);
  const contactsFound = contactsFoundRow?.count ?? 0;

  // 9. Duplicate Contacts: Contacts in the current batch marked is_duplicate = 1
  const dupContactsRow = db.get<{ count: number }>(sql`
    SELECT COUNT(c.id) as count
    FROM contacts c
    WHERE c.batch_id = ${currentBatchId}
      AND c.is_duplicate = 1
  `);
  const duplicateContacts = dupContactsRow?.count ?? 0;

  // 10. Emails Generating: Contacts undergoing or waiting for generation.
  // HARD BARRIER RULE: While classification is running (pending > 0 or retry > 0), this MUST REMAIN 0!
  const genPendingRow = db.get<{ count: number }>(sql`
    SELECT COUNT(c.id) as count
    FROM contacts c
    WHERE c.batch_id = ${currentBatchId}
      AND c.is_relevant = 1
      AND c.email_valid = 1
      AND c.is_duplicate = 0
      AND c.sent_at IS NULL
      AND (
        c.generation_status IN ('PENDING_GENERATION', 'GENERATING')
        OR (
          c.generation_status IS NULL
          AND c.status IN ('queued', 'generating', 'discovered')
          AND (c.email_subject IS NULL OR c.email_body IS NULL OR TRIM(c.email_subject) = '' OR TRIM(c.email_body) = '')
        )
      )
  `);
  const rawGenPendingCount = genPendingRow?.count ?? 0;
  const emailsGenerating = (aiSearchPending === 0 && aiSearchRetry === 0) ? rawGenPendingCount : 0;

  // 11. Generation Retry: Contacts currently waiting in generation retry mechanism
  const genRetryRow = db.get<{ count: number }>(sql`
    SELECT COUNT(c.id) as count
    FROM contacts c
    WHERE c.batch_id = ${currentBatchId}
      AND c.is_relevant = 1
      AND c.email_valid = 1
      AND c.is_duplicate = 0
      AND c.sent_at IS NULL
      AND c.generation_status = 'RETRY_PENDING'
  `);
  const generationRetry = genRetryRow?.count ?? 0;

  // 12. Generation Failed: Contacts with terminal generation failure state
  const genFailedRow = db.get<{ count: number }>(sql`
    SELECT COUNT(c.id) as count
    FROM contacts c
    WHERE c.batch_id = ${currentBatchId}
      AND c.generation_status = 'GENERATION_FAILED'
  `);
  const generationFailed = genFailedRow?.count ?? 0;

  // 13. Ready to Send: Contacts with generated email content staged in outreach queue
  const cooldownCutoffIso = getCooldownCutoffIso();
  const readyToSendRow = db.get<{ count: number }>(sql`
    SELECT COUNT(DISTINCT c.id) as count
    FROM contacts c
    INNER JOIN outreach_queue oq ON oq.contact_id = c.id
    WHERE c.batch_id = ${currentBatchId}
      AND (
        oq.status = 'pending'
        OR (
          oq.status = 'failed'
          AND oq.attempts < 3
          AND oq.next_retry_at IS NOT NULL
          AND oq.next_retry_at <= ${nowIso}
        )
      )
      AND c.email_valid = 1
      AND c.is_duplicate = 0
      AND c.is_relevant = 1
      AND c.sent_at IS NULL
      AND c.email_subject IS NOT NULL
      AND c.email_body IS NOT NULL
      AND TRIM(c.email_subject) != ''
      AND TRIM(c.email_body) != ''
      AND NOT EXISTS (
        SELECT 1 FROM global_email_history geh
        WHERE LOWER(TRIM(geh.email)) = LOWER(TRIM(c.email))
          AND geh.sent_at IS NOT NULL
          AND geh.sent_at > ${cooldownCutoffIso}
      )
  `);
  const readyToSend = readyToSendRow?.count ?? 0;

  return {
    companiesFound,
    duplicateCompanies,
    aiSearchPending,
    aiSearchRetry,
    aiProcessed,
    irrelevantCompanies,
    csItRelevant,
    contactsFound,
    duplicateContacts,
    emailsGenerating,
    generationRetry,
    generationFailed,
    readyToSend,

    // Backward compatibility aliases
    classificationPendingCount: aiSearchPending,
    classificationRetryWaitingCount: aiSearchRetry,
    emailGenerationPendingCount: rawGenPendingCount,
    generationRetryCount: generationRetry,
    generationFailedCount: generationFailed,
    readyToSendCount: readyToSend,

    lastUpdated: nowIso,
    currentBatchId,
    currentBatchFilename,
  };
}

// ---------------------------------------------------------------------------
// 2. CLASSIFICATION PENDING (Active PENDING in current round)
// ---------------------------------------------------------------------------

export function getClassificationPendingList(opts: ProcessingPaginationOptions = {}): {
  records: ClassificationPendingRecord[];
  total: number;
} {
  const db = getDb();
  const search = (opts.search || '').trim().toLowerCase();
  const page = Math.max(1, opts.page || 1);
  const limit = Math.max(1, Math.min(opts.limit || 25, 200));
  const offset = (page - 1) * limit;

  const searchClause = search
    ? sql`AND (LOWER(TRIM(c.company_name)) LIKE ${`%${search}%`} OR LOWER(c.contact_name) LIKE ${`%${search}%`} OR LOWER(c.email) LIKE ${`%${search}%`})`
    : sql``;
  const batchClause = opts.batchId ? sql`AND c.batch_id = ${opts.batchId}` : sql``;

  const countRow = db.get<{ count: number }>(sql`
    SELECT COUNT(DISTINCT LOWER(TRIM(c.company_name))) as count
    FROM contacts c
    INNER JOIN batches b ON c.batch_id = b.id
    LEFT JOIN company_classifications cc ON (cc.normalized_name = LOWER(TRIM(c.company_name)) OR cc.company_name = c.company_name OR cc.company_name = TRIM(c.company_name))
    WHERE b.status NOT IN ('deleted', 'cancelled')
      AND c.company_name IS NOT NULL
      AND TRIM(c.company_name) != ''
      AND (cc.classification_result = 'PENDING' OR (cc.classification_result IS NULL AND c.is_relevant IS NULL))
      ${batchClause}
      ${searchClause}
  `);
  const total = countRow?.count ?? 0;

  const rows = db.all<{
    companyName: string;
    normalizedName: string;
    contactCount: number;
    contactEmailsStr: string | null;
    contactPairsStr: string | null;
    classificationResult: string;
    retryRound: number;
    retryCount: number;
    lastErrorCategory: string | null;
    nextRetryAt: string | null;
    geminiModel: string;
    confidence: number | null;
    reason: string | null;
    createdAt: string;
  }>(sql`
    SELECT
      COALESCE(cc.company_name, TRIM(c.company_name)) as companyName,
      LOWER(TRIM(c.company_name)) as normalizedName,
      COUNT(DISTINCT c.id) as contactCount,
      GROUP_CONCAT(DISTINCT c.email) as contactEmailsStr,
      GROUP_CONCAT(DISTINCT CASE WHEN c.contact_name IS NOT NULL AND TRIM(c.contact_name) != '' THEN c.contact_name || ' — ' || c.email ELSE c.email END) as contactPairsStr,
      COALESCE(cc.classification_result, 'PENDING') as classificationResult,
      COALESCE(cc.retry_round, 0) as retryRound,
      COALESCE(cc.retry_count, 0) as retryCount,
      cc.last_error_category as lastErrorCategory,
      cc.next_retry_at as nextRetryAt,
      COALESCE(cc.gemini_model, 'gemini-3.8-flash') as geminiModel,
      cc.confidence,
      cc.reason,
      COALESCE(cc.created_at, MIN(c.created_at)) as createdAt
    FROM contacts c
    INNER JOIN batches b ON c.batch_id = b.id
    LEFT JOIN company_classifications cc ON (cc.normalized_name = LOWER(TRIM(c.company_name)) OR cc.company_name = c.company_name OR cc.company_name = TRIM(c.company_name))
    WHERE b.status NOT IN ('deleted', 'cancelled')
      AND c.company_name IS NOT NULL
      AND TRIM(c.company_name) != ''
      AND (cc.classification_result = 'PENDING' OR (cc.classification_result IS NULL AND c.is_relevant IS NULL))
      ${batchClause}
      ${searchClause}
    GROUP BY LOWER(TRIM(c.company_name))
    ORDER BY cc.retry_count DESC, contactCount DESC, companyName ASC
    LIMIT ${limit} OFFSET ${offset}
  `);

  const records: ClassificationPendingRecord[] = rows.map((r) => {
    const contactEmails = r.contactEmailsStr ? r.contactEmailsStr.split(',').filter(Boolean) : [];
    const representativeContacts = r.contactPairsStr ? r.contactPairsStr.split(',').filter(Boolean) : [];

    return {
      companyName: r.companyName,
      normalizedName: r.normalizedName,
      contactCount: r.contactCount,
      contactEmails,
      representativeContacts,
      classificationResult: r.classificationResult,
      retryRound: r.retryRound,
      retryCount: r.retryCount,
      lastErrorCategory: r.lastErrorCategory,
      nextRetryAt: r.nextRetryAt,
      geminiModel: r.geminiModel,
      confidence: r.confidence,
      reason: r.reason,
      createdAt: r.createdAt,
      isWaitingForNextRound: false,
    };
  });

  return { records, total };
}

// ---------------------------------------------------------------------------
// 2b. CLASSIFICATION RETRY WAITING (Waiting for current round to drain)
// ---------------------------------------------------------------------------

export function getClassificationRetryWaitingList(opts: ProcessingPaginationOptions = {}): {
  records: ClassificationPendingRecord[];
  total: number;
} {
  const db = getDb();
  const search = (opts.search || '').trim().toLowerCase();
  const page = Math.max(1, opts.page || 1);
  const limit = Math.max(1, Math.min(opts.limit || 25, 200));
  const offset = (page - 1) * limit;

  const searchClause = search
    ? sql`AND (LOWER(TRIM(c.company_name)) LIKE ${`%${search}%`} OR LOWER(c.contact_name) LIKE ${`%${search}%`} OR LOWER(c.email) LIKE ${`%${search}%`})`
    : sql``;
  const batchClause = opts.batchId ? sql`AND c.batch_id = ${opts.batchId}` : sql``;

  const countRow = db.get<{ count: number }>(sql`
    SELECT COUNT(DISTINCT LOWER(TRIM(c.company_name))) as count
    FROM contacts c
    INNER JOIN batches b ON c.batch_id = b.id
    INNER JOIN company_classifications cc ON (cc.normalized_name = LOWER(TRIM(c.company_name)) OR cc.company_name = c.company_name OR cc.company_name = TRIM(c.company_name))
    WHERE b.status NOT IN ('deleted', 'cancelled')
      AND c.company_name IS NOT NULL
      AND TRIM(c.company_name) != ''
      AND cc.classification_result = 'RETRY_WAITING'
      ${batchClause}
      ${searchClause}
  `);
  const total = countRow?.count ?? 0;

  const rows = db.all<{
    companyName: string;
    normalizedName: string;
    contactCount: number;
    contactEmailsStr: string | null;
    contactPairsStr: string | null;
    classificationResult: string;
    retryRound: number;
    retryCount: number;
    lastErrorCategory: string | null;
    nextRetryAt: string | null;
    geminiModel: string;
    confidence: number | null;
    reason: string | null;
    createdAt: string;
  }>(sql`
    SELECT
      COALESCE(cc.company_name, TRIM(c.company_name)) as companyName,
      LOWER(TRIM(c.company_name)) as normalizedName,
      COUNT(DISTINCT c.id) as contactCount,
      GROUP_CONCAT(DISTINCT c.email) as contactEmailsStr,
      GROUP_CONCAT(DISTINCT CASE WHEN c.contact_name IS NOT NULL AND TRIM(c.contact_name) != '' THEN c.contact_name || ' — ' || c.email ELSE c.email END) as contactPairsStr,
      cc.classification_result as classificationResult,
      COALESCE(cc.retry_round, 0) as retryRound,
      COALESCE(cc.retry_count, 0) as retryCount,
      cc.last_error_category as lastErrorCategory,
      cc.next_retry_at as nextRetryAt,
      COALESCE(cc.gemini_model, 'gemini-3.8-flash') as geminiModel,
      cc.confidence,
      cc.reason,
      COALESCE(cc.created_at, MIN(c.created_at)) as createdAt
    FROM contacts c
    INNER JOIN batches b ON c.batch_id = b.id
    INNER JOIN company_classifications cc ON (cc.normalized_name = LOWER(TRIM(c.company_name)) OR cc.company_name = c.company_name OR cc.company_name = TRIM(c.company_name))
    WHERE b.status NOT IN ('deleted', 'cancelled')
      AND c.company_name IS NOT NULL
      AND TRIM(c.company_name) != ''
      AND cc.classification_result = 'RETRY_WAITING'
      ${batchClause}
      ${searchClause}
    GROUP BY LOWER(TRIM(c.company_name))
    ORDER BY cc.retry_round ASC, cc.retry_count DESC, contactCount DESC, companyName ASC
    LIMIT ${limit} OFFSET ${offset}
  `);

  const records: ClassificationPendingRecord[] = rows.map((r) => {
    const contactEmails = r.contactEmailsStr ? r.contactEmailsStr.split(',').filter(Boolean) : [];
    const representativeContacts = r.contactPairsStr ? r.contactPairsStr.split(',').filter(Boolean) : [];

    return {
      companyName: r.companyName,
      normalizedName: r.normalizedName,
      contactCount: r.contactCount,
      contactEmails,
      representativeContacts,
      classificationResult: r.classificationResult,
      retryRound: r.retryRound,
      retryCount: r.retryCount,
      lastErrorCategory: r.lastErrorCategory,
      nextRetryAt: r.nextRetryAt,
      geminiModel: r.geminiModel,
      confidence: r.confidence,
      reason: r.reason,
      createdAt: r.createdAt,
      isWaitingForNextRound: true,
    };
  });

  return { records, total };
}

// ---------------------------------------------------------------------------
// 3. EXPANDED CONTACTS FOR A PENDING COMPANY
// ---------------------------------------------------------------------------

export function getCompanyContactsList(normalizedName: string, batchId?: string): CompanyContactItem[] {
  const db = getDb();
  const target = normalizedName.trim().toLowerCase();
  const batchClause = batchId ? sql`AND c.batch_id = ${batchId}` : sql``;

  const rows = db.all<CompanyContactItem>(sql`
    SELECT
      c.id,
      c.contact_name as contactName,
      c.email,
      c.designation,
      c.company_name as companyName,
      b.filename as batchFilename
    FROM contacts c
    INNER JOIN batches b ON c.batch_id = b.id
    WHERE b.status NOT IN ('deleted', 'cancelled')
      AND LOWER(TRIM(c.company_name)) = ${target}
      ${batchClause}
    ORDER BY c.contact_name ASC, c.email ASC
  `);

  return rows;
}

// ---------------------------------------------------------------------------
// 4. EMAIL GENERATION PENDING (Only Gemini-Relevant Contacts)
// ---------------------------------------------------------------------------

export function getEmailGenerationPendingList(opts: ProcessingPaginationOptions = {}): {
  records: GenerationPendingRecord[];
  total: number;
} {
  const db = getDb();

  // If scoped to a batch and its classification is incomplete, generation is blocked: 0 records
  if (opts.batchId) {
    const incompleteRow = db.get<{ count: number }>(sql`
      SELECT COUNT(DISTINCT LOWER(TRIM(c.company_name))) as count
      FROM contacts c
      LEFT JOIN company_classifications cc ON (
        cc.normalized_name = LOWER(TRIM(c.company_name))
        OR cc.company_name = c.company_name
        OR cc.company_name = TRIM(c.company_name)
      )
      WHERE c.batch_id = ${opts.batchId}
        AND c.company_name IS NOT NULL
        AND TRIM(c.company_name) != ''
        AND (
          cc.classification_result IN ('PENDING', 'RETRY_WAITING')
          OR (cc.classification_result IS NULL AND c.is_relevant IS NULL)
        )
    `);
    if ((incompleteRow?.count ?? 0) > 0) {
      return { records: [], total: 0 };
    }
  }

  const search = (opts.search || '').trim().toLowerCase();
  const page = Math.max(1, opts.page || 1);
  const limit = Math.max(1, Math.min(opts.limit || 25, 200));
  const offset = (page - 1) * limit;

  const searchClause = search
    ? sql`AND (LOWER(c.contact_name) LIKE ${`%${search}%`} OR LOWER(c.email) LIKE ${`%${search}%`} OR LOWER(c.company_name) LIKE ${`%${search}%`})`
    : sql``;
  const batchClause = opts.batchId ? sql`AND c.batch_id = ${opts.batchId}` : sql``;

  const countRow = db.get<{ count: number }>(sql`
    SELECT COUNT(c.id) as count
    FROM contacts c
    INNER JOIN batches b ON c.batch_id = b.id
    WHERE b.status NOT IN ('deleted', 'cancelled')
      AND c.is_relevant = 1
      AND c.email_valid = 1
      AND c.is_duplicate = 0
      AND c.sent_at IS NULL
      AND (
        c.generation_status IN ('PENDING_GENERATION', 'GENERATING')
        OR (
          c.generation_status IS NULL
          AND c.status IN ('queued', 'generating', 'discovered')
          AND (c.email_subject IS NULL OR c.email_body IS NULL OR TRIM(c.email_subject) = '' OR TRIM(c.email_body) = '')
        )
      )
      ${batchClause}
      ${searchClause}
  `);
  const total = countRow?.count ?? 0;

  const rows = db.all<{
    id: string;
    contactName: string | null;
    companyName: string | null;
    email: string;
    generationStatus: string | null;
    generationAttemptCount: number;
    nextGenerationRetryAt: string | null;
    batchFilename: string;
    createdAt: string;
  }>(sql`
    SELECT
      c.id,
      c.contact_name as contactName,
      c.company_name as companyName,
      c.email,
      COALESCE(c.generation_status, 'PENDING_GENERATION') as generationStatus,
      COALESCE(c.generation_attempt_count, 0) as generationAttemptCount,
      c.next_generation_retry_at as nextGenerationRetryAt,
      b.filename as batchFilename,
      c.created_at as createdAt
    FROM contacts c
    INNER JOIN batches b ON c.batch_id = b.id
    WHERE b.status NOT IN ('deleted', 'cancelled')
      AND c.is_relevant = 1
      AND c.email_valid = 1
      AND c.is_duplicate = 0
      AND c.sent_at IS NULL
      AND (
        c.generation_status IN ('PENDING_GENERATION', 'GENERATING')
        OR (
          c.generation_status IS NULL
          AND c.status IN ('queued', 'generating', 'discovered')
          AND (c.email_subject IS NULL OR c.email_body IS NULL OR TRIM(c.email_subject) = '' OR TRIM(c.email_body) = '')
        )
      )
      ${batchClause}
      ${searchClause}
    ORDER BY c.created_at ASC, c.id ASC
    LIMIT ${limit} OFFSET ${offset}
  `);

  const records: GenerationPendingRecord[] = rows.map((r) => ({
    id: r.id,
    contactName: r.contactName,
    companyName: r.companyName,
    email: r.email,
    generationStatus: r.generationStatus === 'GENERATING' ? 'GENERATING' : 'PENDING_GENERATION',
    generationAttemptCount: r.generationAttemptCount,
    nextGenerationRetryAt: r.nextGenerationRetryAt,
    batchFilename: r.batchFilename,
    createdAt: r.createdAt,
  }));

  return { records, total };
}

// ---------------------------------------------------------------------------
// 5. GENERATION RETRY (Transient Errors Waiting for Auto-Retry)
// ---------------------------------------------------------------------------

export function getGenerationRetryList(opts: ProcessingPaginationOptions = {}): {
  records: GenerationRetryRecord[];
  total: number;
} {
  const db = getDb();
  const search = (opts.search || '').trim().toLowerCase();
  const page = Math.max(1, opts.page || 1);
  const limit = Math.max(1, Math.min(opts.limit || 25, 200));
  const offset = (page - 1) * limit;

  const searchClause = search
    ? sql`AND (LOWER(c.contact_name) LIKE ${`%${search}%`} OR LOWER(c.email) LIKE ${`%${search}%`} OR LOWER(c.company_name) LIKE ${`%${search}%`})`
    : sql``;
  const batchClause = opts.batchId ? sql`AND c.batch_id = ${opts.batchId}` : sql``;

  const countRow = db.get<{ count: number }>(sql`
    SELECT COUNT(c.id) as count
    FROM contacts c
    INNER JOIN batches b ON c.batch_id = b.id
    WHERE b.status NOT IN ('deleted', 'cancelled')
      AND c.is_relevant = 1
      AND c.email_valid = 1
      AND c.is_duplicate = 0
      AND c.sent_at IS NULL
      AND c.generation_status = 'RETRY_PENDING'
      ${batchClause}
      ${searchClause}
  `);
  const total = countRow?.count ?? 0;

  const rows = db.all<{
    id: string;
    contactName: string | null;
    companyName: string | null;
    email: string;
    generationStatus: string;
    generationAttemptCount: number;
    lastGenerationErrorCategory: string | null;
    nextGenerationRetryAt: string | null;
    batchFilename: string;
    createdAt: string;
  }>(sql`
    SELECT
      c.id,
      c.contact_name as contactName,
      c.company_name as companyName,
      c.email,
      c.generation_status as generationStatus,
      COALESCE(c.generation_attempt_count, 0) as generationAttemptCount,
      c.last_generation_error_category as lastGenerationErrorCategory,
      c.next_generation_retry_at as nextGenerationRetryAt,
      b.filename as batchFilename,
      c.created_at as createdAt
    FROM contacts c
    INNER JOIN batches b ON c.batch_id = b.id
    WHERE b.status NOT IN ('deleted', 'cancelled')
      AND c.is_relevant = 1
      AND c.email_valid = 1
      AND c.is_duplicate = 0
      AND c.sent_at IS NULL
      AND c.generation_status = 'RETRY_PENDING'
      ${batchClause}
      ${searchClause}
    ORDER BY c.next_generation_retry_at ASC, c.generation_attempt_count DESC, c.id ASC
    LIMIT ${limit} OFFSET ${offset}
  `);

  const records: GenerationRetryRecord[] = rows.map((r) => ({
    id: r.id,
    contactName: r.contactName,
    companyName: r.companyName,
    email: r.email,
    generationStatus: 'RETRY_PENDING',
    generationAttemptCount: r.generationAttemptCount,
    lastGenerationErrorCategory: r.lastGenerationErrorCategory,
    nextGenerationRetryAt: r.nextGenerationRetryAt,
    batchFilename: r.batchFilename,
    createdAt: r.createdAt,
  }));

  return { records, total };
}

// ---------------------------------------------------------------------------
// 5b. GENERATION FAILED (Terminal Failures Requiring Inspection)
// ---------------------------------------------------------------------------

export function getGenerationFailedList(opts: ProcessingPaginationOptions = {}): {
  records: GenerationFailedRecord[];
  total: number;
} {
  const db = getDb();
  const search = (opts.search || '').trim().toLowerCase();
  const page = Math.max(1, opts.page || 1);
  const limit = Math.max(1, Math.min(opts.limit || 25, 200));
  const offset = (page - 1) * limit;

  const searchClause = search
    ? sql`AND (
        LOWER(c.contact_name) LIKE ${`%${search}%`}
        OR LOWER(c.email) LIKE ${`%${search}%`}
        OR LOWER(c.company_name) LIKE ${`%${search}%`}
        OR LOWER(COALESCE(c.error_message, '')) LIKE ${`%${search}%`}
      )`
    : sql``;
  const batchClause = opts.batchId ? sql`AND c.batch_id = ${opts.batchId}` : sql``;

  const countRow = db.get<{ count: number }>(sql`
    SELECT COUNT(c.id) as count
    FROM contacts c
    INNER JOIN batches b ON c.batch_id = b.id
    WHERE b.status NOT IN ('deleted', 'cancelled')
      AND c.generation_status = 'GENERATION_FAILED'
      ${batchClause}
      ${searchClause}
  `);
  const total = countRow?.count ?? 0;

  const rows = db.all<{
    id: string;
    contactName: string | null;
    companyName: string | null;
    email: string;
    status: string;
    generationStatus: string;
    generationAttemptCount: number;
    lastGenerationErrorCategory: string | null;
    errorMessage: string | null;
    failureTimestamp: string | null;
    batchFilename: string;
    createdAt: string;
    classificationResult: string | null;
    classificationSource: string | null;
    geminiModel: string | null;
  }>(sql`
    SELECT
      c.id,
      c.contact_name as contactName,
      c.company_name as companyName,
      c.email,
      c.status,
      c.generation_status as generationStatus,
      COALESCE(c.generation_attempt_count, 0) as generationAttemptCount,
      c.last_generation_error_category as lastGenerationErrorCategory,
      c.error_message as errorMessage,
      c.last_generation_attempt_at as failureTimestamp,
      b.filename as batchFilename,
      c.created_at as createdAt,
      COALESCE(cc.classification_result, CASE WHEN c.is_relevant = 1 THEN 'RELEVANT' WHEN c.is_relevant = 0 THEN 'IRRELEVANT' ELSE 'UNKNOWN' END) as classificationResult,
      COALESCE(cc.classification_source, 'Not recorded') as classificationSource,
      cc.gemini_model as geminiModel
    FROM contacts c
    INNER JOIN batches b ON c.batch_id = b.id
    LEFT JOIN company_classifications cc ON (cc.normalized_name = LOWER(TRIM(c.company_name)) OR cc.company_name = c.company_name OR cc.company_name = TRIM(c.company_name))
    WHERE b.status NOT IN ('deleted', 'cancelled')
      AND c.generation_status = 'GENERATION_FAILED'
      ${batchClause}
      ${searchClause}
    ORDER BY COALESCE(c.last_generation_attempt_at, c.updated_at) DESC, c.generation_attempt_count DESC, c.id ASC
    LIMIT ${limit} OFFSET ${offset}
  `);

  const records: GenerationFailedRecord[] = rows.map((r) => {
    let generationProvider = 'Not recorded';
    if (r.errorMessage) {
      if (/openrouter/i.test(r.errorMessage)) {
        generationProvider = 'OpenRouter';
      } else if (/gemini/i.test(r.errorMessage)) {
        generationProvider = 'Gemini';
      }
    }

    return {
      id: r.id,
      contactName: r.contactName,
      companyName: r.companyName,
      email: r.email,
      classificationResult: r.classificationResult || 'Not recorded',
      classificationSource: r.classificationSource || 'Not recorded',
      geminiModel: r.geminiModel || null,
      generationStatus: 'GENERATION_FAILED',
      generationProvider,
      generationAttemptCount: r.generationAttemptCount,
      lastGenerationErrorCategory: r.lastGenerationErrorCategory,
      errorMessage: r.errorMessage,
      failureTimestamp: r.failureTimestamp,
      isRetryable: false,
      status: r.status,
      batchFilename: r.batchFilename,
      createdAt: r.createdAt,
    };
  });

  return { records, total };
}

// ---------------------------------------------------------------------------
// 6. READY TO SEND (Matches Canonical Scheduler Sendability Exactly)
// ---------------------------------------------------------------------------

export function getReadyToSendList(opts: ProcessingPaginationOptions = {}): {
  records: ReadyToSendRecord[];
  total: number;
} {
  const db = getDb();
  const search = (opts.search || '').trim().toLowerCase();
  const page = Math.max(1, opts.page || 1);
  const limit = Math.max(1, Math.min(opts.limit || 25, 200));
  const offset = (page - 1) * limit;
  const nowIso = new Date().toISOString();
  const cooldownCutoffIso = getCooldownCutoffIso();

  const searchClause = search
    ? sql`AND (LOWER(c.contact_name) LIKE ${`%${search}%`} OR LOWER(c.email) LIKE ${`%${search}%`} OR LOWER(c.company_name) LIKE ${`%${search}%`} OR LOWER(c.email_subject) LIKE ${`%${search}%`})`
    : sql``;
  const batchClause = opts.batchId ? sql`AND c.batch_id = ${opts.batchId}` : sql``;

  const countRow = db.get<{ count: number }>(sql`
    SELECT COUNT(DISTINCT c.id) as count
    FROM contacts c
    INNER JOIN batches b ON c.batch_id = b.id
    INNER JOIN outreach_queue oq ON oq.contact_id = c.id
    WHERE b.status NOT IN ('deleted', 'cancelled')
      AND (
        oq.status = 'pending'
        OR (
          oq.status = 'failed'
          AND oq.attempts < 3
          AND oq.next_retry_at IS NOT NULL
          AND oq.next_retry_at <= ${nowIso}
        )
      )
      AND c.is_relevant = 1
      AND c.email_valid = 1
      AND c.is_duplicate = 0
      AND c.sent_at IS NULL
      AND c.email_subject IS NOT NULL
      AND TRIM(c.email_subject) != ''
      AND c.email_body IS NOT NULL
      AND TRIM(c.email_body) != ''
      AND (c.generation_status = 'GENERATED' OR c.status = 'generated')
      AND NOT EXISTS (
        SELECT 1 FROM global_email_history geh
        WHERE geh.email = LOWER(TRIM(c.email))
          AND geh.status = 'sent'
          AND geh.sent_at IS NOT NULL
          AND geh.sent_at > ${cooldownCutoffIso}
      )
      ${batchClause}
      ${searchClause}
  `);
  const total = countRow?.count ?? 0;

  const rows = db.all<{
    id: string;
    contactName: string | null;
    companyName: string | null;
    email: string;
    emailSubject: string;
    emailBody: string;
    emailStrategy: string | null;
    generatedAt: string | null;
    queueStatus: string;
    queuePriority: number;
    batchFilename: string;
    status: string;
  }>(sql`
    SELECT
      c.id,
      c.contact_name as contactName,
      c.company_name as companyName,
      c.email,
      c.email_subject as emailSubject,
      c.email_body as emailBody,
      c.email_strategy as emailStrategy,
      c.generated_at as generatedAt,
      oq.status as queueStatus,
      oq.priority as queuePriority,
      b.filename as batchFilename,
      c.status
    FROM contacts c
    INNER JOIN batches b ON c.batch_id = b.id
    INNER JOIN outreach_queue oq ON oq.contact_id = c.id
    WHERE b.status NOT IN ('deleted', 'cancelled')
      AND (
        oq.status = 'pending'
        OR (
          oq.status = 'failed'
          AND oq.attempts < 3
          AND oq.next_retry_at IS NOT NULL
          AND oq.next_retry_at <= ${nowIso}
        )
      )
      AND c.is_relevant = 1
      AND c.email_valid = 1
      AND c.is_duplicate = 0
      AND c.sent_at IS NULL
      AND c.email_subject IS NOT NULL
      AND TRIM(c.email_subject) != ''
      AND c.email_body IS NOT NULL
      AND TRIM(c.email_body) != ''
      AND (c.generation_status = 'GENERATED' OR c.status = 'generated')
      AND NOT EXISTS (
        SELECT 1 FROM global_email_history geh
        WHERE geh.email = LOWER(TRIM(c.email))
          AND geh.status = 'sent'
          AND geh.sent_at IS NOT NULL
          AND geh.sent_at > ${cooldownCutoffIso}
      )
      ${batchClause}
      ${searchClause}
    ORDER BY oq.priority DESC, c.created_at ASC, c.id ASC
    LIMIT ${limit} OFFSET ${offset}
  `);

  return { records: rows, total };
}
