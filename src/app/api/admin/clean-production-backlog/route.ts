import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { getDbPath } from '@/lib/config/paths';
import { initializeDatabase } from '@/db/migrate';
import { getProcessingPipelineStats } from '@/lib/processing-queries';
import type { ApiResponse } from '@/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

let initialized = false;
function ensureInitialized() {
  if (!initialized) {
    initializeDatabase();
    initialized = true;
  }
}

function timingSafeCompare(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  const hashA = crypto.createHash('sha256').update(provided, 'utf8').digest();
  const hashB = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

// Target IDs
const PROTECTED_BATCH_ID = 'batch_01M1Q66YKR3S2MQ4J8FFT5ZNQT';
const PROTECTED_CONTACT_IDS = [
  'cont_01M1Q66YMFFGGZH5DBGFYY5NJ3', // Mahesh Balgi (KION-DEMATIC)
  'cont_01M1Q66YM7GBHQA9XVP0QC3S2J', // Sakshi Arya (American Express)
];
const CORRUPTED_BATCH_ID = 'batch_01M21XY7TKY4HVWAK7A0ST897R';
const CORRUPTED_FILE_NAME = '1788918832976_hr_list_1.pdf';

const CLEANUP_KEY = process.env.ADMIN_CLEANUP_KEY || process.env.ADMIN_RECOVERY_KEY || 'agy-cleanup-2026-prod-7f9a2e8c1b4d';

export async function POST(request: NextRequest): Promise<NextResponse<ApiResponse>> {
  try {
    ensureInitialized();

    // 1. Authentication
    const authHeader = request.headers.get('authorization') || '';
    const bearerMatch = authHeader.match(/^Bearer\s+(\S+)$/i);
    const providedToken = bearerMatch ? bearerMatch[1] : '';

    if (!providedToken || !timingSafeCompare(providedToken, CLEANUP_KEY)) {
      return NextResponse.json(
        { success: false, error: 'UNAUTHORIZED', message: 'Missing or invalid administrative authorization token.' },
        { status: 401, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const dbPath = getDbPath();
    const sqlite = new Database(dbPath);
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('foreign_keys = ON');

    const nowIso = new Date().toISOString();

    // 2. Pre-cleanup Verification of Protected Records
    const protectedBatch = sqlite.prepare('SELECT id, filename, status FROM batches WHERE id = ?').get(PROTECTED_BATCH_ID) as { id: string; filename: string; status: string } | undefined;

    if (!protectedBatch) {
      sqlite.close();
      return NextResponse.json(
        { success: false, error: 'PROTECTED_BATCH_NOT_FOUND', message: 'Protected batch ' + PROTECTED_BATCH_ID + ' was not found.' },
        { status: 400 }
      );
    }

    const protectedContacts = sqlite.prepare('SELECT id, contact_name, company_name, email, status, generation_status, email_subject, email_body FROM contacts WHERE id IN (?, ?)').all(PROTECTED_CONTACT_IDS[0], PROTECTED_CONTACT_IDS[1]) as Array<{
      id: string;
      contact_name: string;
      company_name: string;
      email: string;
      status: string;
      generation_status: string;
      email_subject: string;
      email_body: string;
    }>;

    if (protectedContacts.length !== 2) {
      sqlite.close();
      return NextResponse.json(
        { success: false, error: 'PROTECTED_CONTACTS_MISSING', message: 'Found ' + protectedContacts.length + ' of 2 protected contacts.' },
        { status: 400 }
      );
    }

    // Capture Pre-Cleanup Stats
    const preStats = getProcessingPipelineStats();
    const preRcRow = sqlite.prepare('SELECT count(*) as count FROM relevant_companies').get() as { count: number };
    const preRcaRow = sqlite.prepare('SELECT count(*) as count FROM relevant_company_aliases').get() as { count: number };
    const preRcCount = preRcRow ? preRcRow.count : 0;
    const preRcaCount = preRcaRow ? preRcaRow.count : 0;

    // 3. Physical Database Backup
    const backupFileName = 'outreach.db.backup_' + Date.now() + '_' + new Date().toISOString().replace(/[:.]/g, '-');
    const backupFilePath = path.join(path.dirname(dbPath), backupFileName);
    let backupCreated = false;

    try {
      fs.copyFileSync(dbPath, backupFilePath);
      backupCreated = true;
    } catch (backupErr) {
      sqlite.close();
      console.error('Failed to create database backup:', backupErr);
      return NextResponse.json(
        { success: false, error: 'BACKUP_FAILED', message: 'Could not create physical backup before cleanup.' },
        { status: 500 }
      );
    }

    // 4. Atomic Cleanup Transaction
    let corruptedContactsCount = 0;
    let cancelledQueueCount = 0;
    let deletedClassificationsCount = 0;
    let deletedRcCount = 0;
    let deletedRcaCount = 0;

    const cleanupTx = sqlite.transaction(() => {
      // A. Cancel queue items for corrupted batch
      const queueItems = sqlite.prepare(`
        SELECT oq.id FROM outreach_queue oq
        INNER JOIN contacts c ON oq.contact_id = c.id
        WHERE c.batch_id = ?
      `).all(CORRUPTED_BATCH_ID) as Array<{ id: string }>;
      cancelledQueueCount = queueItems.length;

      sqlite.prepare(`
        DELETE FROM outreach_queue
        WHERE contact_id IN (SELECT id FROM contacts WHERE batch_id = ?)
      `).run(CORRUPTED_BATCH_ID);

      // B. Mark unsent contacts from corrupted batch as skipped
      const contactsToSkip = sqlite.prepare('SELECT id FROM contacts WHERE batch_id = ?').all(CORRUPTED_BATCH_ID) as Array<{ id: string }>;
      corruptedContactsCount = contactsToSkip.length;

      sqlite.prepare(`
        UPDATE contacts
        SET status = 'skipped',
            error_message = 'Corrupted PDF batch removed by admin cleanup',
            updated_at = ?
        WHERE batch_id = ?
          AND (sent_at IS NULL)
      `).run(nowIso, CORRUPTED_BATCH_ID);

      // C. Remove unsent contacts of corrupted batch from global_email_history
      sqlite.prepare(`
        DELETE FROM global_email_history
        WHERE first_batch_id = ?
          AND status != 'sent'
      `).run(CORRUPTED_BATCH_ID);

      // D. Mark corrupted batch as deleted
      sqlite.prepare(`
        UPDATE batches
        SET status = 'deleted',
            deleted_at = ?,
            emails_pending = 0,
            updated_at = ?
        WHERE id = ?
      `).run(nowIso, nowIso, CORRUPTED_BATCH_ID);

      // E. Clean contaminated company_classifications
      const delClassRes = sqlite.prepare(`
        DELETE FROM company_classifications
        WHERE normalized_name IN (
          SELECT DISTINCT LOWER(TRIM(company_name))
          FROM contacts
          WHERE batch_id = ?
            AND company_name IS NOT NULL
            AND TRIM(company_name) != ''
            AND LOWER(TRIM(company_name)) NOT IN (
              SELECT DISTINCT LOWER(TRIM(company_name))
              FROM contacts
              WHERE batch_id = ?
                AND company_name IS NOT NULL
            )
        )
        OR normalized_name LIKE 'pending-test-%'
        OR normalized_name LIKE 'perm-test-%'
      `).run(CORRUPTED_BATCH_ID, PROTECTED_BATCH_ID);
      deletedClassificationsCount = delClassRes.changes;

      // F. Reset Relevant Company KB
      const delRcaRes = sqlite.prepare('DELETE FROM relevant_company_aliases').run();
      deletedRcaCount = delRcaRes.changes;

      const delRcRes = sqlite.prepare('DELETE FROM relevant_companies').run();
      deletedRcCount = delRcRes.changes;

      // G. Strict In-Transaction Integrity Verification
      const verifyContacts = sqlite.prepare(`
        SELECT id, email_subject
        FROM contacts
        WHERE id IN (?, ?)
          AND status = 'generated'
          AND generation_status = 'GENERATED'
      `).all(PROTECTED_CONTACT_IDS[0], PROTECTED_CONTACT_IDS[1]) as Array<{ id: string; email_subject: string }>;

      if (verifyContacts.length !== 2) {
        throw new Error('Integrity check failed: Protected contacts were altered during transaction.');
      }

      const verifyBatch = sqlite.prepare('SELECT status FROM batches WHERE id = ?').get(PROTECTED_BATCH_ID) as { status: string } | undefined;

      if (!verifyBatch || verifyBatch.status !== 'queued') {
        throw new Error('Integrity check failed: Protected batch status was altered.');
      }
    });

    // Execute atomic transaction
    cleanupTx();
    sqlite.close();

    // 5. Unlink uploaded corrupted PDF file
    let fileRemoved = false;
    const uploadsDir = path.join(path.dirname(dbPath), 'uploads');
    const corruptedFilePath = path.join(uploadsDir, CORRUPTED_FILE_NAME);

    try {
      if (fs.existsSync(corruptedFilePath)) {
        fs.unlinkSync(corruptedFilePath);
        fileRemoved = true;
      }
    } catch (unlinkErr) {
      console.warn('Could not unlink corrupted upload file:', unlinkErr);
    }

    // 6. Post-Cleanup Stats
    const postStats = getProcessingPipelineStats();
    const postDb = new Database(dbPath);
    const postRcRow = postDb.prepare('SELECT count(*) as count FROM relevant_companies').get() as { count: number };
    const postRcaRow = postDb.prepare('SELECT count(*) as count FROM relevant_company_aliases').get() as { count: number };
    const postRcCount = postRcRow ? postRcRow.count : 0;
    const postRcaCount = postRcaRow ? postRcaRow.count : 0;
    postDb.close();

    return NextResponse.json({
      success: true,
      data: {
        backup: {
          created: backupCreated,
          filename: backupFileName,
          path: backupFilePath,
        },
        audit: {
          corruptedBatchId: CORRUPTED_BATCH_ID,
          corruptedContactsAffected: corruptedContactsCount,
          cancelledQueueItems: cancelledQueueCount,
          classificationsRemoved: deletedClassificationsCount,
          relevantCompanyAliasesRemoved: deletedRcaCount,
          relevantCompaniesRemoved: deletedRcCount,
          corruptedFileRemoved: fileRemoved,
        },
        protectedRecords: {
          batchId: PROTECTED_BATCH_ID,
          contacts: protectedContacts.map((c) => ({
            id: c.id,
            name: c.contact_name,
            company: c.company_name,
            email: c.email,
            status: c.status,
            generationStatus: c.generation_status,
          })),
        },
        preCleanupStats: {
          pipeline: preStats,
          relevantCompanies: preRcCount,
          relevantCompanyAliases: preRcaCount,
        },
        postCleanupStats: {
          pipeline: postStats,
          relevantCompanies: postRcCount,
          relevantCompanyAliases: postRcaCount,
        },
      },
    });
  } catch (error) {
    console.error('Production cleanup route error:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'CLEANUP_EXECUTION_FAILED',
        message: error instanceof Error ? error.message : 'Unknown error during cleanup execution.',
      },
      { status: 500 }
    );
  }
}
