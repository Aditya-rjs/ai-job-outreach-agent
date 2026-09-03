import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/db';
import { contacts } from '@/db/schema';
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
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse<ApiResponse<{ contacts: Contact[]; total: number }>>> {
  try {
    ensureInitialized();
    const { id } = await params;
    const db = getDb();

    const searchParams = request.nextUrl.searchParams;
    const filter = searchParams.get('filter') || 'all';
    const search = (searchParams.get('search') || '').trim().toLowerCase();
    const limit = parseInt(searchParams.get('limit') || '100', 10);
    const offset = (parseInt(searchParams.get('page') || '1', 10) - 1) * limit;

    const conditions = [eq(contacts.batchId, id)];

    if (filter === 'relevant') {
      conditions.push(sql`${contacts.isRelevant} = 1 AND ${contacts.isDuplicate} = 0 AND ${contacts.emailValid} = 1`);
    } else if (filter === 'irrelevant') {
      conditions.push(sql`${contacts.isRelevant} = 0`);
    } else if (filter === 'duplicate') {
      conditions.push(sql`${contacts.isDuplicate} = 1`);
    } else if (filter === 'invalid') {
      conditions.push(sql`${contacts.emailValid} = 0`);
    } else if (filter === 'queued') {
      conditions.push(eq(contacts.status, 'queued'));
    } else if (filter === 'failed') {
      conditions.push(eq(contacts.status, 'failed'));
    }

    if (search) {
      conditions.push(
        sql`(${contacts.companyName} LIKE ${`%${search}%`} OR ${contacts.contactName} LIKE ${`%${search}%`} OR ${contacts.email} LIKE ${`%${search}%`})`
      );
    }

    const whereClause = and(...conditions);

    const totalCount = db
      .select({ count: sql<number>`count(*)` })
      .from(contacts)
      .where(whereClause)
      .get()?.count ?? 0;

    const records = db
      .select()
      .from(contacts)
      .where(whereClause)
      .orderBy(desc(contacts.createdAt))
      .limit(limit)
      .offset(offset)
      .all();

    return NextResponse.json({
      success: true,
      data: {
        contacts: records as Contact[],
        total: totalCount,
      },
    });
  } catch (error) {
    console.error('Fetch batch contacts error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to retrieve batch contacts.' },
      { status: 500 }
    );
  }
}
