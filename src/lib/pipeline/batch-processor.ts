import { getDb } from '@/db';
import { batches, contacts, globalEmailHistory, outreachQueue } from '@/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { ulid } from 'ulid';
import { parseCSV } from '@/lib/parsers/csv-parser';
import { getFieldMapping, applyFieldMapping, type NormalizedContactRecord } from '@/lib/parsers/field-mapper';
import { parsePdf } from '@/lib/parsers/pdf-parser';
import { classifyCompanies } from '@/lib/ai/company-classifier';
import { reconstructCanonicalContacts } from '@/lib/pipeline/canonical-ingestion';

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

    // Reconstruct tabular contact records: forward-fill company context, isolate transitions,
    // and normalize contact identities across all file types
    const canonicalContacts = reconstructCanonicalContacts(rawRecords);
    const totalRecords = canonicalContacts.length;

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
      companyDiagnostic?: string;
      status: 'queued' | 'skipped' | 'discovered';
    }

    const candidates: ProcessedCandidate[] = [];
    const seenEmailsInFile = new Set<string>();
    const validEmailsList: string[] = [];

    let invalidEmailsCount = 0;

    for (const c of canonicalContacts) {
      const candidateId = `cont_${ulid()}`;

      if (!c.emailValid) {
        invalidEmailsCount++;
        candidates.push({
          id: candidateId,
          companyName: c.companyName,
          normalizedCompany: c.normalizedCompany,
          contactName: c.contactName,
          rawEmail: c.rawEmail,
          email: c.email || 'invalid-email',
          emailValid: false,
          designation: c.designation,
          companyWebsite: c.companyWebsite,
          companyLocation: c.companyLocation,
          isDuplicate: false,
          isRelevant: null,
          relevanceConfidence: null,
          relevanceReason: 'Invalid email address syntax.',
          companyDiagnostic: c.companyDiagnostic,
          status: 'skipped',
        });
        continue;
      }

      // Check duplicate within the same uploaded file
      let isDupInFile = false;
      if (seenEmailsInFile.has(c.email)) {
        isDupInFile = true;
      } else {
        seenEmailsInFile.add(c.email);
        validEmailsList.push(c.email);
      }

      candidates.push({
        id: candidateId,
        companyName: c.companyName,
        normalizedCompany: c.normalizedCompany,
        contactName: c.contactName,
        rawEmail: c.rawEmail,
        email: c.email,
        emailValid: true,
        designation: c.designation,
        companyWebsite: c.companyWebsite,
        companyLocation: c.companyLocation,
        isDuplicate: isDupInFile,
        isRelevant: null,
        relevanceConfidence: null,
        relevanceReason: isDupInFile ? 'Duplicate: email already appears in this file.' : null,
        companyDiagnostic: c.companyDiagnostic,
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
    const classifiedUnverifiedSet = new Set<string>();

    for (const c of candidates) {
      if (!c.emailValid || c.isDuplicate) continue;

      const classification = classificationMap.get(c.normalizedCompany);
      if (classification) {
        c.isRelevant = classification.relevant;
        c.relevanceConfidence = classification.confidence;
        c.relevanceReason = classification.reason;

        if (classification.status === 'RELEVANT' || classification.relevant === true) {
          c.status = 'queued';
          classifiedRelevantSet.add(c.normalizedCompany);
        } else if (classification.status === 'IRRELEVANT' || classification.relevant === false) {
          c.status = 'skipped';
          classifiedIrrelevantSet.add(c.normalizedCompany);
        } else {
          // UNVERIFIED / NEEDS_REVIEW: keep isRelevant = null and do not queue
          c.isRelevant = null;
          c.status = 'skipped';
          classifiedUnverifiedSet.add(c.normalizedCompany);
        }
      } else {
        // Safe fallback if company couldn't be classified
        c.isRelevant = null;
        c.relevanceConfidence = 0.0;
        c.relevanceReason = c.companyDiagnostic || 'Unable to verify CS/IT relevance: no classification available.';
        c.status = 'skipped';
        classifiedUnverifiedSet.add(c.normalizedCompany);
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
