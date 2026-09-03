import { NextResponse } from 'next/server';
import { initializeDatabase } from '@/db/migrate';
import { getSchedulerConfig } from '@/lib/db-helpers';
import type { ApiResponse, SchedulerConfig } from '@/types';

let initialized = false;
function ensureInitialized() {
  if (!initialized) {
    initializeDatabase();
    initialized = true;
  }
}

export async function GET(): Promise<NextResponse<ApiResponse<SchedulerConfig>>> {
  try {
    ensureInitialized();
    const config = getSchedulerConfig();
    return NextResponse.json({ success: true, data: config });
  } catch (error) {
    console.error('[API Scheduler Status Error]:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to retrieve scheduler status.' },
      { status: 500 }
    );
  }
}
