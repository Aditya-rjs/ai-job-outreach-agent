import { getDb } from '@/db';
import { sql } from 'drizzle-orm';
import { getCooldownCutoffIso } from '@/lib/scheduler/time-utils';
import type { Contact } from '@/types';

export interface CompanyDetailRecord {
  companyName: string;
  normalizedName: string;
  isRelevant: boolean | null;
  classificationResult: string;
  classificationSource: string;
  geminiModel: string;
  confidence: number | null;
  reason: string | null;
  contactCount: number;
  contactEmails: string[];
  batchFilenames: string[];
}

export interface QueuedContactDetailRecord extends Contact {
  batchFilename?: string;
  queueStatus: string;
  queuePriority: number;
  queueAttempts: number;
  sendabilityStatus: 'READY' | 'GENERATING' | 'PENDING_GENERATION' | 'RETRY_PENDING' | 'GENERATION_FAILED' | 'BLOCKED';
  sendabilityReason: string;
}

export interface PaginationOptions {
  search?: string;
  page?: number;
  limit?: number;
}

// ---------------------------------------------------------------------------
// 1. TOTAL COMPANIES (Canonical Definitions)
// ---------------------------------------------------------------------------

export function getTotalCompaniesCount(): number {
  const db = getDb();
  const row = db.get<{ count: number }>(sql`
    SELECT COUNT(DISTINCT TRIM(company_name)) as count
    FROM contacts
    WHERE company_name IS NOT NULL
      AND TRIM(company_name) != ''
      AND batch_id NOT IN (SELECT id FROM batches WHERE status = 'deleted')
  `);
  return row?.count ?? 0;
}

export function getTotalCompaniesList(opts: PaginationOptions = {}): {
  companies: CompanyDetailRecord[];
  total: number;
} {
  const db = getDb();
  const search = (opts.search || '').trim().toLowerCase();
  const page = Math.max(1, opts.page || 1);
  const limit = Math.max(1, Math.min(opts.limit || 50, 200));
  const offset = (page - 1) * limit;

  const searchClause = search
    ? sql`AND (LOWER(TRIM(c.company_name)) LIKE ${`%${search}%`} OR LOWER(cc.reason) LIKE ${`%${search}%`})`
    : sql``;

  const countRow = db.get<{ count: number }>(sql`
    SELECT COUNT(DISTINCT TRIM(c.company_name)) as count
    FROM contacts c
    LEFT JOIN company_classifications cc
      ON LOWER(TRIM(c.company_name)) = cc.normalized_name
    WHERE c.company_name IS NOT NULL
      AND TRIM(c.company_name) != ''
      AND c.batch_id NOT IN (SELECT id FROM batches WHERE status = 'deleted')
      ${searchClause}
  `);
  const total = countRow?.count ?? 0;

  const rows = db.all<{
    companyName: string;
    normalizedName: string | null;
    isRelevant: number | null;
    classificationResult: string | null;
    classificationSource: string | null;
    geminiModel: string | null;
    confidence: number | null;
    reason: string | null;
    contactCount: number;
    contactEmailsStr: string | null;
    batchFilenamesStr: string | null;
  }>(sql`
    SELECT
      TRIM(c.company_name) as companyName,
      cc.normalized_name as normalizedName,
      CASE
        WHEN cc.classification_result = 'RELEVANT' THEN 1
        WHEN cc.classification_result = 'IRRELEVANT' THEN 0
        WHEN cc.is_relevant IS NOT NULL THEN cc.is_relevant
        ELSE MAX(c.is_relevant)
      END as isRelevant,
      COALESCE(cc.classification_result,
        CASE
          WHEN MAX(c.is_relevant) = 1 THEN 'RELEVANT'
          WHEN MAX(c.is_relevant) = 0 THEN 'IRRELEVANT'
          ELSE 'PENDING'
        END
      ) as classificationResult,
      COALESCE(cc.classification_source, 'gemini') as classificationSource,
      COALESCE(cc.gemini_model, 'gemini-3.8-flash') as geminiModel,
      COALESCE(cc.confidence, MAX(c.relevance_confidence)) as confidence,
      COALESCE(cc.reason, MAX(c.relevance_reason)) as reason,
      COUNT(c.id) as contactCount,
      GROUP_CONCAT(DISTINCT c.email) as contactEmailsStr,
      GROUP_CONCAT(DISTINCT b.filename) as batchFilenamesStr
    FROM contacts c
    LEFT JOIN company_classifications cc
      ON LOWER(TRIM(c.company_name)) = cc.normalized_name
    LEFT JOIN batches b
      ON c.batch_id = b.id
    WHERE c.company_name IS NOT NULL
      AND TRIM(c.company_name) != ''
      AND c.batch_id NOT IN (SELECT id FROM batches WHERE status = 'deleted')
      ${searchClause}
    GROUP BY TRIM(c.company_name)
    ORDER BY contactCount DESC, TRIM(c.company_name) ASC
    LIMIT ${limit} OFFSET ${offset}
  `);

  const companies: CompanyDetailRecord[] = rows.map((r) => ({
    companyName: r.companyName,
    normalizedName: r.normalizedName || r.companyName.toLowerCase(),
    isRelevant: r.isRelevant === null ? null : Boolean(r.isRelevant),
    classificationResult: r.classificationResult || 'PENDING',
    classificationSource: r.classificationSource || 'gemini',
    geminiModel: r.geminiModel || 'gemini-3.8-flash',
    confidence: r.confidence,
    reason: r.reason,
    contactCount: Number(r.contactCount || 0),
    contactEmails: r.contactEmailsStr ? r.contactEmailsStr.split(',') : [],
    batchFilenames: r.batchFilenamesStr ? r.batchFilenamesStr.split(',') : [],
  }));

  return { companies, total };
}

