import fs from 'fs';
import path from 'path';
import { getDb } from '@/db';
import { contacts, batches, resume, globalEmailHistory, outreachQueue } from '@/db/schema';
import { eq, sql } from 'drizzle-orm';
import { getAuthenticatedGmailClient } from './gmail-client';
import { buildMimeMessage } from './mime-builder';
import { normalizeEmail, isValidEmail } from '@/lib/utils';
import { getResumesDir } from '@/lib/config/paths';
import type { Contact } from '@/types';

export interface SendResult {
  success: boolean;
  messageId?: string;
  error?: string;
  errorCategory?: 'validation' | 'auth' | 'network' | 'duplicate' | 'quota' | 'uncertain';
}

/**
 * Validates whether the active resume exists and is ready for attachment.
 */
function getActiveResumeAttachment(): {
  filename: string;
  content: Buffer;
  version: string;
} {
  const db = getDb();
  const resumeRecord = db.select().from(resume).where(eq(resume.id, 'current')).get();

  if (!resumeRecord || !resumeRecord.filePath) {
    throw new Error('Cannot send email because no active resume is available. Please upload a resume in Settings.');
  }

  let resolvedFilePath = resumeRecord.filePath;
  if (!fs.existsSync(resolvedFilePath)) {
    // Fallback: check if the file exists under the current resumesDir (e.g. if DATA_DIR changed or migrated to Railway volume)
    const fallbackPath = path.join(getResumesDir(), path.basename(resumeRecord.filePath));
    if (fs.existsSync(fallbackPath)) {
      resolvedFilePath = fallbackPath;
    } else {
      throw new Error(`Resume file not found on disk at ${resumeRecord.filePath} (or ${fallbackPath}). Please re-upload your resume.`);
    }
  }

  const content = fs.readFileSync(resolvedFilePath);
  if (!content || content.length === 0) {
    throw new Error('Active resume file is empty.');
  }

  const version = resumeRecord.version || resumeRecord.uploadedAt;
  return {
    filename: resumeRecord.filename || 'Resume.pdf',
    content,
    version,
  };
}

/**
 * Sends a single outreach email for a contact through Gmail OAuth with strict safety validation.
 */
