import { NextResponse } from 'next/server';
import { initializeDatabase } from '@/db/migrate';
import { getDashboardStats } from '@/lib/db-helpers';
import type { ApiResponse, DashboardStats } from '@/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Initialize database on first API call
let initialized = false;
function ensureInitialized() {
  if (!initialized) {
    initializeDatabase();
    initialized = true;
  }
}

export async function GET(): Promise<NextResponse<ApiResponse<DashboardStats>>> {
  try {
    ensureInitialized();
    const stats = getDashboardStats();
    return NextResponse.json(
      { success: true, data: stats },
      {
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
          Pragma: 'no-cache',
          Expires: '0',
        },
      }
    );
  } catch (error) {
    console.error('Dashboard API error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch dashboard statistics' },
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
