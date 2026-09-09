import { getDb } from '@/db';
import { batches, contacts, globalEmailHistory, outreachQueue } from '@/db/schema';
import { eq, inArray, and, sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import { parseCSV } from '@/lib/parsers/csv-parser';
import { getFieldMapping, applyFieldMapping, type NormalizedContactRecord } from '@/lib/parsers/field-mapper';
import { parsePdf } from '@/lib/parsers/pdf-parser';
import { classifyCompanies, type CompanyClassificationResult } from '@/lib/ai/company-classifier';
import { reconstructCanonicalContacts } from '@/lib/pipeline/canonical-ingestion';
import { getCooldownCutoffIso } from '@/lib/scheduler/time-utils';
import { searchCompanyDatabaseBatch } from '@/lib/kb/relevant-companies-kb';

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
  filename: string,
  filePath?: string
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
      filePath: filePath || null,
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
      status: 'queued' | 'skipped' | 'discovered' | 'uncertain';
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

    // 4. Global deduplication check against 6-day (144-hour) cooldown and active non-deleted batches
    const existingGlobalHistory = new Set<string>();
    if (validEmailsList.length > 0) {
      // Chunk queries if there are many emails
      const CHUNK_SIZE = 500;
      const cooldownCutoffIso = getCooldownCutoffIso();
      for (let i = 0; i < validEmailsList.length; i += CHUNK_SIZE) {
        const chunk = validEmailsList.slice(i, i + CHUNK_SIZE);

        // A. Confirmed Real Sends within 144-Hour Cooldown:
        const sentRecords = db
          .select({ email: globalEmailHistory.email })
          .from(globalEmailHistory)
          .where(
            and(
              inArray(globalEmailHistory.email, chunk),
              eq(globalEmailHistory.status, 'sent'),
              sql`sent_at IS NOT NULL AND sent_at > ${cooldownCutoffIso}`
            )
          )
          .all();

        for (const rec of sentRecords) {
          existingGlobalHistory.add(rec.email.toLowerCase().trim());
        }

        // B. Active In-Flight Contacts: Check contacts queued in ACTIVE (non-deleted, non-cancelled) batches
        const activeQueued = db
          .select({ email: contacts.email })
          .from(contacts)
          .innerJoin(batches, eq(contacts.batchId, batches.id))
          .where(
            and(
              inArray(contacts.email, chunk),
              sql`batches.status NOT IN ('deleted', 'cancelled')`,
              sql`contacts.status IN ('queued', 'generating', 'generated', 'processing', 'sending')`
            )
          )
          .all();

        for (const rec of activeQueued) {
          existingGlobalHistory.add(rec.email.toLowerCase().trim());
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
        c.relevanceReason = 'Duplicate: email in active 6-day cooldown or currently queued.';
        duplicateContactsCount++;
      }
    }

    // 5. Group companies and collect context for Gemini
    const uniqueCompanies = new Map<string, {
      companyName: string;
      normalizedName: string;
      website?: string;
      location?: string;
      designationContext?: string;
    }>();

    for (const c of candidates) {
      if (c.emailValid && !c.isDuplicate && c.normalizedCompany) {
        if (!uniqueCompanies.has(c.normalizedCompany)) {
          uniqueCompanies.set(c.normalizedCompany, {
            companyName: c.companyName,
            normalizedName: c.normalizedCompany,
            website: c.companyWebsite,
            location: c.companyLocation,
            designationContext: c.designation,
          });
        }
      }
    }

    // 5a. Search Relevant Company Knowledge Base (FOUND / NOT FOUND)
    const distinctRawNames = Array.from(uniqueCompanies.values()).map((u) => u.companyName);
    const kbMatches = searchCompanyDatabaseBatch(distinctRawNames, db);

    const classificationMap = new Map<string, CompanyClassificationResult>();
    const companiesToClassify: (typeof uniqueCompanies extends Map<string, infer V> ? V : never)[] = [];

    for (const company of uniqueCompanies.values()) {
      if (kbMatches.has(company.normalizedName)) {
        const match = kbMatches.get(company.normalizedName)!;
        classificationMap.set(company.normalizedName, {
          companyName: company.companyName,
          normalizedName: company.normalizedName,
          relevant: true,
          confidence: 1.0,
          reason: `Relevant — Known Company Knowledge Base: ${match.canonicalName}`,
          status: 'RELEVANT',
          source: 'gemini',
          geminiModel: 'knowledge-base',
          retryCount: 0,
        });
      } else {
        companiesToClassify.push(company);
      }
    }

    if (companiesToClassify.length > 0) {
      const aiResultsMap = await classifyCompanies(companiesToClassify);
      for (const [norm, res] of aiResultsMap.entries()) {
        classificationMap.set(norm, res);
      }
    }

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

        if (classification.status === 'RELEVANT') {
          c.status = 'queued';
          classifiedRelevantSet.add(c.normalizedCompany);
        } else if (classification.status === 'IRRELEVANT') {
          c.status = 'skipped';
          classifiedIrrelevantSet.add(c.normalizedCompany);
        } else if (classification.status === 'PENDING') {
          c.status = 'uncertain';
          c.isRelevant = null;
        } else {
          // NEEDS_REVIEW or FAILED
          c.status = 'uncertain';
          c.isRelevant = null;
        }
      } else {
        c.isRelevant = null;
        c.relevanceConfidence = null;
        c.relevanceReason = 'Needs Review — Gemini could not confidently determine relevance.';
        c.status = 'uncertain';
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
            generationStatus: c.status === 'queued' ? 'PENDING_GENERATION' : null,
            generationAttemptCount: 0,
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
                  firstContactId: c.id,
                  firstBatchId: batchId,
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

      // D. Update final batch metrics (guarding against revival of deleted/cancelled batch)
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
        .where(
          and(
            eq(batches.id, batchId),
            sql`status NOT IN ('deleted', 'cancelled')`
          )
        )
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

    // Mark batch as failed (only if not already deleted or cancelled)
    db.update(batches)
      .set({
        status: 'failed',
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(batches.id, batchId),
          sql`status NOT IN ('deleted', 'cancelled')`
        )
      )
      .run();

    throw error;
  }
}
