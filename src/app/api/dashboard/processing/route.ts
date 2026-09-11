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
  getCompaniesFoundList,
  getDuplicateCompaniesList,
  getAiProcessedList,
  getIrrelevantCompaniesList,
  getCsItRelevantList,
  getContactsFoundList,
  getDuplicateContactsList,
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

    const batchIdParam = searchParams.get('batchId') || undefined;

    // Always fetch latest counts for all categories
    const stats = getProcessingPipelineStats(batchIdParam);
    const currentBatchId = stats.currentBatchId || undefined;

    // Support fetching company contacts directly when expanding a company row
    const companyContactsTarget = searchParams.get('companyContacts');
    if (companyContactsTarget) {
      const contacts = currentBatchId
        ? getCompanyContactsList(companyContactsTarget, currentBatchId)
        : [];
      return NextResponse.json(
        { success: true, data: { contacts } },
        { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } }
      );
    }

    const category = searchParams.get('category') || 'companies-found';
    const search = searchParams.get('search') || '';
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
    const limit = Math.max(1, Math.min(parseInt(searchParams.get('limit') || '25', 10), 200));

    let records: unknown[] = [];
    let total = 0;

    if (currentBatchId) {
      const options = { batchId: currentBatchId, search, page, limit };
      switch (category) {
        case 'companies-found': {
          const res = getCompaniesFoundList(options);
          records = res.records;
          total = res.total;
          break;
        }
        case 'duplicate-companies': {
          const res = getDuplicateCompaniesList(options);
          records = res.records;
          total = res.total;
          break;
        }
        case 'classification-pending': {
          const res = getClassificationPendingList(options);
          records = res.records;
          total = res.total;
          break;
        }
        case 'classification-retry-waiting': {
          const res = getClassificationRetryWaitingList(options);
          records = res.records;
          total = res.total;
          break;
        }
        case 'ai-processed': {
          const res = getAiProcessedList(options);
          records = res.records;
          total = res.total;
          break;
        }
        case 'irrelevant-companies': {
          const res = getIrrelevantCompaniesList(options);
          records = res.records;
          total = res.total;
          break;
        }
        case 'cs-it-relevant': {
          const res = getCsItRelevantList(options);
          records = res.records;
          total = res.total;
          break;
        }
        case 'contacts-found': {
          const res = getContactsFoundList(options);
          records = res.records;
          total = res.total;
          break;
        }
        case 'duplicate-contacts': {
          const res = getDuplicateContactsList(options);
          records = res.records;
          total = res.total;
          break;
        }
        case 'generation-pending': {
          const res = getEmailGenerationPendingList(options);
          records = res.records;
          total = res.total;
          break;
        }
        case 'generation-retry': {
          const res = getGenerationRetryList(options);
          records = res.records;
          total = res.total;
          break;
        }
        case 'generation-failed': {
          const res = getGenerationFailedList(options);
          records = res.records;
          total = res.total;
          break;
        }
        case 'ready-to-send': {
          const res = getReadyToSendList(options);
          records = res.records;
          total = res.total;
          break;
        }
        default: {
          const res = getCompaniesFoundList(options);
          records = res.records;
          total = res.total;
          break;
        }
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
