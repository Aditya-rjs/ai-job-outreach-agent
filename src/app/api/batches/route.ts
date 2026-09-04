import { NextResponse } from 'next/server';
import { getDb } from '@/db';
import { batches } from '@/db/schema';
import { desc, ne } from 'drizzle-orm';
import { initializeDatabase } from '@/db/migrate';
import type { ApiResponse, Batch } from '@/types';

let initialized = false;
function ensureInitialized() {
  if (!initialized) {
    initializeDatabase();
    initialized = true;
  }
}

export async function GET(): Promise<NextResponse<ApiResponse<Batch[]>>> {
  try {
    ensureInitialized();
    const db = getDb();
    const records = db
      .select()
      .from(batches)
      .where(ne(batches.status, 'deleted'))
      .orderBy(desc(batches.uploadDate))
      .all();

    return NextResponse.json({
      success: true,
      data: records as Batch[],
    });
  } catch (error) {
    console.error('Fetch batches error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to retrieve batches.' },
      { status: 500 }
    );
  }
}
