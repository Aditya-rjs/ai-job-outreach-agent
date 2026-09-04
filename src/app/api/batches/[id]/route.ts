import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/db';
import { batches } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { initializeDatabase } from '@/db/migrate';
import type { ApiResponse, Batch } from '@/types';

let initialized = false;
function ensureInitialized() {
  if (!initialized) {
    initializeDatabase();
    initialized = true;
  }
}

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse<ApiResponse<Batch>>> {
  try {
    ensureInitialized();
    const { id } = await params;
    const db = getDb();
    const record = db.select().from(batches).where(eq(batches.id, id)).get();

    if (!record || record.status === 'deleted') {
      return NextResponse.json(
        { success: false, error: `Batch with ID "${id}" was not found.` },
        {
          status: 404,
          headers: {
            'Cache-Control': 'no-store, no-cache, must-revalidate',
          },
        }
      );
    }

    return NextResponse.json(
      {
        success: true,
        data: record as Batch,
      },
      {
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate',
        },
      }
    );
  } catch (error) {
    console.error('Fetch batch error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to retrieve batch details.' },
      { status: 500 }
    );
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse<ApiResponse<{ message: string; batchId: string }>>> {
  try {
    ensureInitialized();
    const { id } = await params;
    const { deleteBatch } = await import('@/lib/pipeline/batch-manager');
    const result = deleteBatch(id);

    if (!result.success) {
      return NextResponse.json(
        { success: false, error: result.error || 'Failed to delete batch.' },
        { status: (result.statusCode as number) || 400 }
      );
    }

    return NextResponse.json({
      success: true,
      data: {
        message: 'Batch deleted successfully.',
        batchId: result.batchId,
      },
    });
  } catch (error) {
    console.error('Delete batch error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to delete batch.' },
      { status: 500 }
    );
  }
}
