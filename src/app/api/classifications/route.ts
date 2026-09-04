import { NextResponse } from 'next/server';
import { getDb } from '@/db';
import { companyClassifications, schedulerState } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { initializeDatabase } from '@/db/migrate';

let initialized = false;
function ensureInitialized() {
  if (!initialized) {
    initializeDatabase();
    initialized = true;
  }
}

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    ensureInitialized();
    const db = getDb();

    const all = db.select().from(companyClassifications).all();
    const scheduler = db.select().from(schedulerState).where(eq(schedulerState.id, 'singleton')).get();

    return NextResponse.json({
      success: true,
      timestamp: new Date().toISOString(),
      data: {
        scheduler,
        totalClassifications: all.length,
        classifications: all,
      },
    }, {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { success: false, error: msg },
      { status: 500 }
    );
  }
}
