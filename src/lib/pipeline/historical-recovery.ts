/**
 * Historical 17 Contacts Recovery Engine
 *
 * Implements atomic, single-transaction reset of the exact 17 historical generation failures
 * from GENERATION_FAILED back into PENDING_GENERATION.
 *
 * Strictly adheres to:
 * - 100% pre-condition checking before any mutation
 * - Single SQLite transaction with automatic rollback if affected rows != 17
 * - Idempotency: repeated invocation will safely report already recovered without re-mutating
 * - Zero generation or sending logic
 * - Zero manual outreach_queue insertions
 */

import { getDb } from '@/db';
import { contacts, batches, outreachQueue, globalEmailHistory } from '@/db/schema';
import { inArray, sql } from 'drizzle-orm';
import { isBatchClassificationComplete } from '@/lib/pipeline/classification-reconciler';

export const HISTORICAL_17_TARGET_IDS = [
  'cont_01M1Q66YM4BQQK6MNFSA4FKM08',
  'cont_01M1Q66YM4MT66M540WBAB367F',
  'cont_01M1Q66YM5NHA92YERYA1SYCH8',
  'cont_01M1Q66YM5QR3387X09JGTMWYX',
  'cont_01M1Q66YM64SVHFVCKQNZ63QNJ',
  'cont_01M1Q66YM6SE47RA8V3XJVFE2G',
  'cont_01M1Q66YM77BYQAR0B9GCG97FJ',
  'cont_01M1Q66YM7GBHQA9XVP0QC3S2J',
  'cont_01M1Q66YM7BS91RTR7E8KK46B2',
  'cont_01M1Q66YM82RAFK1AN3B75ZDQP',
  'cont_01M1Q66YM8GFG7GDSGDXF83BGF',
  'cont_01M1Q66YM9R34MNS3ADBVGK8RR',
  'cont_01M1Q66YMBDCPG5B4NS91HA0M4',
  'cont_01M1Q66YMD53H4KZZ5507K14SJ',
  'cont_01M1Q66YMD82Q8VMS3CWP04KKY',
  'cont_01M1Q66YMD29Q3N3HXGERB5ZE8',
  'cont_01M1Q66YMFFGGZH5DBGFYY5NJ3',
] as const;

export interface RecoveryExecutionResult {
  success: boolean;
  operation: 'recover-historical-failures';
  targetCount: number;
  affectedCount: number;
  alreadyRecovered?: boolean;
  message: string;
  error?: string;
  failedPrecondition?: string;
  failedContactId?: string;
}

/**
 * Executes the atomic recovery transaction for the exact 17 historical contacts.
 * Verifies all 17 simultaneously satisfy mandatory preconditions inside the transaction.
 * If any condition fails, rolls back completely and performs 0 mutations.
 */
