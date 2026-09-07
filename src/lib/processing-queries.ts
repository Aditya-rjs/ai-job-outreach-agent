import { getDb } from '@/db';
import { sql } from 'drizzle-orm';
import { getCooldownCutoffIso } from '@/lib/scheduler/time-utils';

export interface ProcessingPipelineStats {
  classificationPendingCount: number;
  classificationRetryWaitingCount: number;
  emailGenerationPendingCount: number;
  generationRetryCount: number;
  generationFailedCount: number;
  readyToSendCount: number;
  lastUpdated: string;
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
  search?: string;
  page?: number;
  limit?: number;
}

// ---------------------------------------------------------------------------
// 1. CANONICAL STATS FOR AI OUTREACH PROCESSING
// ---------------------------------------------------------------------------

export function getProcessingPipelineStats(batchId?: string): ProcessingPipelineStats {
  const db = getDb();
  const nowIso = new Date().toISOString();

  const batchFilter = batchId ? sql`AND c.batch_id = ${batchId}` : sql``;

  // 1. Classification Pending: Unique normalized companies in active batches with classification_result = 'PENDING' (active in current round only)
  const classPendingRow = db.get<{ count: number }>(sql`
    SELECT COUNT(DISTINCT LOWER(TRIM(c.company_name))) as count
    FROM contacts c
    INNER JOIN batches b ON c.batch_id = b.id
    LEFT JOIN company_classifications cc ON (cc.normalized_name = LOWER(TRIM(c.company_name)) OR cc.company_name = c.company_name OR cc.company_name = TRIM(c.company_name))
    WHERE b.status NOT IN ('deleted', 'cancelled')
      AND c.company_name IS NOT NULL
      AND TRIM(c.company_name) != ''
      ${batchFilter}
      AND (cc.classification_result = 'PENDING' OR (cc.classification_result IS NULL AND c.is_relevant IS NULL))
  `);

  // 1b. Classification Retry Waiting: Companies that failed current round and are waiting for next retry round
  const classRetryWaitingRow = db.get<{ count: number }>(sql`
    SELECT COUNT(DISTINCT LOWER(TRIM(c.company_name))) as count
    FROM contacts c
    INNER JOIN batches b ON c.batch_id = b.id
    INNER JOIN company_classifications cc ON (cc.normalized_name = LOWER(TRIM(c.company_name)) OR cc.company_name = c.company_name OR cc.company_name = TRIM(c.company_name))
    WHERE b.status NOT IN ('deleted', 'cancelled')
      AND c.company_name IS NOT NULL
      AND TRIM(c.company_name) != ''
      ${batchFilter}
      AND cc.classification_result = 'RETRY_WAITING'
  `);

  // 2. Email Generation Pending: Gemini-relevant contacts awaiting initial generation
  const genPendingRow = db.get<{ count: number }>(sql`
    SELECT COUNT(c.id) as count
    FROM contacts c
    INNER JOIN batches b ON c.batch_id = b.id
    WHERE b.status NOT IN ('deleted', 'cancelled')
      AND c.is_relevant = 1
      AND c.email_valid = 1
      AND c.is_duplicate = 0
      AND c.sent_at IS NULL
      ${batchFilter}
      AND (
        c.generation_status IN ('PENDING_GENERATION', 'GENERATING')
        OR (
          c.generation_status IS NULL
          AND c.status IN ('queued', 'generating', 'discovered')
          AND (c.email_subject IS NULL OR c.email_body IS NULL OR TRIM(c.email_subject) = '' OR TRIM(c.email_body) = '')
        )
      )
  `);

  // 3. Generation Retry: Contacts in active batches with generation_status = 'RETRY_PENDING'
  const genRetryRow = db.get<{ count: number }>(sql`
    SELECT COUNT(c.id) as count
    FROM contacts c
    INNER JOIN batches b ON c.batch_id = b.id
    WHERE b.status NOT IN ('deleted', 'cancelled')
      AND c.is_relevant = 1
      AND c.email_valid = 1
      AND c.is_duplicate = 0
      AND c.sent_at IS NULL
      ${batchFilter}
      AND c.generation_status = 'RETRY_PENDING'
  `);

  // 3b. Generation Failed: Contacts in active batches with generation_status = 'GENERATION_FAILED'
  const genFailedRow = db.get<{ count: number }>(sql`
    SELECT COUNT(c.id) as count
    FROM contacts c
    INNER JOIN batches b ON c.batch_id = b.id
    WHERE b.status NOT IN ('deleted', 'cancelled')
      AND c.generation_status = 'GENERATION_FAILED'
      ${batchFilter}
  `);

  // 4. Ready to Send: Exact scheduler eligibility predicate
  const cooldownCutoffIso = getCooldownCutoffIso();
  const readyToSendRow = db.get<{ count: number }>(sql`
    SELECT COUNT(DISTINCT c.id) as count
    FROM contacts c
    INNER JOIN batches b ON c.batch_id = b.id
    INNER JOIN outreach_queue oq ON oq.contact_id = c.id
    WHERE b.status NOT IN ('deleted', 'cancelled')
      ${batchFilter}
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
  `);

  return {
    classificationPendingCount: classPendingRow?.count ?? 0,
    classificationRetryWaitingCount: classRetryWaitingRow?.count ?? 0,
    emailGenerationPendingCount: genPendingRow?.count ?? 0,
    generationRetryCount: genRetryRow?.count ?? 0,
    generationFailedCount: genFailedRow?.count ?? 0,
    readyToSendCount: readyToSendRow?.count ?? 0,
    lastUpdated: new Date().toISOString(),
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

  const countRow = db.get<{ count: number }>(sql`
    SELECT COUNT(DISTINCT LOWER(TRIM(c.company_name))) as count
    FROM contacts c
    INNER JOIN batches b ON c.batch_id = b.id
    LEFT JOIN company_classifications cc ON (cc.normalized_name = LOWER(TRIM(c.company_name)) OR cc.company_name = c.company_name OR cc.company_name = TRIM(c.company_name))
    WHERE b.status NOT IN ('deleted', 'cancelled')
      AND c.company_name IS NOT NULL
      AND TRIM(c.company_name) != ''
      AND (cc.classification_result = 'PENDING' OR (cc.classification_result IS NULL AND c.is_relevant IS NULL))
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

  const countRow = db.get<{ count: number }>(sql`
    SELECT COUNT(DISTINCT LOWER(TRIM(c.company_name))) as count
    FROM contacts c
    INNER JOIN batches b ON c.batch_id = b.id
    INNER JOIN company_classifications cc ON (cc.normalized_name = LOWER(TRIM(c.company_name)) OR cc.company_name = c.company_name OR cc.company_name = TRIM(c.company_name))
    WHERE b.status NOT IN ('deleted', 'cancelled')
      AND c.company_name IS NOT NULL
      AND TRIM(c.company_name) != ''
      AND cc.classification_result = 'RETRY_WAITING'
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

export function getCompanyContactsList(normalizedName: string): CompanyContactItem[] {
  const db = getDb();
  const target = normalizedName.trim().toLowerCase();

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
  const search = (opts.search || '').trim().toLowerCase();
  const page = Math.max(1, opts.page || 1);
  const limit = Math.max(1, Math.min(opts.limit || 25, 200));
  const offset = (page - 1) * limit;

  const searchClause = search
    ? sql`AND (LOWER(c.contact_name) LIKE ${`%${search}%`} OR LOWER(c.email) LIKE ${`%${search}%`} OR LOWER(c.company_name) LIKE ${`%${search}%`})`
    : sql``;

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

  const countRow = db.get<{ count: number }>(sql`
    SELECT COUNT(c.id) as count
    FROM contacts c
    INNER JOIN batches b ON c.batch_id = b.id
    WHERE b.status NOT IN ('deleted', 'cancelled')
      AND c.generation_status = 'GENERATION_FAILED'
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
      COALESCE(c.last_generation_attempt_at, c.updated_at) as failureTimestamp,
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
      ${searchClause}
    ORDER BY oq.priority DESC, oq.created_at ASC, c.id ASC
    LIMIT ${limit} OFFSET ${offset}
  `);

  return { records: rows, total };
}
