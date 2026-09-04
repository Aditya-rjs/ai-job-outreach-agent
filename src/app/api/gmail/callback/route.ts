import { NextRequest, NextResponse } from 'next/server';
import { validateOAuthState, handleOAuthCallback, clearOAuthState } from '@/lib/gmail/gmail-client';
import { initializeDatabase } from '@/db/migrate';
import { getPublicAppUrl, getOAuthRedirectUri } from '@/lib/config/url';

let initialized = false;
function ensureInitialized() {
  if (!initialized) {
    initializeDatabase();
    initialized = true;
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  ensureInitialized();

  const searchParams = request.nextUrl.searchParams;
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const error = searchParams.get('error');

  const baseUrl = getPublicAppUrl(request);
  const redirectUri = getOAuthRedirectUri(request);

  console.log('[Gmail Callback] Received OAuth callback:', {
    baseUrl,
    redirectUri,
    hasCode: Boolean(code),
    hasState: Boolean(state),
    hasError: Boolean(error),
  });

  // Handle user rejection or Google error
  if (error) {
    console.warn('[Gmail Callback] Google returned authorization error:', error);
    clearOAuthState();
    return NextResponse.redirect(new URL(`/settings?error=${encodeURIComponent('Access was denied by Google: ' + error)}`, baseUrl));
  }

  // Handle missing code
  if (!code) {
    clearOAuthState();
    return NextResponse.redirect(new URL('/settings?error=Missing%20authorization%20code', baseUrl));
  }

  // Validate CSRF state
  if (!state || !validateOAuthState(state)) {
    console.warn('[Gmail Callback] Invalid or expired OAuth state detected');
    clearOAuthState();
    return NextResponse.redirect(new URL('/settings?error=Invalid%20or%20expired%20OAuth%20session', baseUrl));
  }

  try {
    const result = await handleOAuthCallback(code, redirectUri);
    if (result.success) {
      console.log(`[Gmail Callback] Authorization succeeded for ${result.email || 'account'}`);
      return NextResponse.redirect(new URL('/settings?gmail=connected', baseUrl));
    } else {
      return NextResponse.redirect(new URL('/settings?error=Failed%20to%20complete%20authorization', baseUrl));
    }
  } catch (exchangeErr) {
    console.error('[Gmail Callback] Token exchange failed:', exchangeErr);
    const msg = exchangeErr instanceof Error ? exchangeErr.message : 'Token exchange failed';
    return NextResponse.redirect(new URL(`/settings?error=${encodeURIComponent(msg)}`, baseUrl));
  }
}