export function executeHistorical17Recovery(
  customDb?: ReturnType<typeof getDb>,
  targetIdsOverride?: readonly string[]
): RecoveryExecutionResult {
  const db = customDb || getDb();
  const targetIds = targetIdsOverride || HISTORICAL_17_TARGET_IDS;
  const now = new Date();
  const nowIso = now.toISOString();

  try {
    const result = db.transaction((tx) => {
      // 1. Fetch current rows for all target IDs inside the locked transaction
      const targetRows = tx
        .select({
          id: contacts.id,
          batchId: contacts.batchId,
          email: contacts.email,
          status: contacts.status,
          generationStatus: contacts.generationStatus,
          isRelevant: contacts.isRelevant,
          emailValid: contacts.emailValid,
          isDuplicate: contacts.isDuplicate,
          sentAt: contacts.sentAt,
          generationClaimToken: contacts.generationClaimToken,
          generationLeaseExpiresAt: contacts.generationLeaseExpiresAt,
          emailSubject: contacts.emailSubject,
          emailBody: contacts.emailBody,
        })
        .from(contacts)
        .where(inArray(contacts.id, targetIds as unknown as string[]))
        .all();

      // Check for Idempotency: Have all target contacts already been recovered?
      const alreadyRecoveredCount = targetRows.filter(
        (c) =>
          c.generationStatus === 'PENDING_GENERATION' ||
          c.generationStatus === 'GENERATING' ||
          c.generationStatus === 'GENERATED' ||
          c.generationStatus === 'RETRY_PENDING'
      ).length;

      if (targetRows.length === targetIds.length && alreadyRecoveredCount === targetIds.length) {
        return {
          success: true,
          operation: 'recover-historical-failures' as const,
          targetCount: targetIds.length,
          affectedCount: 0,
          alreadyRecovered: true,
          message: 'Historical failure targets have already been recovered and are in the generation pipeline.',
        };
      }

      // Precondition: Exact target count must exist in the database
      if (targetRows.length !== targetIds.length) {
        const foundSet = new Set(targetRows.map((r) => r.id));
        const missing = targetIds.filter((id) => !foundSet.has(id));
        throw new Error(`TARGET_COUNT_MISMATCH: Expected ${targetIds.length} records, found ${targetRows.length}. Missing: ${missing[0] || 'unknown'}`);
      }

      // 2. Fetch associated batches
      const batchIds = Array.from(new Set(targetRows.map((r) => r.batchId)));
      const batchRows = tx
        .select({ id: batches.id, status: batches.status, deletedAt: batches.deletedAt })
        .from(batches)
        .where(inArray(batches.id, batchIds))
        .all();

      const validBatchIds = new Set(
        batchRows
          .filter((b) => b.status !== 'deleted' && b.status !== 'cancelled' && b.status !== 'completed' && !b.deletedAt)
          .map((b) => b.id)
      );

      // 3. Fetch existing outreach_queue records for targets
      const existingQueueRows = tx
        .select({
          id: outreachQueue.id,
          contactId: outreachQueue.contactId,
          status: outreachQueue.status,
          leaseExpiresAt: outreachQueue.leaseExpiresAt,
        })
        .from(outreachQueue)
        .where(inArray(outreachQueue.contactId, targetIds as unknown as string[]))
        .all();

      // STRICT SAFETY GUARD: Abort if ANY target contact has an active in-flight worker send.
      // A queue record is genuinely active strictly when status === 'processing' and has an unexpired lease.
      const activeQueueRow = existingQueueRows.find((q) => {
        if (q.status !== 'processing') return false;
        if (!q.leaseExpiresAt) return false;
        const leaseTime = new Date(q.leaseExpiresAt).getTime();
        return !isNaN(leaseTime) && leaseTime > now.getTime();
      });

      if (activeQueueRow) {
        throw new Error(`PRECONDITION_FAILED:active_outreach_queue_record:${activeQueueRow.contactId}`);
      }

      // 4. Fetch global email history for targets
      const targetEmails = Array.from(
        new Set(targetRows.map((r) => r.email.trim().toLowerCase()))
      );
      const historyRows = tx
        .select({ email: globalEmailHistory.email, status: globalEmailHistory.status })
        .from(globalEmailHistory)
        .where(inArray(globalEmailHistory.email, targetEmails))
        .all();

      const sentEmails = new Set(
        historyRows.filter((h) => h.status === 'sent').map((h) => h.email)
      );

      // 5. Atomic Precondition Validation on each target row
      for (const row of targetRows) {
        if (row.status !== 'failed') {
          throw new Error(`PRECONDITION_FAILED:status_not_failed:${row.id}`);
        }
        if (row.generationStatus !== 'GENERATION_FAILED') {
          throw new Error(`PRECONDITION_FAILED:generation_status_not_generation_failed:${row.id}`);
        }
        if (row.isRelevant !== true) {
          throw new Error(`PRECONDITION_FAILED:contact_not_relevant:${row.id}`);
        }
        if (row.emailValid !== true) {
          throw new Error(`PRECONDITION_FAILED:email_not_valid:${row.id}`);
        }
        if (row.isDuplicate !== false) {
          throw new Error(`PRECONDITION_FAILED:contact_is_duplicate:${row.id}`);
        }
        if (row.sentAt !== null) {
          throw new Error(`PRECONDITION_FAILED:contact_already_sent:${row.id}`);
        }
        if (row.generationClaimToken !== null) {
          throw new Error(`PRECONDITION_FAILED:active_claim_token_present:${row.id}`);
        }
        if (row.generationLeaseExpiresAt !== null) {
          throw new Error(`PRECONDITION_FAILED:active_lease_expires_present:${row.id}`);
        }
        if (row.emailSubject && row.emailSubject.trim().length > 0) {
          throw new Error(`PRECONDITION_FAILED:email_subject_already_present:${row.id}`);
        }
        if (row.emailBody && row.emailBody.trim().length > 0) {
          throw new Error(`PRECONDITION_FAILED:email_body_already_present:${row.id}`);
        }
        if (!validBatchIds.has(row.batchId)) {
          throw new Error(`PRECONDITION_FAILED:parent_batch_invalid_or_deleted:${row.id}`);
        }
        if (!isBatchClassificationComplete(tx as unknown as ReturnType<typeof getDb>, row.batchId)) {
          throw new Error(`PRECONDITION_FAILED:classification_incomplete:${row.batchId}`);
        }
        if (sentEmails.has(row.email.trim().toLowerCase())) {
          throw new Error(`PRECONDITION_FAILED:global_email_history_sent_conflict:${row.id}`);
        }
      }

      // Clean up any existing outreach_queue records strictly for target contacts inside the same transaction
      const queueIdsToDelete = existingQueueRows.map((q) => q.id);
      if (queueIdsToDelete.length > 0) {
        tx.delete(outreachQueue)
          .where(inArray(outreachQueue.id, queueIdsToDelete))
          .run();
      }

      // 6. Execute atomic UPDATE affecting ONLY these exact targets
      const updateResult = tx.run(sql`
        UPDATE contacts
        SET
          status = 'queued',
          generation_status = 'PENDING_GENERATION',
          generation_attempt_count = 0,
          generation_claim_token = NULL,
          generation_lease_expires_at = NULL,
          retry_turn_consumed_ms = 0,
          retry_turn_started_at = NULL,
          retry_queue_enqueued_at = NULL,
          next_generation_retry_at = NULL,
          last_generation_error_category = NULL,
          error_message = NULL,
          email_subject = NULL,
          email_body = NULL,
          resume_version = NULL,
          updated_at = ${nowIso}
        WHERE id IN (${sql.raw(targetIds.map((id) => `'${id}'`).join(', '))})
          AND status = 'failed'
          AND generation_status = 'GENERATION_FAILED'
      `);

      // 7. Strict Row-Count Safety Check: MUST EQUAL EXACTLY targetIds.length
      if (updateResult.changes !== targetIds.length) {
        throw new Error(`ROW_COUNT_MISMATCH: Expected exactly ${targetIds.length} rows updated, but updated ${updateResult.changes}. Rolling back transaction.`);
      }

      return {
        success: true,
        operation: 'recover-historical-failures' as const,
        targetCount: targetIds.length,
        affectedCount: updateResult.changes,
        message: `Successfully reset ${updateResult.changes} historical failed contacts to PENDING_GENERATION.`,
      };
    });

    return result;
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);

    let failedPrecondition: string | undefined;
    let failedContactId: string | undefined;

    if (errorMsg.startsWith('PRECONDITION_FAILED:')) {
      const parts = errorMsg.split(':');
      failedPrecondition = parts[1];
      failedContactId = parts[2];
    } else if (errorMsg.startsWith('TARGET_COUNT_MISMATCH:')) {
      failedPrecondition = 'TARGET_COUNT_MISMATCH';
    } else if (errorMsg.startsWith('ROW_COUNT_MISMATCH:')) {
      failedPrecondition = 'ROW_COUNT_MISMATCH';
    }

    return {
      success: false,
      operation: 'recover-historical-failures',
      targetCount: targetIds.length,
      affectedCount: 0,
      error: failedPrecondition || 'TRANSACTION_ROLLBACK',
      failedPrecondition,
      failedContactId,
      message: `Recovery aborted safely. Zero records updated. Error: ${errorMsg}`,
    };
  }
}
