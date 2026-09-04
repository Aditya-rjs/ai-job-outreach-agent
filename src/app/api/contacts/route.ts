import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/db';
import { contacts, batches } from '@/db/schema';
import { eq, and, desc, sql } from 'drizzle-orm';
import { initializeDatabase } from '@/db/migrate';
import type { ApiResponse, Contact } from '@/types';

let initialized = false;
function ensureInitialized() {
  if (!initialized) {
    initializeDatabase();
    initialized = true;
  }
}

export async function GET(
  request: NextRequest
): Promise<NextResponse<ApiResponse<{ contacts: (Contact & { batchFilename?: string })[]; total: number }>>> {
  try {
    ensureInitialized();
    const db = getDb();

    const searchParams = request.nextUrl.searchParams;
    const search = (searchParams.get('search') || '').trim().toLowerCase();
    const status = searchParams.get('status');
    const limit = parseInt(searchParams.get('limit') || '50', 10);
    const page = parseInt(searchParams.get('page') || '1', 10);
    const offset = (page - 1) * limit;

    const conditions = [];

    if (status && status !== 'all') {
      conditions.push(eq(contacts.status, status as Contact['status']));
    }

    if (search) {
      conditions.push(
        sql`(${contacts.companyName} LIKE ${`%${search}%`} OR ${contacts.contactName} LIKE ${`%${search}%`} OR ${contacts.email} LIKE ${`%${search}%`})`
      );
    }

    // Exclude contacts belonging to deleted batches
    conditions.push(
      sql`contacts.batch_id NOT IN (SELECT id FROM batches WHERE status = 'deleted')`
    );

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const totalCount = db
      .select({ count: sql<number>`count(*)` })
      .from(contacts)
      .where(whereClause)
      .get()?.count ?? 0;

    const query = db
      .select({
        id: contacts.id,
        batchId: contacts.batchId,
        companyName: contacts.companyName,
        contactName: contacts.contactName,
        email: contacts.email,
        designation: contacts.designation,
        companyWebsite: contacts.companyWebsite,
        companyLocation: contacts.companyLocation,
        isRelevant: contacts.isRelevant,
        relevanceConfidence: contacts.relevanceConfidence,
        relevanceReason: contacts.relevanceReason,
        isDuplicate: contacts.isDuplicate,
        emailValid: contacts.emailValid,
        status: contacts.status,
        emailSubject: contacts.emailSubject,
        emailBody: contacts.emailBody,
        emailStrategy: contacts.emailStrategy,
        gmailMessageId: contacts.gmailMessageId,
        sentAt: contacts.sentAt,
        errorMessage: contacts.errorMessage,
        sendAttemptCount: contacts.sendAttemptCount,
        createdAt: contacts.createdAt,
        updatedAt: contacts.updatedAt,
        batchFilename: batches.filename,
      })
      .from(contacts)
      .leftJoin(batches, eq(contacts.batchId, batches.id))
      .where(whereClause)
      .orderBy(desc(contacts.createdAt))
      .limit(limit)
      .offset(offset);

    const records = query.all();

    return NextResponse.json({
      success: true,
      data: {
        contacts: records as (Contact & { batchFilename?: string })[],
        total: totalCount,
      },
    });
  } catch (error) {
    console.error('Fetch global contacts error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to retrieve contacts.' },
      { status: 500 }
    );
  }
}
