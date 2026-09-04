import { NextRequest } from 'next/server';

/**
 * Sanitizes an environment variable string by trimming whitespace
 * and stripping accidental surrounding single or double quotes.
 */
export function sanitizeEnvValue(val?: string): string {
  if (!val) return '';
  return val.trim().replace(/^["']|["']$/g, '').trim();
}

/**
 * Returns true if the application is running in production (Railway or NODE_ENV=production).
 */
export function isProduction(): boolean {
  return (
    process.env.NODE_ENV === 'production' ||
    Boolean(process.env.RAILWAY_ENVIRONMENT) ||
    Boolean(process.env.RAILWAY_PROJECT_ID) ||
    Boolean(process.env.RAILWAY_PUBLIC_DOMAIN)
  );
}

/**
 * Resolves the canonical public base URL for the application.
 *
 * Priority:
 * 1. Request x-forwarded-host & x-forwarded-proto headers (when from a public proxy)
 * 2. NEXT_PUBLIC_APP_URL environment variable
 * 3. RAILWAY_PUBLIC_DOMAIN or RAILWAY_STATIC_URL environment variables
 * 4. Fallback: local development URL (e.g. http://localhost:3000)
 *
 * In production, it will NEVER return localhost:8080 or an internal container port.
 */
export function getPublicAppUrl(request?: NextRequest | Request): string {
  // 1. Check explicit NEXT_PUBLIC_APP_URL first if configured and valid
  const envAppUrl = sanitizeEnvValue(process.env.NEXT_PUBLIC_APP_URL);
  if (envAppUrl) {
    const cleaned = envAppUrl.replace(/\/+$/, '');
    // In production, ignore if someone accidentally set NEXT_PUBLIC_APP_URL to localhost
    if (!isProduction() || !cleaned.includes('localhost')) {
      return cleaned;
    }
  }

  // 2. Check Railway native domain environment variables
  const railwayDomain = sanitizeEnvValue(
    process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RAILWAY_STATIC_URL
  );
  if (railwayDomain) {
    const host = railwayDomain.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    return `https://${host}`;
  }

  // 3. Inspect incoming request headers (x-forwarded-host, host)
  if (request) {
    let forwardedHost = '';
    let forwardedProto = '';

    if ('headers' in request && typeof request.headers.get === 'function') {
      forwardedHost = request.headers.get('x-forwarded-host') || request.headers.get('host') || '';
      forwardedProto = request.headers.get('x-forwarded-proto') || '';
    }

    if (forwardedHost) {
      // In production, ignore internal container ports like localhost:8080
      const isInternalLocal = forwardedHost.includes('localhost') || forwardedHost.startsWith('127.') || forwardedHost.startsWith('0.0.0.0');
      if (!isProduction() || !isInternalLocal) {
        const proto = forwardedProto || (isProduction() ? 'https' : 'http');
        return `${proto}://${forwardedHost.replace(/\/+$/, '')}`;
      }
    }

    // Check request.nextUrl if available and not internal container host in production
    if ('nextUrl' in request && request.nextUrl?.origin) {
      const origin = request.nextUrl.origin;
      if (!isProduction() || !origin.includes('localhost')) {
        return origin.replace(/\/+$/, '');
      }
    }
  }

  // 4. Default fallback for production vs local
  if (isProduction()) {
    // Canonical production fallback for this Railway deployment
    return 'https://ai-job-outreach-agent-production.up.railway.app';
  }

  const localPort = process.env.PORT || '3000';
  return `http://localhost:${localPort}`;
}

/**
 * Resolves the Google OAuth redirect URI.
 *
 * In Railway production, this resolves to:
 * https://ai-job-outreach-agent-production.up.railway.app/api/gmail/callback
 *
 * In local development, it resolves to:
 * http://localhost:3000/api/gmail/callback
 */
export function getOAuthRedirectUri(request?: NextRequest | Request): string {
  const envRedirect = sanitizeEnvValue(process.env.GMAIL_REDIRECT_URI);

  if (envRedirect) {
    // If running in production but GMAIL_REDIRECT_URI was left as localhost, override it safely
    if (isProduction() && envRedirect.includes('localhost')) {
      console.warn(
        `[OAuth Warning] GMAIL_REDIRECT_URI contains "localhost" in production (${envRedirect}). Overriding with public production URL.`
      );
      const appUrl = getPublicAppUrl(request);
      return `${appUrl}/api/gmail/callback`;
    }
    return envRedirect;
  }

  // Derive dynamically from public app URL
  const appUrl = getPublicAppUrl(request);
  return `${appUrl}/api/gmail/callback`;
}
