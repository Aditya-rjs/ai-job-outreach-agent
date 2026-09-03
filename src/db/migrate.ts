import { getDb } from './index';
import { seedDatabase } from './seed';
import { sql } from 'drizzle-orm';

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
      emails_failed INTEGER NOT NULL DEFAULT 0,
      emails_pending INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'processing',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

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
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  db.run(sql`CREATE INDEX IF NOT EXISTS idx_contacts_batch_id ON contacts(batch_id)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_contacts_status ON contacts(status)`);

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
      today_date TEXT,
      last_send_at TEXT,
      next_send_at TEXT,
      timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
      daily_limit INTEGER NOT NULL DEFAULT 30,
      interval_minutes INTEGER NOT NULL DEFAULT 3,
      start_hour INTEGER NOT NULL DEFAULT 10,
      start_minute INTEGER NOT NULL DEFAULT 0
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
    CREATE TABLE IF NOT EXISTS company_classifications (
      normalized_name TEXT PRIMARY KEY,
      company_name TEXT NOT NULL,
      is_relevant INTEGER NOT NULL,
      confidence REAL NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  // Safe ALTER TABLE statements for existing databases
  try { db.run(sql`ALTER TABLE contacts ADD COLUMN resume_version TEXT`); } catch {}
  try { db.run(sql`ALTER TABLE contacts ADD COLUMN personalization_points TEXT`); } catch {}
  try { db.run(sql`ALTER TABLE contacts ADD COLUMN generated_at TEXT`); } catch {}
  try { db.run(sql`ALTER TABLE resume ADD COLUMN version TEXT`); } catch {}
  try { db.run(sql`ALTER TABLE scheduler_state ADD COLUMN worker_id TEXT`); } catch {}
  try { db.run(sql`ALTER TABLE scheduler_state ADD COLUMN locked_until TEXT`); } catch {}
  try { db.run(sql`ALTER TABLE scheduler_state ADD COLUMN last_heartbeat_at TEXT`); } catch {}
  try { db.run(sql`ALTER TABLE scheduler_state ADD COLUMN last_send_attempt_at TEXT`); } catch {}
  try { db.run(sql`ALTER TABLE scheduler_state ADD COLUMN is_stopped INTEGER NOT NULL DEFAULT 0`); } catch {}
  try { db.run(sql`ALTER TABLE outreach_queue ADD COLUMN lease_expires_at TEXT`); } catch {}
  try { db.run(sql`ALTER TABLE outreach_queue ADD COLUMN worker_id TEXT`); } catch {}
  try { db.run(sql`ALTER TABLE outreach_queue ADD COLUMN last_attempt_at TEXT`); } catch {}
  try { db.run(sql`ALTER TABLE outreach_queue ADD COLUMN next_retry_at TEXT`); } catch {}
  try { db.run(sql`ALTER TABLE outreach_queue ADD COLUMN error_message TEXT`); } catch {}

  // Seed default data
  seedDatabase();
}
