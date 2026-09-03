import { NextResponse } from 'next/server';
import { initializeDatabase } from '@/db/migrate';
import { resumeScheduler, getSchedulerConfig } from '@/lib/db-helpers';
import type { ApiResponse, SchedulerConfig } from '@/types';

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
    resumeScheduler();
    const config = getSchedulerConfig();
    return NextResponse.json({ success: true, data: config });
  } catch (error) {
    console.error('[API Scheduler Resume Error]:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to resume scheduler.' },
      { status: 500 }
    );
  }
}
