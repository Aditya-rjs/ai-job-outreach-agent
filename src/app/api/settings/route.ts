import { NextRequest, NextResponse } from 'next/server';
import { initializeDatabase } from '@/db/migrate';
import { getAppSettings, updateSetting, updateSchedulerConfig } from '@/lib/db-helpers';
import type { ApiResponse, AppSettings, SchedulerConfig } from '@/types';

let initialized = false;
function ensureInitialized() {
  if (!initialized) {
    initializeDatabase();
    initialized = true;
  }
}

export async function GET(): Promise<NextResponse<ApiResponse<AppSettings>>> {
  try {
    ensureInitialized();
    const appSettings = getAppSettings();
    return NextResponse.json({ success: true, data: appSettings });
  } catch (error) {
    console.error('Settings GET error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch settings' },
      { status: 500 }
    );
  }
}

export async function PUT(request: NextRequest): Promise<NextResponse<ApiResponse<AppSettings>>> {
  try {
    ensureInitialized();
    const body = await request.json();

    // Update scheduler config if provided
    if (body.scheduler) {
      const schedulerUpdates: Partial<SchedulerConfig> = {};
      if (body.scheduler.timezone !== undefined) schedulerUpdates.timezone = body.scheduler.timezone;
      if (body.scheduler.dailyLimit !== undefined) schedulerUpdates.dailyLimit = body.scheduler.dailyLimit;
      if (body.scheduler.intervalMinutes !== undefined) schedulerUpdates.intervalMinutes = body.scheduler.intervalMinutes;
      if (body.scheduler.startHour !== undefined) schedulerUpdates.startHour = body.scheduler.startHour;
      if (body.scheduler.startMinute !== undefined) schedulerUpdates.startMinute = body.scheduler.startMinute;
      if (body.scheduler.endHour !== undefined) schedulerUpdates.endHour = body.scheduler.endHour;
      if (body.scheduler.endMinute !== undefined) schedulerUpdates.endMinute = body.scheduler.endMinute;
      if (body.scheduler.isPaused !== undefined) schedulerUpdates.isPaused = body.scheduler.isPaused;
      updateSchedulerConfig(schedulerUpdates);
    }

    // Update individual settings if provided
    if (body.settings && typeof body.settings === 'object') {
      for (const [key, value] of Object.entries(body.settings)) {
        if (typeof value === 'string') {
          updateSetting(key, value);
        }
      }
    }

    // Return updated settings
    const updatedSettings = getAppSettings();
    return NextResponse.json({ success: true, data: updatedSettings });
  } catch (error) {
    console.error('Settings PUT error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to update settings' },
      { status: 500 }
    );
  }
}
