import { NextResponse } from 'next/server';
import { initializeDatabase } from '@/db/migrate';
import { stopScheduler, getSchedulerConfig } from '@/lib/db-helpers';
import type { ApiResponse, SchedulerConfig } from '@/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

let initialized = false;
function ensureInitialized() {
  if (!initialized) {
    initializeDatabase();
    initialized = true;
  }
}

export async function POST(): Promise<NextResponse<ApiResponse<SchedulerConfig>>> {
  try {
    ensureInitialized();
    stopScheduler();
    const config = getSchedulerConfig();
    return NextResponse.json(
      { success: true, data: config },
      {
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
          Pragma: 'no-cache',
          Expires: '0',
        },
      }
    );
  } catch (error) {
    console.error('[API Scheduler Stop Error]:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to stop scheduler.' },
      {
        status: 500,
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
          Pragma: 'no-cache',
          Expires: '0',
        },
      }
    );
  }
}
