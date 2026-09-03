import { NextResponse } from 'next/server';
import { generateAuthUrl } from '@/lib/gmail/gmail-client';
import { initializeDatabase } from '@/db/migrate';

let initialized = false;
function ensureInitialized() {
  if (!initialized) {
    initializeDatabase();
    initialized = true;
  }
}

export async function GET(): Promise<NextResponse> {
  try {
    ensureInitialized();
    const { url } = generateAuthUrl();
    // Redirect user to Google OAuth consent page
    return NextResponse.redirect(url);
  } catch (error) {
    console.error('[Gmail Auth Error]:', error);
    const msg = error instanceof Error ? error.message : 'Failed to initiate Gmail authorization.';
    return NextResponse.redirect(new URL(`/settings?error=${encodeURIComponent(msg)}`, 'http://localhost:3000'));
  }
}
