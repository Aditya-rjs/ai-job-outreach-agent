import { NextResponse } from 'next/server';
import { getGmailConnectionStatus } from '@/lib/gmail/gmail-client';
import { initializeDatabase } from '@/db/migrate';
import type { ApiResponse } from '@/types';

let initialized = false;
function ensureInitialized() {
  if (!initialized) {
    initializeDatabase();
    initialized = true;
  }
}

export async function GET(): Promise<NextResponse<ApiResponse<{ connected: boolean; email: string | null }>>> {
  try {
    ensureInitialized();
    const status = await getGmailConnectionStatus();
    return NextResponse.json({
      success: true,
      data: status,
    });
  } catch (error) {
    console.error('[Gmail Status Error]:', error);
    return NextResponse.json({
      success: true,
      data: { connected: false, email: null },
    });
  }
}
