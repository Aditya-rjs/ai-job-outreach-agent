import { NextRequest, NextResponse } from 'next/server';
import { initializeDatabase } from '@/db/migrate';
import { getTotalCompaniesList, getRelevantCompaniesList, type CompanyDetailRecord } from '@/lib/dashboard-queries';
import type { ApiResponse } from '@/types';

let initialized = false;
function ensureInitialized() {
  if (!initialized) {
    initializeDatabase();
    initialized = true;
  }
}

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest
): Promise<NextResponse<ApiResponse<{ companies: CompanyDetailRecord[]; total: number }>>> {
  try {
    ensureInitialized();

    const searchParams = request.nextUrl.searchParams;
    const type = searchParams.get('type') || 'all';
    const search = (searchParams.get('search') || '').trim();
    const page = parseInt(searchParams.get('page') || '1', 10);
    const limit = parseInt(searchParams.get('limit') || '50', 10);

    const result = type === 'relevant'
      ? getRelevantCompaniesList({ search, page, limit })
      : getTotalCompaniesList({ search, page, limit });

    return NextResponse.json({
      success: true,
      data: result,
    }, {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      },
    });
  } catch (error) {
    console.error('Dashboard companies API error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch companies' },
      { status: 500 }
    );
  }
}
