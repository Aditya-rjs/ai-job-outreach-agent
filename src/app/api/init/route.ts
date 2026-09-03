import { NextResponse } from 'next/server';
import { initializeDatabase } from '@/db/migrate';
import type { ApiResponse } from '@/types';

export async function GET(): Promise<NextResponse<ApiResponse<{ initialized: boolean }>>> {
  try {
    initializeDatabase();
    return NextResponse.json({ success: true, data: { initialized: true } });
  } catch (error) {
    console.error('Database initialization error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to initialize database' },
      { status: 500 }
    );
  }
}
