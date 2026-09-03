import { NextResponse } from 'next/server';
import { initializeDatabase } from '@/db/migrate';
import { getDashboardStats } from '@/lib/db-helpers';
import type { ApiResponse, DashboardStats } from '@/types';

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
    return NextResponse.json({ success: true, data: stats });
  } catch (error) {
    console.error('Dashboard API error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch dashboard statistics' },
      { status: 500 }
    );
  }
}
