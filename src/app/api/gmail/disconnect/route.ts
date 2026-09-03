import { NextResponse } from 'next/server';
import { disconnectGmail } from '@/lib/gmail/gmail-client';
import { initializeDatabase } from '@/db/migrate';
import type { ApiResponse } from '@/types';

let initialized = false;
function ensureInitialized() {
  if (!initialized) {
    initializeDatabase();
    initialized = true;
  }
}

export async function POST(): Promise<NextResponse<ApiResponse<{ disconnected: boolean }>>> {
  try {
    ensureInitialized();
    disconnectGmail();
    return NextResponse.json({
      success: true,
      data: { disconnected: true },
    });
  } catch (error) {
    console.error('[Gmail Disconnect Error]:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to disconnect Gmail account.' },
      { status: 500 }
    );
  }
}
