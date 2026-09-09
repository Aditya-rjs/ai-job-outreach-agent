import fs from 'fs';
import path from 'path';
import { getDb } from '@/db';
import { contacts, batches, resume, globalEmailHistory, outreachQueue, candidateProfile } from '@/db/schema';
import { eq, sql, and, ne } from 'drizzle-orm';
import { getAuthenticatedGmailClient } from './gmail-client';
import { buildMimeMessage } from './mime-builder';
import { normalizeEmail, isValidEmail } from '@/lib/utils';
import { isEmailInCooldown, getCooldownExpiresAt } from '@/lib/scheduler/time-utils';
import { getResumesDir } from '@/lib/config/paths';
import { markContactStaleResumeForRegeneration } from '@/lib/scheduler/queue-manager';
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

  if (!resumeRecord) {
    throw new Error('No active resume uploaded. Please upload a resume before sending outreach emails.');
  }

  const resumesDir = getResumesDir();
  let candidatePath = resumeRecord.filePath;
  if (!fs.existsSync(candidatePath)) {
    candidatePath = path.join(resumesDir, path.basename(resumeRecord.filePath));
  }

  if (!fs.existsSync(candidatePath)) {
    throw new Error(`Active resume file not found on disk at ${candidatePath}. Please re-upload your resume.`);
  }

  const content = fs.readFileSync(candidatePath);
  const version = resumeRecord.version || resumeRecord.uploadedAt;

  return {
    filename: resumeRecord.filename || 'resume.pdf',
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
    db.delete(outreachQueue).where(eq(outreachQueue.contactId, contactId)).run();
    return { success: false, error: `Contact "${contactId}" not found.`, errorCategory: 'validation' };
  }

  // 1b. Validate parent batch existence and active status
  const parentBatch = db.select().from(batches).where(eq(batches.id, contact.batchId)).get();
  if (!parentBatch) {
    db.delete(outreachQueue).where(eq(outreachQueue.contactId, contact.id)).run();
    return { success: false, error: `Parent batch "${contact.batchId}" not found.`, errorCategory: 'validation' };
  }
  if (parentBatch.status === 'deleted' || parentBatch.status === 'cancelled') {
    db.update(outreachQueue)
      .set({ status: 'cancelled', updatedAt: new Date().toISOString() })
      .where(eq(outreachQueue.contactId, contact.id))
      .run();
    return {
      success: false,
      error: `Parent batch "${parentBatch.filename}" has been ${parentBatch.status}. Outreach send blocked.`,
      errorCategory: 'validation',
    };
  }

  // 2. Validate email format
  const normalizedTo = normalizeEmail(contact.email);
  if (!isValidEmail(normalizedTo)) {
    db.update(contacts)
      .set({ status: 'failed', emailValid: false, errorMessage: `Invalid recipient email address: ${contact.email}`, updatedAt: new Date().toISOString() })
      .where(eq(contacts.id, contact.id))
      .run();
    db.delete(outreachQueue).where(eq(outreachQueue.contactId, contact.id)).run();
    return { success: false, error: `Invalid recipient email address: ${contact.email}`, errorCategory: 'validation' };
  }

  // 3. Relevance check
  if (contact.isRelevant === false) {
    db.update(contacts)
      .set({ status: 'skipped', errorMessage: 'Contact company was marked as non-tech/irrelevant.', updatedAt: new Date().toISOString() })
      .where(eq(contacts.id, contact.id))
      .run();
    db.delete(outreachQueue).where(eq(outreachQueue.contactId, contact.id)).run();
    return { success: false, error: 'Contact company was marked as non-tech/irrelevant.', errorCategory: 'validation' };
  }

  // 4. Sent check on contact record
  if (contact.status === 'sent' || contact.sentAt) {
    db.update(outreachQueue)
      .set({ status: 'completed', updatedAt: new Date().toISOString() })
      .where(eq(outreachQueue.contactId, contact.id))
      .run();
    return { success: false, error: 'This contact has already been sent an outreach email.', errorCategory: 'duplicate' };
  }

  // 5. 6-DAY (144-HOUR) GLOBAL COOLDOWN CHECK:
  // Check global email history to see if this normalized email is in active 144-hour cooldown
  const historyRecord = db.select().from(globalEmailHistory).where(eq(globalEmailHistory.email, normalizedTo)).get();
  if (historyRecord && historyRecord.status === 'sent' && isEmailInCooldown(historyRecord.sentAt)) {
    const expiresAt = getCooldownExpiresAt(historyRecord.sentAt);
    const expiresText = expiresAt ? expiresAt.toISOString() : 'later';
    db.update(contacts)
      .set({
        isDuplicate: true,
        status: 'skipped',
        errorMessage: `Skipped: 6-day cooldown active until ${expiresText}. Last sent: ${historyRecord.sentAt}.`,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(contacts.id, contact.id))
      .run();
    db.delete(outreachQueue).where(eq(outreachQueue.contactId, contact.id)).run();

    return {
      success: false,
      error: `Outreach email was sent to ${normalizedTo} on ${historyRecord.sentAt}. 6-day cooldown active until ${expiresText}.`,
      errorCategory: 'duplicate',
    };
  }

  // 6. Generated email check
  if (!contact.emailSubject || !contact.emailBody) {
    db.update(contacts)
      .set({
        status: 'queued',
        generationStatus: 'PENDING_GENERATION',
        generationAttemptCount: 0,
        errorMessage: 'Personalized email missing. Queued for autonomous generation.',
        updatedAt: new Date().toISOString(),
      })
      .where(eq(contacts.id, contact.id))
      .run();
    db.delete(outreachQueue).where(eq(outreachQueue.contactId, contact.id)).run();
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
    db.update(outreachQueue)
      .set({ status: 'pending', workerId: null, leaseExpiresAt: null, updatedAt: new Date().toISOString() })
      .where(eq(outreachQueue.contactId, contact.id))
      .run();
    return {
      success: false,
      error: resumeErr instanceof Error ? resumeErr.message : 'Resume attachment unavailable.',
      errorCategory: 'validation',
    };
  }

  // 8. Candidate profile & resume version match check
  const profileRecord = db.select({ version: candidateProfile.version }).from(candidateProfile).where(eq(candidateProfile.id, 'singleton')).get();
  const activeProfileVersion = profileRecord?.version || null;
  const activeResumeVersion = resumeAttachment.version || null;

  const isMatch = (activeProfileVersion && contact.resumeVersion === activeProfileVersion) ||
                  (activeResumeVersion && contact.resumeVersion === activeResumeVersion);

  if (contact.resumeVersion && !isMatch) {
    markContactStaleResumeForRegeneration(contact.id);
    return {
      success: false,
      error: 'The active resume was updated after this email was generated. Please regenerate the email before sending to reflect your latest credentials.',
      errorCategory: 'validation',
    };
  }

  // 9. Gmail authentication
  const isDryRun = process.env.OUTREACH_DRY_RUN === 'true';
  const isTestMockSend = process.env.TEST_MOCK_GMAIL_SEND === 'true';
  type GmailAuthResult = NonNullable<Awaited<ReturnType<typeof getAuthenticatedGmailClient>>>;
  let gmailClient: GmailAuthResult | null = null;

  if (isDryRun || isTestMockSend) {
    gmailClient = {
      email: 'authorized_test_user@gmail.com',
      gmail: null as unknown as GmailAuthResult['gmail'],
      oauth2Client: null as unknown as GmailAuthResult['oauth2Client'],
    };
  } else {
    try {
      gmailClient = await getAuthenticatedGmailClient();
    } catch (authErr) {
      db.update(outreachQueue)
        .set({ status: 'pending', workerId: null, leaseExpiresAt: null, updatedAt: new Date().toISOString() })
        .where(eq(outreachQueue.contactId, contact.id))
        .run();
      return {
        success: false,
        error: authErr instanceof Error ? authErr.message : 'Gmail is not connected or authorization expired.',
        errorCategory: 'auth',
      };
    }
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

  // 12. Send via Gmail API (or dry-run / mock simulation)
  try {
    let messageId: string | undefined;

    if (isDryRun) {
      console.log(`[DRY-RUN] Simulating outreach email dispatch to ${contact.email} (no Gmail API call)`);
      messageId = `dryrun_${Date.now()}_${contact.id.slice(0, 8)}`;
    } else if (isTestMockSend) {
      console.log(`[TEST-MOCK] Simulating real Gmail send to ${contact.email} without network dispatch`);
      messageId = `mock_real_msg_${Date.now()}_${contact.id.slice(0, 8)}`;
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

    if (isDryRun) {
      // 13a. Post-Simulation State Transitions (Dry-Run Mode)
      // Contact is marked as simulated (NEVER as sent)
      db.update(contacts)
        .set({
          status: 'simulated',
          sentAt: null,
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

      // A dry-run simulation must NOT be recorded as a permanent successful Gmail contact.
      // Clean up the temporary queued entry so the email remains fully eligible for its first real outreach.
      db.delete(globalEmailHistory)
        .where(
          and(
            eq(globalEmailHistory.email, normalizedTo),
            ne(globalEmailHistory.status, 'sent')
          )
        )
        .run();

      // Update batch counter: emailsSent remains 0 in dry-run; emailsSimulated increments
      db.update(batches)
        .set({
          emailsSimulated: sql`${batches.emailsSimulated} + 1`,
          emailsPending: sql`MAX(0, ${batches.emailsPending} - 1)`,
          updatedAt: sentTimestamp,
        })
        .where(
          and(
            eq(batches.id, contact.batchId),
            sql`status NOT IN ('deleted', 'cancelled')`
          )
        )
        .run();

      console.log(`[DRY-RUN] Outreach simulation complete for ${contact.email} (Simulated ID: ${messageId})`);
      return { success: true, messageId };
    } else {
      // 13b. Post-Send State Transitions (Real Send Mode)
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

      // Record permanent successful Gmail contact in global email history
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

      // Update batch counter: increment real emailsSent
      db.update(batches)
        .set({
          emailsSent: sql`${batches.emailsSent} + 1`,
          emailsPending: sql`MAX(0, ${batches.emailsPending} - 1)`,
          updatedAt: sentTimestamp,
        })
        .where(
          and(
            eq(batches.id, contact.batchId),
            sql`status NOT IN ('deleted', 'cancelled')`
          )
        )
        .run();

      console.log(`[Gmail] Successfully sent email to ${contact.email} (Message ID: ${messageId})`);
      return { success: true, messageId };
    }
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
