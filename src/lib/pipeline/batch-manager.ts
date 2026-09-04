import fs from 'fs';
import path from 'path';
import { getDb } from '@/db';
import { batches, contacts, outreachQueue, globalEmailHistory } from '@/db/schema';
import { eq, and, ne, inArray } from 'drizzle-orm';
import { getUploadsDir, getResumesDir, getDataDir } from '@/lib/config/paths';

export interface DeleteBatchResult {
  success: boolean;
  batchId: string;
  filename: string;
  contactsAffected: number;
  queuedContactsCancelled: number;
  sentContactsPreserved: number;
  filesRemoved: number;
  error?: string;
  statusCode?: number;
}

/**
 * Safely deletes an uploaded batch:
 * 1. Validates batch existence and status.
 * 2. In an atomic SQLite transaction:
 *    - Cancels/removes pending and processing queue items for this batch's contacts.
 *    - Marks unsent contacts as skipped with 'Batch was deleted by user.'
 *    - Cleans up global_email_history ONLY for unsent contacts (successful-send status 'sent' is permanent).
 *    - Soft-deletes the batch record (status = 'deleted', deleted_at = now, emails_pending = 0).
 * 3. Only AFTER DB transaction commits:
 *    - Safely unlinks the uploaded file from DATA_DIR/uploads/ with strict path traversal prevention.
 * 4. Logs safe audit trail without sensitive credentials.
 */
