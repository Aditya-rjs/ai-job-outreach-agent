import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/db';
import { contacts, batches, globalEmailHistory } from '@/db/schema';
import { eq } from 'drizzle-orm';
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
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse<ApiResponse<Contact & { batch?: unknown; globalHistory?: unknown }>>> {
  try {
    ensureInitialized();
    const { id } = await params;
    const db = getDb();

    const contact = db.select().from(contacts).where(eq(contacts.id, id)).get();

    if (!contact) {
      return NextResponse.json(
        { success: false, error: `Contact "${id}" not found.` },
        { status: 404 }
      );
    }

    const batch = db.select().from(batches).where(eq(batches.id, contact.batchId)).get();
    const history = db.select().from(globalEmailHistory).where(eq(globalEmailHistory.email, contact.email)).get();

    return NextResponse.json({
      success: true,
      data: {
        ...contact,
        batch: batch || null,
        globalHistory: history || null,
      } as Contact & { batch?: unknown; globalHistory?: unknown },
    });
  } catch (error) {
    console.error('Fetch contact detail error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to retrieve contact details.' },
      { status: 500 }
    );
  }
}
