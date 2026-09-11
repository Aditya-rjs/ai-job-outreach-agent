import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/db';
import { resume, contacts } from '@/db/schema';
import { eq, sql } from 'drizzle-orm';
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

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse<ApiResponse<Contact>>> {
  try {
    ensureInitialized();
    const { id } = await params;
    const db = getDb();

    // 1. Fetch persistent candidate profile
    const profile = getCandidateProfile(db);
    if (!isCandidateProfileConfigured(profile)) {
      return NextResponse.json(
        { success: false, error: 'No active candidate profile found. Please fill in your profile in Settings first.' },
        { status: 400 }
      );
    }

    const verifiedLinks: VerifiedProfileLinks = {
      linkedin: profile.linkedin || null,
      github: profile.github || null,
      portfolio: profile.portfolio || null,
    };

    // 2. Fetch contact
    const contact = db.select().from(contacts).where(eq(contacts.id, id)).get();
    if (!contact) {
      return NextResponse.json(
        { success: false, error: `Contact "${id}" not found.` },
        { status: 404 }
      );
    }

    if (!isBatchClassificationComplete(db, contact.batchId)) {
      return NextResponse.json(
        {
          success: false,
          error: 'Cannot generate email: company classification is still pending or retrying for this file.',
        },
        { status: 400 }
      );
    }

    if (contact.status === 'skipped' || contact.isDuplicate || contact.isRelevant === false || !contact.emailValid) {
      return NextResponse.json(
        { success: false, error: 'Cannot generate email for an ineligible or skipped contact.' },
        { status: 400 }
      );
    }

    // Optional preferred strategy from request body
    const body = await request.json().catch(() => ({}));
    const preferredStrategy = body.strategy || undefined;

    // Fetch recent email bodies for similarity protection
    const recentEmailRecords = db
      .select({ emailBody: contacts.emailBody })
      .from(contacts)
      .where(sql`${contacts.emailBody} IS NOT NULL AND ${contacts.emailBody} != '' AND ${contacts.id} != ${id}`)
      .limit(30)
      .all();

    const recentEmailBodies: string[] = recentEmailRecords
      .map((r) => r.emailBody)
      .filter((b): b is string => typeof b === 'string' && b.length > 0);

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

    const now = new Date().toISOString();
    const resumeVersion = profile.version;

    db.update(contacts)
      .set({
        emailSubject: result.subject,
        emailBody: result.body,
        emailStrategy: result.strategy,
        personalizationPoints: JSON.stringify(result.personalization_points),
        resumeVersion,
        generatedAt: now,
        status: 'generated',
        errorMessage: null,
        updatedAt: now,
      })
      .where(eq(contacts.id, id))
      .run();

    const updatedContact = db.select().from(contacts).where(eq(contacts.id, id)).get();

    return NextResponse.json({
      success: true,
      data: updatedContact as Contact,
    });
  } catch (error) {
    console.error('Contact regeneration error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Regeneration failed.' },
      { status: 500 }
    );
  }
}