export function deleteBatch(batchId: string): DeleteBatchResult {
  const db = getDb();

  // 1. Fetch batch record
  const batch = db.select().from(batches).where(eq(batches.id, batchId)).get();
  if (!batch) {
    return {
      success: false,
      batchId,
      filename: '',
      contactsAffected: 0,
      queuedContactsCancelled: 0,
      sentContactsPreserved: 0,
      filesRemoved: 0,
      error: `Batch with ID "${batchId}" was not found.`,
      statusCode: 404,
    };
  }

  if (batch.status === 'deleted') {
    return {
      success: false,
      batchId,
      filename: batch.filename,
      contactsAffected: 0,
      queuedContactsCancelled: 0,
      sentContactsPreserved: 0,
      filesRemoved: 0,
      error: `Batch "${batch.filename}" is already deleted.`,
      statusCode: 400,
    };
  }

  const now = new Date().toISOString();
  let totalContacts = 0;
  let queuedCancelled = 0;
  let sentPreserved = 0;

  // 2. Execute DB deletion / cancellation in an atomic transaction FIRST
  db.transaction((tx) => {
    // A. Query all contacts for this batch
    const batchContacts = tx
      .select({
        id: contacts.id,
        email: contacts.email,
        status: contacts.status,
      })
      .from(contacts)
      .where(eq(contacts.batchId, batchId))
      .all();

    totalContacts = batchContacts.length;
    const contactIds = batchContacts.map((c) => c.id);
    sentPreserved = batchContacts.filter((c) => c.status === 'sent').length;

    // B. Remove all outreach queue records for these contacts
    if (contactIds.length > 0) {
      const queueItems = tx
        .select({ id: outreachQueue.id, status: outreachQueue.status })
        .from(outreachQueue)
        .where(inArray(outreachQueue.contactId, contactIds))
        .all();

      queuedCancelled = queueItems.length;

      tx.delete(outreachQueue)
        .where(inArray(outreachQueue.contactId, contactIds))
        .run();
    }

    // C. Update unsent contacts to skipped status
    tx.update(contacts)
      .set({
        status: 'skipped',
        errorMessage: 'Batch was deleted by user.',
        updatedAt: now,
      })
      .where(
        and(
          eq(contacts.batchId, batchId),
          ne(contacts.status, 'sent')
        )
      )
      .run();

    // D. Global Email History:
    // Successful-send status ('sent') determines permanent history.
    // If a contact's email in global_email_history has status = 'sent', it is preserved forever.
    // Any record in global_email_history that was never sent (status != 'sent') is cleaned up.
    const batchEmails = Array.from(
      new Set(batchContacts.map((c) => c.email.trim().toLowerCase()))
    );

    // Delete records from global_email_history that belong to this batch or this batch's contacts
    // where status is NOT 'sent'
    tx.delete(globalEmailHistory)
      .where(
        and(
          eq(globalEmailHistory.firstBatchId, batchId),
          ne(globalEmailHistory.status, 'sent')
        )
      )
      .run();

    if (batchEmails.length > 0) {
      const CHUNK_SIZE = 500;
      for (let i = 0; i < batchEmails.length; i += CHUNK_SIZE) {
        const chunk = batchEmails.slice(i, i + CHUNK_SIZE);
        tx.delete(globalEmailHistory)
          .where(
            and(
              inArray(globalEmailHistory.email, chunk),
              ne(globalEmailHistory.status, 'sent')
            )
          )
          .run();
      }
    }

    // E. Transition batch to soft-deleted state
    tx.update(batches)
      .set({
        status: 'deleted',
        deletedAt: now,
        emailsPending: 0,
        updatedAt: now,
      })
      .where(eq(batches.id, batchId))
      .run();
  });

  // 3. Physical file cleanup: executed strictly AFTER DB transaction has committed
  let filesRemoved = 0;
  const uploadsDir = path.resolve(getUploadsDir());
  const resumesDir = path.resolve(getResumesDir());
  const dataDir = path.resolve(getDataDir());

  const candidateFilePaths: string[] = [];
  if (batch.filePath) {
    candidateFilePaths.push(batch.filePath);
  }

  // Also check uploads directory for any file associated with this batch if filePath was not explicitly set
  try {
    if (fs.existsSync(uploadsDir)) {
      const files = fs.readdirSync(uploadsDir);
      for (const f of files) {
        // Match timestamps + filename (e.g. 1741123456_mycontacts.csv)
        if (f.endsWith(`_${batch.filename}`) || f === batch.filename) {
          candidateFilePaths.push(path.join(uploadsDir, f));
        }
      }
    }
  } catch (dirErr) {
    console.warn(`[Batch Deletion] Warning scanning uploads dir:`, dirErr);
  }

  for (const rawPath of candidateFilePaths) {
    try {
      const resolved = path.resolve(rawPath);

      // Strict Path Traversal and Safety Validation:
      // Must be inside uploadsDir, must not equal uploadsDir, resumesDir, or dataDir root
      const isInsideUploads = resolved.startsWith(uploadsDir) && resolved.length > uploadsDir.length;
      const isInsideResumes = resolved.startsWith(resumesDir);
      const isExactDataDir = resolved === dataDir;

      if (!isInsideUploads || isInsideResumes || isExactDataDir) {
        console.warn(`[Batch Deletion] Security alert: rejected file deletion outside uploads directory: "${rawPath}" (resolved: "${resolved}")`);
        continue;
      }

      if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
        fs.unlinkSync(resolved);
        filesRemoved++;
        console.log(`[Batch Deletion] Removed uploaded file: ${resolved}`);
      }
    } catch (fileErr) {
      console.error(`[Batch Deletion] Error removing file "${rawPath}":`, fileErr);
    }
  }

  // 4. Safe Audit Logging (No secrets or candidate PII)
  console.log('[Batch Deletion] Audit Log:', JSON.stringify({
    action: 'BATCH_DELETED',
    batchId,
    filename: batch.filename,
    timestamp: now,
    contactsAffected: totalContacts,
    queuedContactsCancelled: queuedCancelled,
    sentContactsPreserved: sentPreserved,
    filesRemoved,
  }));

  return {
    success: true,
    batchId,
    filename: batch.filename,
    contactsAffected: totalContacts,
    queuedContactsCancelled: queuedCancelled,
    sentContactsPreserved: sentPreserved,
    filesRemoved,
    statusCode: 200,
  };
}
