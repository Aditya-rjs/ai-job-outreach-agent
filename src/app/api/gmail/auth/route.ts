import { NextRequest, NextResponse } from 'next/server';
import { generateAuthUrl, getSafeOAuthDiagnostics } from '@/lib/gmail/gmail-client';
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
  const baseUrl = getPublicAppUrl(request);
  const redirectUri = getOAuthRedirectUri(request);

  try {
    ensureInitialized();

    const diagnostics = getSafeOAuthDiagnostics(redirectUri);
    console.log('[Gmail Auth] Initiating Google OAuth consent flow:', {
      baseUrl,
      redirectUri,
      hasClientId: diagnostics.hasClientId,
      clientIdSuffix: diagnostics.clientIdSuffix,
      hasClientSecret: diagnostics.hasClientSecret,
      clientSecretPrefix: diagnostics.clientSecretPrefix + '***',
      clientSecretLength: diagnostics.clientSecretLength,
      isStandardWebSecretFormat: diagnostics.isStandardWebSecretFormat,
      isApiKeyFormat: diagnostics.isApiKeyFormat,
    });

    if (!diagnostics.hasClientId || !diagnostics.hasClientSecret) {
      const err = 'Google OAuth credentials not configured. Please set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in Railway environment variables.';
      return NextResponse.redirect(new URL(`/settings?error=${encodeURIComponent(err)}`, baseUrl));
    }

    const { url } = generateAuthUrl(redirectUri);
    // Redirect user to Google OAuth consent page
    return NextResponse.redirect(url);
  } catch (error) {
    console.error('[Gmail Auth Error]:', error);
    const msg = error instanceof Error ? error.message : 'Failed to initiate Gmail authorization.';
    return NextResponse.redirect(new URL(`/settings?error=${encodeURIComponent(msg)}`, baseUrl));
  }
}