// ---------------------------------------------------------------------------
// 2. RELEVANT TECH (Canonical Definitions)
// ---------------------------------------------------------------------------

export function getRelevantCompaniesCount(): number {
  const db = getDb();
  const row = db.get<{ count: number }>(sql`
    SELECT COUNT(DISTINCT TRIM(company_name)) as count
    FROM contacts
    WHERE is_relevant = 1
      AND company_name IS NOT NULL
      AND TRIM(company_name) != ''
      AND batch_id NOT IN (SELECT id FROM batches WHERE status = 'deleted')
  `);
  return row?.count ?? 0;
}

export function getRelevantCompaniesList(opts: PaginationOptions = {}): {
  companies: CompanyDetailRecord[];
  total: number;
} {
  const db = getDb();
  const search = (opts.search || '').trim().toLowerCase();
  const page = Math.max(1, opts.page || 1);
  const limit = Math.max(1, Math.min(opts.limit || 50, 200));
  const offset = (page - 1) * limit;

  const searchClause = search
    ? sql`AND (LOWER(TRIM(c.company_name)) LIKE ${`%${search}%`} OR LOWER(cc.reason) LIKE ${`%${search}%`})`
    : sql``;

  const countRow = db.get<{ count: number }>(sql`
    SELECT COUNT(DISTINCT TRIM(c.company_name)) as count
    FROM contacts c
    LEFT JOIN company_classifications cc
      ON LOWER(TRIM(c.company_name)) = cc.normalized_name
    WHERE c.is_relevant = 1
      AND c.company_name IS NOT NULL
      AND TRIM(c.company_name) != ''
      AND c.batch_id NOT IN (SELECT id FROM batches WHERE status = 'deleted')
      ${searchClause}
  `);
  const total = countRow?.count ?? 0;

  const rows = db.all<{
    companyName: string;
    normalizedName: string | null;
    confidence: number | null;
    reason: string | null;
    contactCount: number;
    contactEmailsStr: string | null;
    batchFilenamesStr: string | null;
    geminiModel: string | null;
  }>(sql`
    SELECT
      TRIM(c.company_name) as companyName,
      cc.normalized_name as normalizedName,
      COALESCE(cc.confidence, MAX(c.relevance_confidence)) as confidence,
      COALESCE(cc.reason, MAX(c.relevance_reason)) as reason,
      COUNT(c.id) as contactCount,
      GROUP_CONCAT(DISTINCT c.email) as contactEmailsStr,
      GROUP_CONCAT(DISTINCT b.filename) as batchFilenamesStr,
      COALESCE(cc.gemini_model, 'gemini-3.8-flash') as geminiModel
    FROM contacts c
    LEFT JOIN company_classifications cc
      ON LOWER(TRIM(c.company_name)) = cc.normalized_name
    LEFT JOIN batches b
      ON c.batch_id = b.id
    WHERE c.is_relevant = 1
      AND c.company_name IS NOT NULL
      AND TRIM(c.company_name) != ''
      AND c.batch_id NOT IN (SELECT id FROM batches WHERE status = 'deleted')
      ${searchClause}
    GROUP BY TRIM(c.company_name)
    ORDER BY contactCount DESC, TRIM(c.company_name) ASC
    LIMIT ${limit} OFFSET ${offset}
  `);

  const companies: CompanyDetailRecord[] = rows.map((r) => ({
    companyName: r.companyName,
    normalizedName: r.normalizedName || r.companyName.toLowerCase(),
    isRelevant: true,
    classificationResult: 'RELEVANT',
    classificationSource: 'gemini',
    geminiModel: r.geminiModel || 'gemini-3.8-flash',
    confidence: r.confidence,
    reason: r.reason,
    contactCount: Number(r.contactCount || 0),
    contactEmails: r.contactEmailsStr ? r.contactEmailsStr.split(',') : [],
    batchFilenames: r.batchFilenamesStr ? r.batchFilenamesStr.split(',') : [],
  }));

  return { companies, total };
}

