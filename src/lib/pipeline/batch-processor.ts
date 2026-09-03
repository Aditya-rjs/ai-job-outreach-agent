import { getDb } from '@/db';
import { batches, contacts, globalEmailHistory, outreachQueue } from '@/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { ulid } from 'ulid';
import { parseCSV } from '@/lib/parsers/csv-parser';
import { getFieldMapping, applyFieldMapping, type NormalizedContactRecord } from '@/lib/parsers/field-mapper';
import { parsePdf } from '@/lib/parsers/pdf-parser';
import { classifyCompanies } from '@/lib/ai/company-classifier';
import { normalizeEmail, isValidEmail } from '@/lib/utils';
import { normalizeCompanyName, formatCompanyDisplayName } from '@/lib/utils/company';

export interface BatchProcessingResult {
  batchId: string;
  filename: string;
  totalRecords: number;
  validRecords: number;
  relevantCompanies: number;
  irrelevantCompanies: number;
  duplicateContacts: number;
  invalidEmails: number;
  emailsPending: number;
  status: string;
}

/**
 * Processes an uploaded CSV or PDF file into clean, deduplicated, classified contacts.
 */
export async function processBatchFile(
  fileBuffer: Buffer,
  filename: string
): Promise<BatchProcessingResult> {
  const db = getDb();
  const batchId = `batch_${ulid()}`;
  const now = new Date().toISOString();
  const extension = filename.toLowerCase().slice(filename.lastIndexOf('.'));

  // 1. Create initial batch record
  db.insert(batches)
    .values({
      id: batchId,
      filename,
      uploadDate: now,
      totalRecords: 0,
      validRecords: 0,
      relevantCompanies: 0,
      irrelevantCompanies: 0,
      duplicateContacts: 0,
      invalidEmails: 0,
      emailsSent: 0,
      emailsFailed: 0,
      emailsPending: 0,
      status: 'processing',
      createdAt: now,
      updatedAt: now,
    })
    .run();

  try {
    let rawRecords: NormalizedContactRecord[] = [];

    // 2. Parse file according to format
    if (extension === '.csv') {
      const parsedCsv = parseCSV(fileBuffer);
      if (parsedCsv.rows.length > 0) {
        const mapping = await getFieldMapping(parsedCsv.headers);
        rawRecords = applyFieldMapping(parsedCsv.rows, mapping);
      }
    } else if (extension === '.pdf') {
      rawRecords = await parsePdf(fileBuffer);
    } else {
      throw new Error(`Unsupported file extension: ${extension}`);
    }

    const totalRecords = rawRecords.length;

    // 3. Normalize & validate records
    interface ProcessedCandidate {
      id: string;
      companyName: string;
      normalizedCompany: string;
      contactName: string;
      rawEmail: string;
      email: string;
      emailValid: boolean;
      designation?: string;
      companyWebsite?: string;
      companyLocation?: string;
      isDuplicate: boolean;
      isRelevant: boolean | null;
      relevanceConfidence: number | null;
      relevanceReason: string | null;
      status: 'queued' | 'skipped' | 'discovered';
    }

    const candidates: ProcessedCandidate[] = [];
    const seenEmailsInFile = new Set<string>();
    const validEmailsList: string[] = [];

    let invalidEmailsCount = 0;

    for (const r of rawRecords) {
      const candidateId = `cont_${ulid()}`;
      const rawEmail = (r.email || '').trim();
      const normalizedEmailStr = normalizeEmail(rawEmail);
      const emailValid = Boolean(rawEmail && isValidEmail(normalizedEmailStr));

      if (!emailValid) {
        invalidEmailsCount++;
        candidates.push({
          id: candidateId,
          companyName: formatCompanyDisplayName(r.companyName),
          normalizedCompany: normalizeCompanyName(r.companyName),
          contactName: (r.contactName || '').trim(),
          rawEmail,
          email: normalizedEmailStr || 'invalid-email',
          emailValid: false,
          designation: r.designation?.trim(),
          companyWebsite: r.companyWebsite?.trim(),
          companyLocation: r.companyLocation?.trim(),
          isDuplicate: false,
          isRelevant: null,
          relevanceConfidence: null,
          relevanceReason: 'Invalid email address syntax.',
          status: 'skipped',
        });
        continue;
      }

      // Check duplicate within the same uploaded file
      let isDupInFile = false;
      if (seenEmailsInFile.has(normalizedEmailStr)) {
        isDupInFile = true;
      } else {
        seenEmailsInFile.add(normalizedEmailStr);
        validEmailsList.push(normalizedEmailStr);
      }

      candidates.push({
        id: candidateId,
        companyName: formatCompanyDisplayName(r.companyName),
        normalizedCompany: normalizeCompanyName(r.companyName),
        contactName: (r.contactName || '').trim(),
        rawEmail,
        email: normalizedEmailStr,
        emailValid: true,
        designation: r.designation?.trim(),
        companyWebsite: r.companyWebsite?.trim(),
        companyLocation: r.companyLocation?.trim(),
        isDuplicate: isDupInFile,
        isRelevant: null,
        relevanceConfidence: null,
        relevanceReason: null,
        status: isDupInFile ? 'skipped' : 'discovered',
      });
    }

    // 4. Global deduplication check against global_email_history
    const existingGlobalHistory = new Set<string>();
    if (validEmailsList.length > 0) {
      // Chunk queries if there are many emails
      const CHUNK_SIZE = 500;
      for (let i = 0; i < validEmailsList.length; i += CHUNK_SIZE) {
        const chunk = validEmailsList.slice(i, i + CHUNK_SIZE);
        const records = db
          .select({ email: globalEmailHistory.email, status: globalEmailHistory.status })
          .from(globalEmailHistory)
          .where(inArray(globalEmailHistory.email, chunk))
          .all();

        for (const rec of records) {
          // An email with active status ('queued', 'sending', 'sent') cannot receive another email
          if (rec.status === 'queued' || rec.status === 'sending' || rec.status === 'sent') {
            existingGlobalHistory.add(rec.email);
          }
        }
      }
    }

    let duplicateContactsCount = 0;
    for (const c of candidates) {
      if (!c.emailValid) continue;
      if (c.isDuplicate) {
        duplicateContactsCount++;
        continue;
      }
      if (existingGlobalHistory.has(c.email)) {
        c.isDuplicate = true;
        c.status = 'skipped';
        c.relevanceReason = 'Duplicate: email already queued or contacted in previous outreach.';
        duplicateContactsCount++;
      }
    }

    // 5. Group companies and classify
    const uniqueCompanies = new Map<string, string>();
    for (const c of candidates) {
      if (c.emailValid && !c.isDuplicate && c.normalizedCompany) {
        if (!uniqueCompanies.has(c.normalizedCompany)) {
          uniqueCompanies.set(c.normalizedCompany, c.companyName);
        }
      }
    }

    const companiesToClassify = Array.from(uniqueCompanies.entries()).map(([, rawName]) => ({
      rawName,
    }));

    const classificationMap = await classifyCompanies(companiesToClassify);

    // 6. Assign classification and determine final status
    let relevantCompaniesCount = 0;
    let irrelevantCompaniesCount = 0;
    const classifiedRelevantSet = new Set<string>();
    const classifiedIrrelevantSet = new Set<string>();

    for (const c of candidates) {
      if (!c.emailValid || c.isDuplicate) continue;

      const classification = classificationMap.get(c.normalizedCompany);
      if (classification) {
        c.isRelevant = classification.relevant;
        c.relevanceConfidence = classification.confidence;
        c.relevanceReason = classification.reason;

        if (classification.relevant) {
          c.status = 'queued';
          classifiedRelevantSet.add(c.normalizedCompany);
        } else {
          c.status = 'skipped';
          classifiedIrrelevantSet.add(c.normalizedCompany);
        }
      } else {
        // Safe fallback if company couldn't be classified
        c.isRelevant = false;
        c.relevanceConfidence = 0.5;
        c.relevanceReason = 'Unverified company relevance.';
        c.status = 'skipped';
        classifiedIrrelevantSet.add(c.normalizedCompany);
      }
    }

    relevantCompaniesCount = classifiedRelevantSet.size;
    irrelevantCompaniesCount = classifiedIrrelevantSet.size;

    const queuedContacts = candidates.filter((c) => c.status === 'queued');
    const validRecords = candidates.filter((c) => c.emailValid).length;
    const emailsPending = queuedContacts.length;

    // 7. Atomic Database Insertion Transaction
    db.transaction((tx) => {
      // A. Insert contacts
      for (const c of candidates) {
        tx.insert(contacts)
          .values({
            id: c.id,
            batchId,
            companyName: c.companyName,
            contactName: c.contactName || null,
            email: c.email,
            designation: c.designation || null,
            companyWebsite: c.companyWebsite || null,
            companyLocation: c.companyLocation || null,
            isRelevant: c.isRelevant,
            relevanceConfidence: c.relevanceConfidence,
            relevanceReason: c.relevanceReason,
            isDuplicate: c.isDuplicate,
            emailValid: c.emailValid,
            status: c.status,
            sendAttemptCount: 0,
            createdAt: now,
            updatedAt: now,
          })
          .run();

        // B. Update global_email_history
        if (c.emailValid) {
          if (c.status === 'queued') {
            tx.insert(globalEmailHistory)
              .values({
                email: c.email,
                firstContactId: c.id,
                firstBatchId: batchId,
                firstSeenAt: now,
                status: 'queued',
              })
              .onConflictDoUpdate({
                target: globalEmailHistory.email,
                set: {
                  status: 'queued',
                },
              })
              .run();

            // C. Insert into outreach_queue
            tx.insert(outreachQueue)
              .values({
                id: `queue_${ulid()}`,
                contactId: c.id,
                priority: 0,
                status: 'pending',
                attempts: 0,
                createdAt: now,
                updatedAt: now,
              })
              .run();
          } else if (!c.isDuplicate) {
            // Record discovered email in global history if not yet tracked
            tx.insert(globalEmailHistory)
              .values({
                email: c.email,
                firstContactId: c.id,
                firstBatchId: batchId,
                firstSeenAt: now,
                status: 'discovered',
              })
              .onConflictDoNothing()
              .run();
          }
        }
      }

      // D. Update final batch metrics
      tx.update(batches)
        .set({
          totalRecords,
          validRecords,
          relevantCompanies: relevantCompaniesCount,
          irrelevantCompanies: irrelevantCompaniesCount,
          duplicateContacts: duplicateContactsCount,
          invalidEmails: invalidEmailsCount,
          emailsPending,
          status: emailsPending > 0 ? 'queued' : 'completed',
          updatedAt: new Date().toISOString(),
        })
        .where(eq(batches.id, batchId))
        .run();
    });

    return {
      batchId,
      filename,
      totalRecords,
      validRecords,
      relevantCompanies: relevantCompaniesCount,
      irrelevantCompanies: irrelevantCompaniesCount,
      duplicateContacts: duplicateContactsCount,
      invalidEmails: invalidEmailsCount,
      emailsPending,
      status: emailsPending > 0 ? 'queued' : 'completed',
    };
  } catch (error) {
    console.error(`Batch processing failed for ${filename}:`, error);

    // Mark batch as failed
    db.update(batches)
      .set({
        status: 'failed',
        updatedAt: new Date().toISOString(),
      })
      .where(eq(batches.id, batchId))
      .run();

    throw error;
  }
}
