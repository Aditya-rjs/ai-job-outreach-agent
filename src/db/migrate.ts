import { getDb } from './index';
import { seedDatabase } from './seed';
import { sql } from 'drizzle-orm';
import { ulid } from 'ulid';

export function initializeDatabase() {
  const db = getDb();

  // Create tables using raw SQL to avoid needing drizzle-kit push at runtime
  db.run(sql`
    CREATE TABLE IF NOT EXISTS batches (
      id TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      upload_date TEXT NOT NULL,
      total_records INTEGER NOT NULL DEFAULT 0,
      valid_records INTEGER NOT NULL DEFAULT 0,
      relevant_companies INTEGER NOT NULL DEFAULT 0,
      irrelevant_companies INTEGER NOT NULL DEFAULT 0,
      duplicate_contacts INTEGER NOT NULL DEFAULT 0,
      invalid_emails INTEGER NOT NULL DEFAULT 0,
      emails_sent INTEGER NOT NULL DEFAULT 0,
      emails_simulated INTEGER NOT NULL DEFAULT 0,
      emails_failed INTEGER NOT NULL DEFAULT 0,
      emails_pending INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'processing',
      file_path TEXT,
      deleted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  // Safe schema migrations for batches table
  try {
    db.run(sql`ALTER TABLE batches ADD COLUMN file_path TEXT`);
  } catch {
    // Column may already exist
  }
  try {
    db.run(sql`ALTER TABLE batches ADD COLUMN deleted_at TEXT`);
  } catch {
    // Column may already exist
  }
  try {
    db.run(sql`ALTER TABLE batches ADD COLUMN emails_simulated INTEGER NOT NULL DEFAULT 0`);
  } catch {
    // Column may already exist
  }

  db.run(sql`
    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
      company_name TEXT,
      contact_name TEXT,
      email TEXT NOT NULL,
      designation TEXT,
      company_website TEXT,
      company_location TEXT,
      is_relevant INTEGER,
      relevance_confidence REAL,
      relevance_reason TEXT,
      is_duplicate INTEGER NOT NULL DEFAULT 0,
      email_valid INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'discovered',
      email_subject TEXT,
      email_body TEXT,
      email_strategy TEXT,
      personalization_points TEXT,
      resume_version TEXT,
      generated_at TEXT,
      gmail_message_id TEXT,
      sent_at TEXT,
      error_message TEXT,
      send_attempt_count INTEGER NOT NULL DEFAULT 0,
      generation_status TEXT,
      generation_attempt_count INTEGER NOT NULL DEFAULT 0,
      generation_claim_token TEXT,
      generation_lease_expires_at TEXT,
      last_generation_error_category TEXT,
      next_generation_retry_at TEXT,
      last_generation_attempt_at TEXT,
      retry_queue_enqueued_at TEXT,
      retry_turn_started_at TEXT,
      retry_turn_consumed_ms INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  // Safe schema migrations for contacts generation fields
  try { db.run(sql`ALTER TABLE contacts ADD COLUMN generation_status TEXT`); } catch {}
  try { db.run(sql`ALTER TABLE contacts ADD COLUMN generation_attempt_count INTEGER NOT NULL DEFAULT 0`); } catch {}
  try { db.run(sql`ALTER TABLE contacts ADD COLUMN generation_claim_token TEXT`); } catch {}
  try { db.run(sql`ALTER TABLE contacts ADD COLUMN generation_lease_expires_at TEXT`); } catch {}
  try { db.run(sql`ALTER TABLE contacts ADD COLUMN last_generation_error_category TEXT`); } catch {}
  try { db.run(sql`ALTER TABLE contacts ADD COLUMN next_generation_retry_at TEXT`); } catch {}
  try { db.run(sql`ALTER TABLE contacts ADD COLUMN last_generation_attempt_at TEXT`); } catch {}
  try { db.run(sql`ALTER TABLE contacts ADD COLUMN retry_queue_enqueued_at TEXT`); } catch {}
  try { db.run(sql`ALTER TABLE contacts ADD COLUMN retry_turn_started_at TEXT`); } catch {}
  try { db.run(sql`ALTER TABLE contacts ADD COLUMN retry_turn_consumed_ms INTEGER NOT NULL DEFAULT 0`); } catch {}

  db.run(sql`CREATE INDEX IF NOT EXISTS idx_contacts_batch_id ON contacts(batch_id)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_contacts_status ON contacts(status)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_contacts_gen_status ON contacts(generation_status)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_contacts_next_gen_retry ON contacts(next_generation_retry_at)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_contacts_retry_queue_enqueued ON contacts(retry_queue_enqueued_at)`);


  // Backfill generation status for existing records
  try {
    db.run(sql`
      UPDATE contacts
      SET generation_status = 'GENERATED'
      WHERE generation_status IS NULL
        AND email_subject IS NOT NULL
        AND email_body IS NOT NULL
    `);
    db.run(sql`
      UPDATE contacts
      SET generation_status = 'PENDING_GENERATION'
      WHERE generation_status IS NULL
        AND is_relevant = 1
        AND email_valid = 1
        AND is_duplicate = 0
        AND sent_at IS NULL
        AND (email_subject IS NULL OR email_body IS NULL)
    `);
  } catch (backfillErr) {
    console.warn('[migrate] Backfill generation status skipped:', backfillErr);
  }


  db.run(sql`
    CREATE TABLE IF NOT EXISTS global_email_history (
      email TEXT PRIMARY KEY,
      first_contact_id TEXT REFERENCES contacts(id),
      first_batch_id TEXT REFERENCES batches(id),
      first_seen_at TEXT NOT NULL,
      sent_at TEXT,
      status TEXT NOT NULL DEFAULT 'discovered'
    )
  `);

  db.run(sql`
    CREATE TABLE IF NOT EXISTS outreach_queue (
      id TEXT PRIMARY KEY,
      contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      priority INTEGER NOT NULL DEFAULT 0,
      scheduled_for TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  db.run(sql`CREATE INDEX IF NOT EXISTS idx_queue_status ON outreach_queue(status)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_queue_priority ON outreach_queue(priority)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_queue_contact_id ON outreach_queue(contact_id)`);

  db.run(sql`
    CREATE TABLE IF NOT EXISTS scheduler_state (
      id TEXT PRIMARY KEY DEFAULT 'singleton',
      is_paused INTEGER NOT NULL DEFAULT 0,
      today_sent_count INTEGER NOT NULL DEFAULT 0,
      today_simulated_count INTEGER NOT NULL DEFAULT 0,
      today_date TEXT,
      last_send_at TEXT,
      next_send_at TEXT,
      timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
      daily_limit INTEGER NOT NULL DEFAULT 30,
      interval_minutes INTEGER NOT NULL DEFAULT 3,
      start_hour INTEGER NOT NULL DEFAULT 10,
      start_minute INTEGER NOT NULL DEFAULT 0,
      end_hour INTEGER NOT NULL DEFAULT 16,
      end_minute INTEGER NOT NULL DEFAULT 0
    )
  `);

  db.run(sql`
    CREATE TABLE IF NOT EXISTS resume (
      id TEXT PRIMARY KEY DEFAULT 'current',
      filename TEXT NOT NULL,
      file_path TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      parsed_text TEXT,
      parsed_data TEXT,
      version TEXT,
      uploaded_at TEXT NOT NULL
    )
  `);

  db.run(sql`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT NOT NULL
    )
  `);

  db.run(sql`
    CREATE TABLE IF NOT EXISTS ai_provider_state (
      id TEXT PRIMARY KEY DEFAULT 'singleton',
      active_provider TEXT NOT NULL DEFAULT 'gemini',
      gemini_cooldown_until TEXT,
      gemini_last_error TEXT,
      openrouter_cooldown_until TEXT,
      openrouter_last_error TEXT,
      total_dispatches INTEGER NOT NULL DEFAULT 0,
      gemini_successes INTEGER NOT NULL DEFAULT 0,
      gemini_failures INTEGER NOT NULL DEFAULT 0,
      gemini_429_count INTEGER NOT NULL DEFAULT 0,
      openrouter_dispatches INTEGER NOT NULL DEFAULT 0,
      openrouter_successes INTEGER NOT NULL DEFAULT 0,
      openrouter_failures INTEGER NOT NULL DEFAULT 0,
      fallback_count INTEGER NOT NULL DEFAULT 0,
      last_fallback_at TEXT,
      updated_at TEXT NOT NULL
    )
  `);

  db.run(sql`
    CREATE TABLE IF NOT EXISTS company_classifications (
      normalized_name TEXT PRIMARY KEY,
      company_name TEXT NOT NULL,
      is_relevant INTEGER,
      confidence REAL,
      reason TEXT NOT NULL,
      classification_source TEXT NOT NULL DEFAULT 'gemini',
      gemini_model TEXT NOT NULL DEFAULT 'gemini-3.8-flash',
      classification_result TEXT NOT NULL DEFAULT 'PENDING',
      retry_count INTEGER NOT NULL DEFAULT 0,
      last_error_category TEXT,
      next_retry_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  db.run(sql`
    CREATE TABLE IF NOT EXISTS relevant_companies (
      id TEXT PRIMARY KEY,
      canonical_name TEXT NOT NULL,
      normalized_canonical_name TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  db.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_relcomp_norm ON relevant_companies(normalized_canonical_name)`);

  db.run(sql`
    CREATE TABLE IF NOT EXISTS relevant_company_aliases (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES relevant_companies(id) ON DELETE CASCADE,
      alias_name TEXT NOT NULL,
      normalized_alias_name TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    )
  `);
  db.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_relcomp_aliases_norm ON relevant_company_aliases(normalized_alias_name)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_relcomp_aliases_comp_id ON relevant_company_aliases(company_id)`);

  // Safe ALTER TABLE statements for existing databases
  try { db.run(sql`ALTER TABLE company_classifications ADD COLUMN classification_source TEXT NOT NULL DEFAULT 'gemini'`); } catch {}
  try { db.run(sql`ALTER TABLE company_classifications ADD COLUMN gemini_model TEXT NOT NULL DEFAULT 'gemini-3.8-flash'`); } catch {}
  try { db.run(sql`ALTER TABLE company_classifications ADD COLUMN classification_result TEXT NOT NULL DEFAULT 'PENDING'`); } catch {}
  try { db.run(sql`ALTER TABLE company_classifications ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0`); } catch {}
  try { db.run(sql`ALTER TABLE company_classifications ADD COLUMN last_error_category TEXT`); } catch {}
  try { db.run(sql`ALTER TABLE company_classifications ADD COLUMN next_retry_at TEXT`); } catch {}
  try { db.run(sql`ALTER TABLE company_classifications ADD COLUMN claim_token TEXT`); } catch {}
  try { db.run(sql`ALTER TABLE company_classifications ADD COLUMN lease_expires_at TEXT`); } catch {}
  try { db.run(sql`ALTER TABLE company_classifications ADD COLUMN retry_round INTEGER NOT NULL DEFAULT 0`); } catch {}

  // Ensure is_relevant and confidence columns allow NULL for PENDING and NEEDS_REVIEW states
  try {
    const tableInfo = db.all(sql`PRAGMA table_info(company_classifications)`) as Array<{ name: string; notnull: number }>;
    const isRelCol = tableInfo.find((c) => c.name === 'is_relevant');
    if (isRelCol && isRelCol.notnull === 1) {
      db.run(sql`
        CREATE TABLE IF NOT EXISTS company_classifications_v2 (
          normalized_name TEXT PRIMARY KEY,
          company_name TEXT NOT NULL,
          is_relevant INTEGER,
          confidence REAL,
          reason TEXT NOT NULL,
          classification_source TEXT NOT NULL DEFAULT 'gemini',
          gemini_model TEXT NOT NULL DEFAULT 'gemini-3.8-flash',
          classification_result TEXT NOT NULL DEFAULT 'PENDING',
          retry_count INTEGER NOT NULL DEFAULT 0,
          last_error_category TEXT,
          next_retry_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);
      db.run(sql`
        INSERT OR IGNORE INTO company_classifications_v2 (
          normalized_name, company_name, is_relevant, confidence, reason,
          classification_source, gemini_model, classification_result,
          retry_count, last_error_category, next_retry_at, created_at, updated_at
        )
        SELECT
          normalized_name, company_name, is_relevant, confidence, reason,
          COALESCE(classification_source, 'gemini'),
          COALESCE(gemini_model, 'gemini-3.8-flash'),
          COALESCE(classification_result, 'PENDING'),
          COALESCE(retry_count, 0),
          last_error_category, next_retry_at, created_at, updated_at
        FROM company_classifications
      `);
      db.run(sql`DROP TABLE company_classifications`);
      db.run(sql`ALTER TABLE company_classifications_v2 RENAME TO company_classifications`);
    }
  } catch (migErr) {
    console.warn('[Migrate] Notice during company_classifications nullability migration:', migErr);
  }

  // Invariant: Gemini is the sole authority for relevance.
  // Invalidate legacy heuristic classifications so Gemini re-evaluates all companies authoritatively.
  try {
    db.run(sql`
      DELETE FROM company_classifications
      WHERE classification_source != 'gemini'
         OR reason LIKE '%heuristic%'
         OR reason LIKE '%Unable to verify%'
    `);
  } catch {}

  try { db.run(sql`ALTER TABLE contacts ADD COLUMN resume_version TEXT`); } catch {}
  try { db.run(sql`ALTER TABLE contacts ADD COLUMN personalization_points TEXT`); } catch {}
  try { db.run(sql`ALTER TABLE contacts ADD COLUMN generated_at TEXT`); } catch {}
  try { db.run(sql`ALTER TABLE resume ADD COLUMN version TEXT`); } catch {}
  try { db.run(sql`ALTER TABLE scheduler_state ADD COLUMN worker_id TEXT`); } catch {}
  try { db.run(sql`ALTER TABLE scheduler_state ADD COLUMN locked_until TEXT`); } catch {}
  try { db.run(sql`ALTER TABLE scheduler_state ADD COLUMN last_heartbeat_at TEXT`); } catch {}
  try { db.run(sql`ALTER TABLE scheduler_state ADD COLUMN last_send_attempt_at TEXT`); } catch {}
  try { db.run(sql`ALTER TABLE scheduler_state ADD COLUMN end_hour INTEGER NOT NULL DEFAULT 16`); } catch {}
  try { db.run(sql`ALTER TABLE scheduler_state ADD COLUMN end_minute INTEGER NOT NULL DEFAULT 0`); } catch {}
  try { db.run(sql`ALTER TABLE scheduler_state ADD COLUMN is_stopped INTEGER NOT NULL DEFAULT 0`); } catch {}
  try { db.run(sql`ALTER TABLE scheduler_state ADD COLUMN today_simulated_count INTEGER NOT NULL DEFAULT 0`); } catch {}
  try { db.run(sql`ALTER TABLE outreach_queue ADD COLUMN lease_expires_at TEXT`); } catch {}
  try { db.run(sql`ALTER TABLE outreach_queue ADD COLUMN worker_id TEXT`); } catch {}
  try { db.run(sql`ALTER TABLE outreach_queue ADD COLUMN last_attempt_at TEXT`); } catch {}
  try { db.run(sql`ALTER TABLE outreach_queue ADD COLUMN next_retry_at TEXT`); } catch {}
  try { db.run(sql`ALTER TABLE outreach_queue ADD COLUMN error_message TEXT`); } catch {}

  // Self-Healing Reconciliation for Global Email History
  // Invariant 1: An email is marked 'sent' in global_email_history ONLY IF there is a genuine successful send in contacts
  // (status = 'sent' with a non-null sent_at timestamp, excluding dry-run simulated sends).
  try {
    db.run(sql`
      DELETE FROM global_email_history
      WHERE status = 'sent'
        AND email NOT IN (
          SELECT DISTINCT LOWER(TRIM(email))
          FROM contacts
          WHERE status = 'sent'
            AND sent_at IS NOT NULL
            AND (gmail_message_id IS NULL OR gmail_message_id NOT LIKE 'dryrun_%')
        )
    `);
  } catch (err) {
    console.error('[Migration] Failed to reconcile global_email_history sent entries:', err);
  }

  // Invariant 2: Remove non-sent ('queued', 'discovered', 'sending') global_email_history records
  // Invariant 2: Remove non-sent ('queued', 'discovered', 'sending') global_email_history records
  // if their contacts only belong to deleted or cancelled batches.
  try {
    db.run(sql`
      DELETE FROM global_email_history
      WHERE status != 'sent'
        AND email NOT IN (
          SELECT DISTINCT LOWER(TRIM(c.email))
          FROM contacts c
          JOIN batches b ON c.batch_id = b.id
          WHERE b.status NOT IN ('deleted', 'cancelled')
            AND c.status IN ('queued', 'generating', 'generated', 'processing')
        )
    `);
  } catch (err) {
    console.error('[Migration] Failed to reconcile global_email_history queued entries:', err);
  }

  // Invariant 3: Reconcile contacts in active batches that were falsely marked as duplicate
  // of previous outreach ("Duplicate: email already queued or contacted in previous outreach.")
  // when that previous outreach was only dry-run simulated or deleted, and no real send exists.
  try {
    const falseDuplicateContacts = db.all<{ id: string; batch_id: string; email: string }>(sql`
      SELECT c.id, c.batch_id, c.email
      FROM contacts c
      JOIN batches b ON c.batch_id = b.id
      WHERE b.status NOT IN ('deleted', 'cancelled')
        AND c.status = 'skipped'
        AND c.is_duplicate = 1
        AND (c.is_relevant = 1 OR c.is_relevant IS NULL)
        AND c.email_valid = 1
        AND c.relevance_reason LIKE 'Duplicate: email already queued or contacted in previous outreach%'
        AND LOWER(TRIM(c.email)) NOT IN (
          SELECT DISTINCT LOWER(TRIM(email))
          FROM contacts
          WHERE status = 'sent'
            AND sent_at IS NOT NULL
            AND (gmail_message_id IS NULL OR gmail_message_id NOT LIKE 'dryrun_%')
        )
    `);

    if (falseDuplicateContacts.length > 0) {
      const now = new Date().toISOString();
      const affectedBatchIds = new Set<string>();

      for (const c of falseDuplicateContacts) {
        affectedBatchIds.add(c.batch_id);

        db.run(sql`
          UPDATE contacts
          SET status = 'queued',
              is_duplicate = 0,
              is_relevant = 1,
              relevance_confidence = COALESCE(relevance_confidence, 0.9),
              relevance_reason = 'Restored: previous outreach was simulated or deleted',
              updated_at = ${now}
          WHERE id = ${c.id}
        `);

        const existingQueue = db.get<{ id: string }>(sql`
          SELECT id FROM outreach_queue WHERE contact_id = ${c.id}
        `);

        if (!existingQueue) {
          const queueId = `queue_${ulid()}`;
          db.run(sql`
            INSERT INTO outreach_queue (id, contact_id, priority, status, attempts, created_at, updated_at)
            VALUES (${queueId}, ${c.id}, 0, 'pending', 0, ${now}, ${now})
          `);
        } else {
          db.run(sql`
            UPDATE outreach_queue
            SET status = 'pending',
                updated_at = ${now}
            WHERE contact_id = ${c.id} AND status != 'completed'
          `);
        }

        db.run(sql`
          INSERT INTO global_email_history (email, first_contact_id, first_batch_id, first_seen_at, status)
          VALUES (${c.email.toLowerCase().trim()}, ${c.id}, ${c.batch_id}, ${now}, 'queued')
          ON CONFLICT(email) DO UPDATE SET status = 'queued', first_contact_id = ${c.id}, first_batch_id = ${c.batch_id}
          WHERE global_email_history.status != 'sent'
        `);
      }

      for (const bId of affectedBatchIds) {
        db.run(sql`
          UPDATE batches
          SET duplicate_contacts = (SELECT COUNT(*) FROM contacts WHERE batch_id = ${bId} AND is_duplicate = 1),
              emails_pending = (SELECT COUNT(*) FROM contacts WHERE batch_id = ${bId} AND status IN ('queued', 'generating', 'generated', 'processing')),
              updated_at = ${now}
          WHERE id = ${bId}
        `);
      }
    }
  } catch (err) {
    console.error('[Migration] Failed to reconcile falsely marked contacts:', err);
  }

  // Seed default data
  seedDatabase();
}
