import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/db';
import { resume, contacts } from '@/db/schema';
import { eq, and, sql, inArray } from 'drizzle-orm';
import { initializeDatabase } from '@/db/migrate';
import { generatePersonalizedEmail } from '@/lib/ai/email-generator';
import { getCandidateProfile, isCandidateProfileConfigured } from '@/lib/candidate-profile/candidate-profile-service';
import { isBatchClassificationComplete } from '@/lib/pipeline/classification-reconciler';
import type { ApiResponse, Contact, VerifiedProfileLinks } from '@/types';

let initialized = false;
function ensureInitialized() {
  if (!initialized) {
    initializeDatabase();
    initialized = true;
  }
}

export async function POST(request: NextRequest): Promise<NextResponse<ApiResponse>> {
  try {
    ensureInitialized();
    const db = getDb();

    // 1. Fetch persistent candidate profile
    const profile = getCandidateProfile(db);
    if (!isCandidateProfileConfigured(profile)) {
      return NextResponse.json(
        {
          success: false,
          error: 'No active candidate profile found. Please fill in your profile in Settings before generating outreach emails.',
        },
        { status: 400 }
      );
    }

    const verifiedLinks: VerifiedProfileLinks = {
      linkedin: profile.linkedin || null,
      github: profile.github || null,
      portfolio: profile.portfolio || null,
    };

    const body = await request.json().catch(() => ({}));
    const { contactId, batchId, forceRegenerate } = body;

    // 2. Select eligible contacts with classification barrier enforcement
    let targetContacts: Contact[] = [];

    if (contactId) {
      const c = db.select().from(contacts).where(eq(contacts.id, contactId)).get();
      if (!c) {
        return NextResponse.json(
          { success: false, error: `Contact "${contactId}" not found.` },
          { status: 404 }
        );
      }
      if (!isBatchClassificationComplete(db, c.batchId)) {
        return NextResponse.json(
          {
            success: false,
            error: 'Cannot generate email: company classification is still pending or retrying for this file.',
          },
          { status: 400 }
        );
      }
      if (c.status === 'skipped' || c.isDuplicate || c.isRelevant !== true || !c.emailValid) {
        return NextResponse.json(
          { success: false, error: 'Cannot generate email for an ineligible, skipped, or unclassified contact.' },
          { status: 400 }
        );
      }
      targetContacts = [c as Contact];
    } else if (batchId) {
      if (!isBatchClassificationComplete(db, batchId)) {
        return NextResponse.json(
          {
            success: false,
            error: 'Cannot generate emails: company classification is still pending or retrying for this file.',
          },
          { status: 400 }
        );
      }
      const allowedStatuses = forceRegenerate ? ['queued', 'generated', 'failed'] : ['queued', 'failed'];
      targetContacts = db
        .select()
        .from(contacts)
        .where(
          and(
            eq(contacts.batchId, batchId),
            inArray(contacts.status, allowedStatuses as Contact['status'][]),
            eq(contacts.emailValid, true),
            eq(contacts.isDuplicate, false),
            eq(contacts.isRelevant, true),
            forceRegenerate ? sql`1=1` : sql`(${contacts.generationStatus} != 'GENERATED' OR ${contacts.generationStatus} IS NULL OR ${contacts.emailSubject} IS NULL)`
          )
        )
        .all() as Contact[];
    } else {
      const allowedStatuses = forceRegenerate ? ['queued', 'generated', 'failed'] : ['queued', 'failed'];
      const rawCandidates = db
        .select()
        .from(contacts)
        .where(
          and(
            inArray(contacts.status, allowedStatuses as Contact['status'][]),
            eq(contacts.emailValid, true),
            eq(contacts.isDuplicate, false),
            eq(contacts.isRelevant, true),
            forceRegenerate ? sql`1=1` : sql`(${contacts.generationStatus} != 'GENERATED' OR ${contacts.generationStatus} IS NULL OR ${contacts.emailSubject} IS NULL)`
          )
        )
        .limit(100)
        .all() as Contact[];

      targetContacts = rawCandidates.filter((c) => isBatchClassificationComplete(db, c.batchId));
    }

    if (targetContacts.length === 0) {
      return NextResponse.json({
        success: true,
        data: {
          message: 'No eligible contacts found requiring AI email generation.',
          totalEligible: 0,
          generatedCount: 0,
          failedCount: 0,
        },
      });
    }

    // 3. Fetch recently generated email bodies to enforce similarity check
    const recentEmailRecords = db
      .select({ emailBody: contacts.emailBody })
      .from(contacts)
      .where(sql`${contacts.emailBody} IS NOT NULL AND ${contacts.emailBody} != ''`)
      .limit(30)
      .all();

    const recentEmailBodies: string[] = recentEmailRecords
      .map((r) => r.emailBody)
      .filter((b): b is string => typeof b === 'string' && b.length > 0);

    let generatedCount = 0;
    let failedCount = 0;
    const resumeVersion = profile.version;

    const strategiesList = [
      'project-focused',
      'company-focused',
      'technical',
      'concise-direct',
      'career-interest-focused',
      'skills-focused',
    ];
    let contactIdx = 0;

    // 4. Generate email for each contact with controlled concurrency
    for (const contact of targetContacts) {
      const preferredStrategy = strategiesList[contactIdx % strategiesList.length];
      contactIdx++;

      const nowIso = new Date().toISOString();

      // Check if currently locked by background worker
      if (
        !forceRegenerate &&
        contact.generationStatus === 'GENERATING' &&
        contact.generationLeaseExpiresAt &&
        contact.generationLeaseExpiresAt > nowIso
      ) {
        continue;
      }

      // Mark as generating with claim token
      const claimToken = `manual_${Math.random().toString(36).substring(2, 9)}`;
      const leaseExpiresAt = new Date(Date.now() + 90000).toISOString();

      db.update(contacts)
        .set({
          status: 'generating',
          generationStatus: 'GENERATING',
          generationClaimToken: claimToken,
          generationLeaseExpiresAt: leaseExpiresAt,
          lastGenerationAttemptAt: nowIso,
          updatedAt: nowIso,
        })
        .where(eq(contacts.id, contact.id))
        .run();

      try {
        const result = await generatePersonalizedEmail({
          profile,
          companyName: contact.companyName || 'the company',
          contactName: contact.contactName,
          designation: contact.designation,
          companyWebsite: contact.companyWebsite,
          companyLocation: contact.companyLocation,
          relevanceReason: contact.relevanceReason,
          recentEmails: recentEmailBodies,
          preferredStrategy,
          verifiedLinks,
        });

        const finishTimestamp = new Date().toISOString();
        db.update(contacts)
          .set({
            emailSubject: result.subject,
            emailBody: result.body,
            emailStrategy: result.strategy,
            personalizationPoints: JSON.stringify(result.personalization_points),
            resumeVersion,
            generatedAt: finishTimestamp,
            generationStatus: 'GENERATED',
            generationClaimToken: null,
            generationLeaseExpiresAt: null,
            status: 'generated',
            errorMessage: null,
            updatedAt: finishTimestamp,
          })
          .where(eq(contacts.id, contact.id))
          .run();

        // Add to recent bodies pool for subsequent similarity checks
        recentEmailBodies.unshift(result.body);
        if (recentEmailBodies.length > 50) recentEmailBodies.pop();

        generatedCount++;
      } catch (genError) {
        console.error(`Email generation failed for contact ${contact.id}:`, genError);
        const errMsg = genError instanceof Error ? genError.message : 'AI generation error';

        db.update(contacts)
          .set({
            status: 'failed',
            generationStatus: 'GENERATION_FAILED',
            generationClaimToken: null,
            generationLeaseExpiresAt: null,
            errorMessage: errMsg,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(contacts.id, contact.id))
          .run();

        failedCount++;
      }
    }

    return NextResponse.json({
      success: true,
      data: {
        totalEligible: targetContacts.length,
        generatedCount,
        failedCount,
        resumeVersion,
      },
    });

  } catch (error) {
    console.error('Batch email generation error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Generation pipeline encountered an error.' },
      { status: 500 }
    );
  }
}