// ---------------------------------------------------------------------------
// 3. CONTACTS FOUND (Canonical Definitions)
// ---------------------------------------------------------------------------

export function getTotalContactsCount(): number {
  const db = getDb();
  const row = db.get<{ count: number }>(sql`
    SELECT COUNT(*) as count
    FROM contacts
    WHERE batch_id NOT IN (SELECT id FROM batches WHERE status = 'deleted')
  `);
  return row?.count ?? 0;
}

export function getTotalContactsList(opts: PaginationOptions = {}): {
  contacts: (Contact & { batchFilename?: string })[];
  total: number;
} {
  const db = getDb();
  const search = (opts.search || '').trim().toLowerCase();
  const page = Math.max(1, opts.page || 1);
  const limit = Math.max(1, Math.min(opts.limit || 50, 200));
  const offset = (page - 1) * limit;

  const searchClause = search
    ? sql`AND (LOWER(c.contact_name) LIKE ${`%${search}%`} OR LOWER(c.email) LIKE ${`%${search}%`} OR LOWER(c.company_name) LIKE ${`%${search}%`})`
    : sql``;

  const countRow = db.get<{ count: number }>(sql`
    SELECT COUNT(*) as count
    FROM contacts c
    WHERE c.batch_id NOT IN (SELECT id FROM batches WHERE status = 'deleted')
      ${searchClause}
  `);
  const total = countRow?.count ?? 0;

  const rows = db.all<Contact & { batchFilename?: string }>(sql`
    SELECT
      c.id,
      c.batch_id as batchId,
      c.company_name as companyName,
      c.contact_name as contactName,
      c.email,
      c.designation,
      c.company_website as companyWebsite,
      c.company_location as companyLocation,
      c.is_relevant as isRelevant,
      c.relevance_confidence as relevanceConfidence,
      c.relevance_reason as relevanceReason,
      c.is_duplicate as isDuplicate,
      c.email_valid as emailValid,
      c.status,
      c.email_subject as emailSubject,
      c.email_body as emailBody,
      c.email_strategy as emailStrategy,
      c.personalization_points as personalizationPoints,
      c.resume_version as resumeVersion,
      c.generated_at as generatedAt,
      c.gmail_message_id as gmailMessageId,
      c.sent_at as sentAt,
      c.error_message as errorMessage,
      c.send_attempt_count as sendAttemptCount,
      c.generation_status as generationStatus,
      c.generation_attempt_count as generationAttemptCount,
      c.generation_claim_token as generationClaimToken,
      c.generation_lease_expires_at as generationLeaseExpiresAt,
      c.last_generation_error_category as lastGenerationErrorCategory,
      c.next_generation_retry_at as nextGenerationRetryAt,
      c.last_generation_attempt_at as lastGenerationAttemptAt,
      c.created_at as createdAt,
      c.updated_at as updatedAt,
      b.filename as batchFilename
    FROM contacts c
    LEFT JOIN batches b ON c.batch_id = b.id
    WHERE c.batch_id NOT IN (SELECT id FROM batches WHERE status = 'deleted')
      ${searchClause}
    ORDER BY c.created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `);

  return {
    contacts: rows.map((r) => ({
      ...r,
      isRelevant: r.isRelevant === null ? null : Boolean(r.isRelevant),
      isDuplicate: Boolean(r.isDuplicate),
      emailValid: Boolean(r.emailValid),
    })),
    total,
  };
}