export async function sendOutreachEmail(contactId: string): Promise<SendResult> {
  const db = getDb();

  // 1. Fetch Contact
  const contact = db.select().from(contacts).where(eq(contacts.id, contactId)).get() as Contact | undefined;
  if (!contact) {
    return { success: false, error: `Contact "${contactId}" not found.`, errorCategory: 'validation' };
  }

  // 1b. Validate parent batch existence and active status
  const parentBatch = db.select().from(batches).where(eq(batches.id, contact.batchId)).get();
  if (!parentBatch) {
    return { success: false, error: `Parent batch "${contact.batchId}" not found.`, errorCategory: 'validation' };
  }
  if (parentBatch.status === 'deleted' || parentBatch.status === 'cancelled') {
    return {
      success: false,
      error: `Parent batch "${parentBatch.filename}" has been ${parentBatch.status}. Outreach send blocked.`,
      errorCategory: 'validation',
    };
  }

  // 2. Validate email format
  const normalizedTo = normalizeEmail(contact.email);
  if (!isValidEmail(normalizedTo)) {
    return { success: false, error: `Invalid recipient email address: ${contact.email}`, errorCategory: 'validation' };
  }

  // 3. Relevance check
  if (contact.isRelevant === false) {
    return { success: false, error: 'Contact company was marked as non-tech/irrelevant.', errorCategory: 'validation' };
  }

  // 4. Sent check on contact record
  if (contact.status === 'sent' || contact.sentAt) {
    return { success: false, error: 'This contact has already been sent an outreach email.', errorCategory: 'duplicate' };
  }

  // 5. CRITICAL DUPLICATE CHECK (Requirement 16):
  // Check global email history to guarantee this normalized email has NEVER been sent to before
  const historyRecord = db.select().from(globalEmailHistory).where(eq(globalEmailHistory.email, normalizedTo)).get();
  if (historyRecord && (historyRecord.status === 'sent' || historyRecord.sentAt)) {
    db.update(contacts)
      .set({
        isDuplicate: true,
        status: 'skipped',
        errorMessage: 'Skipped: email was already sent in another batch.',
        updatedAt: new Date().toISOString(),
      })
      .where(eq(contacts.id, contact.id))
      .run();

    return {
      success: false,
      error: `Outreach email was already sent to ${normalizedTo} on ${historyRecord.sentAt}. Duplicate send blocked.`,
      errorCategory: 'duplicate',
    };
  }

  // 6. Generated email check
  if (!contact.emailSubject || !contact.emailBody) {
    return {
      success: false,
      error: 'No personalized email has been generated for this contact yet. Please generate the email first.',
      errorCategory: 'validation',
    };
  }

  // 7. Active resume verification
  let resumeAttachment;
  try {
    resumeAttachment = getActiveResumeAttachment();
  } catch (resumeErr) {
    return {
      success: false,
      error: resumeErr instanceof Error ? resumeErr.message : 'Resume attachment unavailable.',
      errorCategory: 'validation',
    };
  }

  // 8. Resume version match check (Requirement 13)
  if (contact.resumeVersion && contact.resumeVersion !== resumeAttachment.version) {
    return {
      success: false,
      error: 'The active resume was updated after this email was generated. Please regenerate the email before sending to reflect your latest credentials.',
      errorCategory: 'validation',
    };
  }

  // 9. Gmail authentication
  let gmailClient;
  try {
    gmailClient = await getAuthenticatedGmailClient();
  } catch (authErr) {
    return {
      success: false,
      error: authErr instanceof Error ? authErr.message : 'Gmail is not connected or authorization expired.',
      errorCategory: 'auth',
    };
  }

  // 10. Pre-send State Transition (contact -> sending, queue -> processing)
  const now = new Date().toISOString();
  db.update(contacts)
    .set({
      status: 'sending',
      sendAttemptCount: (contact.sendAttemptCount || 0) + 1,
      updatedAt: now,
    })
    .where(eq(contacts.id, contact.id))
    .run();

  db.update(outreachQueue)
    .set({
      status: 'processing',
      attempts: sql`${outreachQueue.attempts} + 1`,
      updatedAt: now,
    })
    .where(eq(outreachQueue.contactId, contact.id))
    .run();

  // 11. Build MIME Message
  const senderEmail = gmailClient.email !== 'me' && gmailClient.email ? gmailClient.email : 'me';
  const fromHeader = `Aditya Raj Singh <${senderEmail}>`;

  const rawMime = buildMimeMessage({
    from: fromHeader,
    to: contact.email,
    subject: contact.emailSubject,
    bodyText: contact.emailBody,
    attachment: {
      filename: resumeAttachment.filename,
      contentType: 'application/pdf',
      content: resumeAttachment.content,
    },
  });

  // 12. Send via Gmail API (or dry-run simulation)
  const isDryRun = process.env.OUTREACH_DRY_RUN === 'true';

  try {
    let messageId: string | undefined;

    if (isDryRun) {
      console.log(`[DRY-RUN] Simulating outreach email dispatch to ${contact.email} (no Gmail API call)`);
      messageId = `dryrun_${Date.now()}_${contact.id.slice(0, 8)}`;
    } else {
      const sendResponse = await gmailClient.gmail.users.messages.send({
        userId: 'me',
        requestBody: {
          raw: rawMime,
        },
      });
      messageId = sendResponse.data.id || undefined;
    }

    const sentTimestamp = new Date().toISOString();

    // 13. Post-Send Transactional State Transitions
    db.update(contacts)
      .set({
        status: 'sent',
        sentAt: sentTimestamp,
        gmailMessageId: messageId || null,
        errorMessage: null,
        updatedAt: sentTimestamp,
      })
      .where(eq(contacts.id, contact.id))
      .run();

    db.update(outreachQueue)
      .set({
        status: 'completed',
        lastAttemptAt: sentTimestamp,
        updatedAt: sentTimestamp,
      })
      .where(eq(outreachQueue.contactId, contact.id))
      .run();

    // Record in global email history (permanent lock on this email)
    db.insert(globalEmailHistory)
      .values({
        email: normalizedTo,
        firstContactId: contact.id,
        firstBatchId: contact.batchId,
        firstSeenAt: contact.createdAt,
        sentAt: sentTimestamp,
        status: 'sent',
      })
      .onConflictDoUpdate({
        target: globalEmailHistory.email,
        set: {
          sentAt: sentTimestamp,
          status: 'sent',
        },
      })
      .run();

    // Update batch counter
    db.update(batches)
      .set({
        emailsSent: sql`${batches.emailsSent} + 1`,
        emailsPending: sql`MAX(0, ${batches.emailsPending} - 1)`,
        updatedAt: sentTimestamp,
      })
      .where(eq(batches.id, contact.batchId))
      .run();

    console.log(`[Gmail] Successfully sent email to ${contact.email} (Message ID: ${messageId})`);
    return { success: true, messageId };
  } catch (apiErr) {
    console.error(`[Gmail] API send error for contact ${contact.id}:`, apiErr);

    const errorMessage = apiErr instanceof Error ? apiErr.message : 'Unknown Gmail API error';
    const isAuthError = errorMessage.includes('invalid_grant') || errorMessage.includes('401') || errorMessage.includes('unauthorized');

    // Detect uncertain errors where network dropped after request was sent
    const isUncertain =
      errorMessage.includes('ETIMEDOUT') ||
      errorMessage.includes('ECONNRESET') ||
      errorMessage.includes('socket hang up') ||
      errorMessage.toLowerCase().includes('timeout');

    const errorTimestamp = new Date().toISOString();
    const finalStatus = isUncertain ? 'uncertain' : 'failed';

    db.update(contacts)
      .set({
        status: finalStatus,
        errorMessage: isUncertain ? `Uncertain delivery: ${errorMessage}. Marked as uncertain to prevent duplicate send.` : errorMessage,
        updatedAt: errorTimestamp,
      })
      .where(eq(contacts.id, contact.id))
      .run();

    db.update(outreachQueue)
      .set({
        status: finalStatus,
        lastAttemptAt: errorTimestamp,
        errorMessage,
        updatedAt: errorTimestamp,
      })
      .where(eq(outreachQueue.contactId, contact.id))
      .run();

    return {
      success: false,
      error: errorMessage,
      errorCategory: isUncertain ? 'uncertain' : isAuthError ? 'auth' : 'network',
    };
  }
}

