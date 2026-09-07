import { NextRequest, NextResponse } from 'next/server';
import { initializeDatabase } from '@/db/migrate';
import {
  getProcessingPipelineStats,
  getClassificationPendingList,
  getClassificationRetryWaitingList,
  getCompanyContactsList,
  getEmailGenerationPendingList,
  getGenerationRetryList,
  getGenerationFailedList,
  getReadyToSendList,
} from '@/lib/processing-queries';

let initialized = false;
function ensureInitialized() {
  if (!initialized) {
    initializeDatabase();
    initialized = true;
  }
}

export async function GET(request: NextRequest) {
  try {
    ensureInitialized();

    const { searchParams } = new URL(request.url);

    // Support fetching company contacts directly when expanding a company row
    const companyContactsTarget = searchParams.get('companyContacts');
    if (companyContactsTarget) {
      const contacts = getCompanyContactsList(companyContactsTarget);
      return NextResponse.json(
        { success: true, data: { contacts } },
        { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } }
      );
    }

    const category = searchParams.get('category') || 'classification-pending';
    const search = searchParams.get('search') || '';
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
    const limit = Math.max(1, Math.min(parseInt(searchParams.get('limit') || '25', 10), 200));

    // Always fetch latest counts for all categories
    const stats = getProcessingPipelineStats();

    let records: unknown[] = [];
    let total = 0;

    switch (category) {
      case 'classification-pending': {
        const res = getClassificationPendingList({ search, page, limit });
        records = res.records;
        total = res.total;
        break;
      }
      case 'classification-retry-waiting': {
        const res = getClassificationRetryWaitingList({ search, page, limit });
        records = res.records;
        total = res.total;
        break;
      }
      case 'generation-pending': {
        const res = getEmailGenerationPendingList({ search, page, limit });
        records = res.records;
        total = res.total;
        break;
      }
      case 'generation-retry': {
        const res = getGenerationRetryList({ search, page, limit });
        records = res.records;
        total = res.total;
        break;
      }
      case 'generation-failed': {
        const res = getGenerationFailedList({ search, page, limit });
        records = res.records;
        total = res.total;
        break;
      }
      case 'ready-to-send': {
        const res = getReadyToSendList({ search, page, limit });
        records = res.records;
        total = res.total;
        break;
      }
      default: {
        const res = getClassificationPendingList({ search, page, limit });
        records = res.records;
        total = res.total;
        break;
      }
    }

    const totalPages = Math.max(1, Math.ceil(total / limit));

    return NextResponse.json(
      {
        success: true,
        data: {
          stats,
          category,
          records,
          total,
          page,
          limit,
          totalPages,
          lastUpdated: stats.lastUpdated,
        },
      },
      {
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate',
        },
      }
    );
  } catch (error) {
    console.error('Error fetching processing pipeline data:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch processing pipeline data' },
      { status: 500 }
    );
  }
}