// ---------------------------------------------------------------------------
// 4. ELIGIBLE QUEUED (Canonical Sendability Definitions)
// ---------------------------------------------------------------------------

export function getEligibleQueuedCount(): number {
  const db = getDb();
  const cooldownCutoffIso = getCooldownCutoffIso();
  const row = db.get<{ count: number }>(sql`
    SELECT COUNT(DISTINCT c.id) as count
    FROM contacts c
    INNER JOIN outreach_queue oq ON oq.contact_id = c.id
    INNER JOIN batches b ON c.batch_id = b.id
    WHERE (oq.status = 'pending' OR oq.status = 'processing')
      AND b.status NOT IN ('cancelled', 'deleted')
      AND c.is_duplicate = 0
      AND c.email_valid = 1
      AND (c.is_relevant IS NULL OR c.is_relevant = 1)
      AND c.sent_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM global_email_history geh
        WHERE geh.email = LOWER(TRIM(c.email))
          AND geh.status = 'sent'
          AND geh.sent_at IS NOT NULL
          AND geh.sent_at > ${cooldownCutoffIso}
      )
  `);
  return row?.count ?? 0;
}

export function getEligibleQueuedList(opts: PaginationOptions = {}): {
  contacts: QueuedContactDetailRecord[];
  total: number;
} {
  const db = getDb();
  const cooldownCutoffIso = getCooldownCutoffIso();
  const search = (opts.search || '').trim().toLowerCase();
  const page = Math.max(1, opts.page || 1);
  const limit = Math.max(1, Math.min(opts.limit || 50, 200));
  const offset = (page - 1) * limit;

  const searchClause = search
    ? sql`AND (LOWER(c.contact_name) LIKE ${`%${search}%`} OR LOWER(c.email) LIKE ${`%${search}%`} OR LOWER(c.company_name) LIKE ${`%${search}%`})`
    : sql``;

  const countRow = db.get<{ count: number }>(sql`
    SELECT COUNT(DISTINCT c.id) as count
    FROM contacts c
    INNER JOIN outreach_queue oq ON oq.contact_id = c.id
    INNER JOIN batches b ON c.batch_id = b.id
    WHERE (oq.status = 'pending' OR oq.status = 'processing')
      AND b.status NOT IN ('cancelled', 'deleted')
      AND c.is_duplicate = 0
      AND c.email_valid = 1
      AND (c.is_relevant IS NULL OR c.is_relevant = 1)
      AND c.sent_at IS NULL
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
    batchId: string;
    companyName: string | null;
    contactName: string | null;
    email: string;
    designation: string | null;
    companyWebsite: string | null;
    companyLocation: string | null;
    isRelevant: number | null;
    relevanceConfidence: number | null;
    relevanceReason: string | null;
    isDuplicate: number;
    emailValid: number;
    status: Contact['status'];
    emailSubject: string | null;
    emailBody: string | null;
    emailStrategy: string | null;
    personalizationPoints: string | null;
    resumeVersion: string | null;
    generatedAt: string | null;
    gmailMessageId: string | null;
    sentAt: string | null;
    errorMessage: string | null;
    sendAttemptCount: number;
    generationStatus: Contact['generationStatus'];
    generationAttemptCount: number;
    generationClaimToken: string | null;
    generationLeaseExpiresAt: string | null;
    lastGenerationErrorCategory: string | null;
    nextGenerationRetryAt: string | null;
    lastGenerationAttemptAt: string | null;
    createdAt: string;
    updatedAt: string;
    batchFilename?: string;
    queueStatus: string;
    queuePriority: number;
    queueAttempts: number;
  }>(sql`
    SELECT
      c.id,
      c.batch_id as batchId,
      c.company_name as companyName,
      c.contact_name as contactName,
      c.email,
      c.designation,
      c.company_website as companyWebsite,
      c.company_location as companyLocation,
      c.is_relevant as isRelevant,
      c.relevance_confidence as relevanceConfidence,
      c.relevance_reason as relevanceReason,
      c.is_duplicate as isDuplicate,
      c.email_valid as emailValid,
      c.status,
      c.email_subject as emailSubject,
      c.email_body as emailBody,
      c.email_strategy as emailStrategy,
      c.personalization_points as personalizationPoints,
      c.resume_version as resumeVersion,
      c.generated_at as generatedAt,
      c.gmail_message_id as gmailMessageId,
      c.sent_at as sentAt,
      c.error_message as errorMessage,
      c.send_attempt_count as sendAttemptCount,
      c.generation_status as generationStatus,
      c.generation_attempt_count as generationAttemptCount,
      c.generation_claim_token as generationClaimToken,
      c.generation_lease_expires_at as generationLeaseExpiresAt,
      c.last_generation_error_category as lastGenerationErrorCategory,
      c.next_generation_retry_at as nextGenerationRetryAt,
      c.last_generation_attempt_at as lastGenerationAttemptAt,
      c.created_at as createdAt,
      c.updated_at as updatedAt,
      b.filename as batchFilename,
      oq.status as queueStatus,
      oq.priority as queuePriority,
      oq.attempts as queueAttempts
    FROM contacts c
    INNER JOIN outreach_queue oq ON oq.contact_id = c.id
    INNER JOIN batches b ON c.batch_id = b.id
    WHERE (oq.status = 'pending' OR oq.status = 'processing')
      AND b.status NOT IN ('cancelled', 'deleted')
      AND c.is_duplicate = 0
      AND c.email_valid = 1
      AND (c.is_relevant IS NULL OR c.is_relevant = 1)
      AND c.sent_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM global_email_history geh
        WHERE geh.email = LOWER(TRIM(c.email))
          AND geh.status = 'sent'
          AND geh.sent_at IS NOT NULL
          AND geh.sent_at > ${cooldownCutoffIso}
      )
      ${searchClause}
    ORDER BY oq.priority DESC, oq.created_at ASC
    LIMIT ${limit} OFFSET ${offset}
  `);

  const contacts: QueuedContactDetailRecord[] = rows.map((r) => {
    let sendabilityStatus: QueuedContactDetailRecord['sendabilityStatus'] = 'PENDING_GENERATION';
    let sendabilityReason = 'Waiting for autonomous background AI email generation';

    const hasGeneratedEmail = Boolean(
      r.emailSubject &&
      r.emailSubject.trim().length > 0 &&
      r.emailBody &&
      r.emailBody.trim().length > 0 &&
      (r.generationStatus === 'GENERATED' || r.status === 'generated')
    );

    if (hasGeneratedEmail) {
      sendabilityStatus = 'READY';
      sendabilityReason = 'Ready to send when daily 10:00 AM window opens';
    } else if (r.generationStatus === 'GENERATING' || r.status === 'generating') {
      sendabilityStatus = 'GENERATING';
      sendabilityReason = 'AI email generation currently in progress';
    } else if (r.generationStatus === 'RETRY_PENDING') {
      sendabilityStatus = 'RETRY_PENDING';
      sendabilityReason = r.nextGenerationRetryAt
        ? `Transient generation error; retry scheduled for ${new Date(r.nextGenerationRetryAt).toLocaleTimeString()}`
        : 'Generation retry pending with exponential backoff';
    } else if (r.generationStatus === 'GENERATION_FAILED') {
      sendabilityStatus = 'GENERATION_FAILED';
      sendabilityReason = 'AI generation exhausted retries; awaiting recovery';
    }

    return {
      ...r,
      isRelevant: r.isRelevant === null ? null : Boolean(r.isRelevant),
      isDuplicate: Boolean(r.isDuplicate),
      emailValid: Boolean(r.emailValid),
      sendabilityStatus,
      sendabilityReason,
    };
  });

  return { contacts, total };
}

// ---------------------------------------------------------------------------
// 5. EMAILS GENERATED (Canonical Definitions)
// ---------------------------------------------------------------------------

export function getEmailsGeneratedCount(): number {
  const db = getDb();
  const row = db.get<{ count: number }>(sql`
    SELECT COUNT(*) as count
    FROM contacts
    WHERE email_subject IS NOT NULL
      AND TRIM(email_subject) != ''
      AND email_body IS NOT NULL
      AND TRIM(email_body) != ''
      AND (generation_status = 'GENERATED' OR status = 'generated')
      AND batch_id NOT IN (SELECT id FROM batches WHERE status = 'deleted')
  `);
  return row?.count ?? 0;
}

export function getEmailsGeneratedList(opts: PaginationOptions = {}): {
  contacts: (Contact & { batchFilename?: string })[];
  total: number;
} {
  const db = getDb();
  const search = (opts.search || '').trim().toLowerCase();
  const page = Math.max(1, opts.page || 1);
  const limit = Math.max(1, Math.min(opts.limit || 50, 200));
  const offset = (page - 1) * limit;

  const searchClause = search
    ? sql`AND (LOWER(c.contact_name) LIKE ${`%${search}%`} OR LOWER(c.email) LIKE ${`%${search}%`} OR LOWER(c.company_name) LIKE ${`%${search}%`} OR LOWER(c.email_subject) LIKE ${`%${search}%`})`
    : sql``;

  const countRow = db.get<{ count: number }>(sql`
    SELECT COUNT(*) as count
    FROM contacts c
    WHERE c.email_subject IS NOT NULL
      AND TRIM(c.email_subject) != ''
      AND c.email_body IS NOT NULL
      AND TRIM(c.email_body) != ''
      AND (c.generation_status = 'GENERATED' OR c.status = 'generated')
      AND c.batch_id NOT IN (SELECT id FROM batches WHERE status = 'deleted')
      ${searchClause}
  `);
  const total = countRow?.count ?? 0;

  const rows = db.all<Contact & { batchFilename?: string }>(sql`
    SELECT
      c.id,
      c.batch_id as batchId,
      c.company_name as companyName,
      c.contact_name as contactName,
      c.email,
      c.designation,
      c.company_website as companyWebsite,
      c.company_location as companyLocation,
      c.is_relevant as isRelevant,
      c.relevance_confidence as relevanceConfidence,
      c.relevance_reason as relevanceReason,
      c.is_duplicate as isDuplicate,
      c.email_valid as emailValid,
      c.status,
      c.email_subject as emailSubject,
      c.email_body as emailBody,
      c.email_strategy as emailStrategy,
      c.personalization_points as personalizationPoints,
      c.resume_version as resumeVersion,
      c.generated_at as generatedAt,
      c.gmail_message_id as gmailMessageId,
      c.sent_at as sentAt,
      c.error_message as errorMessage,
      c.send_attempt_count as sendAttemptCount,
      c.generation_status as generationStatus,
      c.generation_attempt_count as generationAttemptCount,
      c.generation_claim_token as generationClaimToken,
      c.generation_lease_expires_at as generationLeaseExpiresAt,
      c.last_generation_error_category as lastGenerationErrorCategory,
      c.next_generation_retry_at as nextGenerationRetryAt,
      c.last_generation_attempt_at as lastGenerationAttemptAt,
      c.created_at as createdAt,
      c.updated_at as updatedAt,
      b.filename as batchFilename
    FROM contacts c
    LEFT JOIN batches b ON c.batch_id = b.id
    WHERE c.email_subject IS NOT NULL
      AND TRIM(c.email_subject) != ''
      AND c.email_body IS NOT NULL
      AND TRIM(c.email_body) != ''
      AND (c.generation_status = 'GENERATED' OR c.status = 'generated')
      AND c.batch_id NOT IN (SELECT id FROM batches WHERE status = 'deleted')
      ${searchClause}
    ORDER BY c.updated_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `);

  return {
    contacts: rows.map((r) => ({
      ...r,
      isRelevant: r.isRelevant === null ? null : Boolean(r.isRelevant),
      isDuplicate: Boolean(r.isDuplicate),
      emailValid: Boolean(r.emailValid),
    })),
    total,
  };
}

// ---------------------------------------------------------------------------
// 6. EMAILS SENT (Authoritative Real Gmail Sends vs Simulated Sends)
// ---------------------------------------------------------------------------

export function getEmailsSentCount(isDryRun: boolean = false): number {
  const db = getDb();
  if (isDryRun) {
    const row = db.get<{ count: number }>(sql`
      SELECT COUNT(*) as count
      FROM contacts
      WHERE status = 'simulated'
        AND batch_id NOT IN (SELECT id FROM batches WHERE status = 'deleted')
    `);
    return row?.count ?? 0;
  }

  // Authoritative Real Gmail Sends:
  // Must have status='sent', sent_at NOT NULL, gmail_message_id NOT NULL,
  // AND be present in global_email_history with status='sent'
  const row = db.get<{ count: number }>(sql`
    SELECT COUNT(*) as count
    FROM contacts c
    WHERE c.status = 'sent'
      AND c.sent_at IS NOT NULL
      AND c.gmail_message_id IS NOT NULL
      AND c.batch_id NOT IN (SELECT id FROM batches WHERE status = 'deleted')
      AND EXISTS (
        SELECT 1 FROM global_email_history geh
        WHERE geh.email = LOWER(TRIM(c.email))
          AND geh.status = 'sent'
          AND geh.sent_at IS NOT NULL
      )
  `);
  return row?.count ?? 0;
}

export function getEmailsSentList(opts: PaginationOptions & { mode?: 'real' | 'simulated' } = {}): {
  contacts: (Contact & { batchFilename?: string; isSimulated?: boolean })[];
  total: number;
} {
  const db = getDb();
  const search = (opts.search || '').trim().toLowerCase();
  const page = Math.max(1, opts.page || 1);
  const limit = Math.max(1, Math.min(opts.limit || 50, 200));
  const offset = (page - 1) * limit;
  const isSimulated = opts.mode === 'simulated';

  const searchClause = search
    ? sql`AND (LOWER(c.contact_name) LIKE ${`%${search}%`} OR LOWER(c.email) LIKE ${`%${search}%`} OR LOWER(c.company_name) LIKE ${`%${search}%`} OR LOWER(c.email_subject) LIKE ${`%${search}%`})`
    : sql``;

  const whereClause = isSimulated
    ? sql`c.status = 'simulated' AND c.batch_id NOT IN (SELECT id FROM batches WHERE status = 'deleted') ${searchClause}`
    : sql`c.status = 'sent'
        AND c.sent_at IS NOT NULL
        AND c.gmail_message_id IS NOT NULL
        AND c.batch_id NOT IN (SELECT id FROM batches WHERE status = 'deleted')
        AND EXISTS (
          SELECT 1 FROM global_email_history geh
          WHERE geh.email = LOWER(TRIM(c.email))
            AND geh.status = 'sent'
            AND geh.sent_at IS NOT NULL
        )
        ${searchClause}`;

  const countRow = db.get<{ count: number }>(sql`
    SELECT COUNT(*) as count
    FROM contacts c
    WHERE ${whereClause}
  `);
  const total = countRow?.count ?? 0;

  const rows = db.all<Contact & { batchFilename?: string }>(sql`
    SELECT
      c.id,
      c.batch_id as batchId,
      c.company_name as companyName,
      c.contact_name as contactName,
      c.email,
      c.designation,
      c.company_website as companyWebsite,
      c.company_location as companyLocation,
      c.is_relevant as isRelevant,
      c.relevance_confidence as relevanceConfidence,
      c.relevance_reason as relevanceReason,
      c.is_duplicate as isDuplicate,
      c.email_valid as emailValid,
      c.status,
      c.email_subject as emailSubject,
      c.email_body as emailBody,
      c.email_strategy as emailStrategy,
      c.personalization_points as personalizationPoints,
      c.resume_version as resumeVersion,
      c.generated_at as generatedAt,
      c.gmail_message_id as gmailMessageId,
      c.sent_at as sentAt,
      c.error_message as errorMessage,
      c.send_attempt_count as sendAttemptCount,
      c.generation_status as generationStatus,
      c.generation_attempt_count as generationAttemptCount,
      c.generation_claim_token as generationClaimToken,
      c.generation_lease_expires_at as generationLeaseExpiresAt,
      c.last_generation_error_category as lastGenerationErrorCategory,
      c.next_generation_retry_at as nextGenerationRetryAt,
      c.last_generation_attempt_at as lastGenerationAttemptAt,
      c.created_at as createdAt,
      c.updated_at as updatedAt,
      b.filename as batchFilename
    FROM contacts c
    LEFT JOIN batches b ON c.batch_id = b.id
    WHERE ${whereClause}
    ORDER BY c.sent_at DESC, c.updated_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `);

  return {
    contacts: rows.map((r) => ({
      ...r,
      isRelevant: r.isRelevant === null ? null : Boolean(r.isRelevant),
      isDuplicate: Boolean(r.isDuplicate),
      emailValid: Boolean(r.emailValid),
      isSimulated,
    })),
    total,
  };
}

// ---------------------------------------------------------------------------
// 7. SKIPPED / FILTERED (Canonical Definitions)
// ---------------------------------------------------------------------------

export function getEmailsSkippedCount(): number {
  const db = getDb();
  const row = db.get<{ count: number }>(sql`
    SELECT COUNT(*) as count
    FROM contacts
    WHERE status = 'skipped'
      AND batch_id NOT IN (SELECT id FROM batches WHERE status = 'deleted')
  `);
  return row?.count ?? 0;
}

export function getEmailsSkippedList(opts: PaginationOptions = {}): {
  contacts: (Contact & { batchFilename?: string })[];
  total: number;
} {
  const db = getDb();
  const search = (opts.search || '').trim().toLowerCase();
  const page = Math.max(1, opts.page || 1);
  const limit = Math.max(1, Math.min(opts.limit || 50, 200));
  const offset = (page - 1) * limit;

  const searchClause = search
    ? sql`AND (LOWER(c.contact_name) LIKE ${`%${search}%`} OR LOWER(c.email) LIKE ${`%${search}%`} OR LOWER(c.company_name) LIKE ${`%${search}%`} OR LOWER(c.relevance_reason) LIKE ${`%${search}%`})`
    : sql``;

  const countRow = db.get<{ count: number }>(sql`
    SELECT COUNT(*) as count
    FROM contacts c
    WHERE c.status = 'skipped'
      AND c.batch_id NOT IN (SELECT id FROM batches WHERE status = 'deleted')
      ${searchClause}
  `);
  const total = countRow?.count ?? 0;

  const rows = db.all<Contact & { batchFilename?: string }>(sql`
    SELECT
      c.id,
      c.batch_id as batchId,
      c.company_name as companyName,
      c.contact_name as contactName,
      c.email,
      c.designation,
      c.company_website as companyWebsite,
      c.company_location as companyLocation,
      c.is_relevant as isRelevant,
      c.relevance_confidence as relevanceConfidence,
      c.relevance_reason as relevanceReason,
      c.is_duplicate as isDuplicate,
      c.email_valid as emailValid,
      c.status,
      c.email_subject as emailSubject,
      c.email_body as emailBody,
      c.email_strategy as emailStrategy,
      c.personalization_points as personalizationPoints,
      c.resume_version as resumeVersion,
      c.generated_at as generatedAt,
      c.gmail_message_id as gmailMessageId,
      c.sent_at as sentAt,
      c.error_message as errorMessage,
      c.send_attempt_count as sendAttemptCount,
      c.generation_status as generationStatus,
      c.generation_attempt_count as generationAttemptCount,
      c.generation_claim_token as generationClaimToken,
      c.generation_lease_expires_at as generationLeaseExpiresAt,
      c.last_generation_error_category as lastGenerationErrorCategory,
      c.next_generation_retry_at as nextGenerationRetryAt,
      c.last_generation_attempt_at as lastGenerationAttemptAt,
      c.created_at as createdAt,
      c.updated_at as updatedAt,
      b.filename as batchFilename
    FROM contacts c
    LEFT JOIN batches b ON c.batch_id = b.id
    WHERE c.status = 'skipped'
      AND c.batch_id NOT IN (SELECT id FROM batches WHERE status = 'deleted')
      ${searchClause}
    ORDER BY c.created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `);

  return {
    contacts: rows.map((r) => ({
      ...r,
      isRelevant: r.isRelevant === null ? null : Boolean(r.isRelevant),
      isDuplicate: Boolean(r.isDuplicate),
      emailValid: Boolean(r.emailValid),
    })),
    total,
  };
}