/**
 * Sends a controlled test email to verify Gmail credentials and resume attachment.
 * Does NOT touch outreach_queue, does NOT consume daily outreach quota, does NOT affect contacts history.
 */
export async function sendTestEmail(recipient: string): Promise<SendResult> {
  const normalized = normalizeEmail(recipient);
  if (!isValidEmail(normalized)) {
    return { success: false, error: `Invalid test email address: ${recipient}`, errorCategory: 'validation' };
  }

  let gmailClient;
  try {
    gmailClient = await getAuthenticatedGmailClient();
  } catch (authErr) {
    return {
      success: false,
      error: authErr instanceof Error ? authErr.message : 'Gmail is not connected.',
      errorCategory: 'auth',
    };
  }

  let resumeAttachment;
  try {
    resumeAttachment = getActiveResumeAttachment();
  } catch (resumeErr) {
    return {
      success: false,
      error: resumeErr instanceof Error ? resumeErr.message : 'Resume attachment unavailable for test send.',
      errorCategory: 'validation',
    };
  }

  const senderEmail = gmailClient.email !== 'me' && gmailClient.email ? gmailClient.email : 'me';
  const fromHeader = `AI Outreach Agent <${senderEmail}>`;
  const subject = 'AI Job Outreach Agent — Gmail Integration Test';
  const bodyText = `Hello,

This is a test email sent by your AI Job Outreach Agent to verify Gmail OAuth connectivity and resume attachment functionality.

Details:
• Sender Account: ${senderEmail}
• Recipient: ${recipient}
• Timestamp: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} (IST)
• Attached Resume: ${resumeAttachment.filename} (Version: ${resumeAttachment.version})

Note:
This message is an administrative test. It is not recorded in outreach history and does not consume your daily sending quota.

Best regards,
AI Job Outreach Agent`;

  const rawMime = buildMimeMessage({
    from: fromHeader,
    to: recipient,
    subject,
    bodyText,
    attachment: {
      filename: resumeAttachment.filename,
      contentType: 'application/pdf',
      content: resumeAttachment.content,
    },
  });

  try {
    console.log(`[Gmail] Dispatching test email to ${recipient}...`);
    const sendResponse = await gmailClient.gmail.users.messages.send({
      userId: 'me',
      requestBody: {
        raw: rawMime,
      },
    });

    const messageId = sendResponse.data.id || undefined;
    console.log(`[Gmail] Test email sent successfully! Message ID: ${messageId}`);
    return { success: true, messageId };
  } catch (err) {
    console.error('[Gmail] Test send failed:', err);
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to send test email through Gmail.',
      errorCategory: 'network',
    };
  }
}
