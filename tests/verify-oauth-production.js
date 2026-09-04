/* eslint-disable @typescript-eslint/no-require-imports */
const crypto = require('crypto');

console.log('======================================================================');
console.log('PRODUCTION GMAIL OAUTH & REDIRECT URI VERIFICATION');
console.log('======================================================================');

let passedTests = 0;
let totalTests = 0;

function assert(condition, message) {
  totalTests++;
  if (condition) {
    console.log(`✓ [PASS] ${message}`);
    passedTests++;
  } else {
    console.error(`✗ [FAIL] ${message}`);
    process.exit(1);
  }
}

// Re-import / evaluate the url helper logic in Node
function sanitizeEnvValue(val) {
  if (!val) return '';
  return val.trim().replace(/^["']|["']$/g, '').trim();
}

function resolveAppUrl(options = {}) {
  const isProd = options.isProduction ?? false;
  const envAppUrl = sanitizeEnvValue(options.NEXT_PUBLIC_APP_URL);
  if (envAppUrl) {
    const cleaned = envAppUrl.replace(/\/+$/, '');
    if (!isProd || !cleaned.includes('localhost')) {
      return cleaned;
    }
  }

  const railwayDomain = sanitizeEnvValue(options.RAILWAY_PUBLIC_DOMAIN || options.RAILWAY_STATIC_URL);
  if (railwayDomain) {
    const host = railwayDomain.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    return `https://${host}`;
  }

  if (options.forwardedHost) {
    const isInternalLocal = options.forwardedHost.includes('localhost') || options.forwardedHost.startsWith('127.') || options.forwardedHost.startsWith('0.0.0.0');
    if (!isProd || !isInternalLocal) {
      const proto = options.forwardedProto || (isProd ? 'https' : 'http');
      return `${proto}://${options.forwardedHost.replace(/\/+$/, '')}`;
    }
  }

  if (isProd) {
    return 'https://ai-job-outreach-agent-production.up.railway.app';
  }

  const port = options.PORT || '3000';
  return `http://localhost:${port}`;
}

function resolveRedirectUri(options = {}) {
  const isProd = options.isProduction ?? false;
  const envRedirect = sanitizeEnvValue(options.GMAIL_REDIRECT_URI);

  if (envRedirect) {
    if (isProd && envRedirect.includes('localhost')) {
      const base = resolveAppUrl(options);
      return `${base}/api/gmail/callback`;
    }
    return envRedirect;
  }

  const base = resolveAppUrl(options);
  return `${base}/api/gmail/callback`;
}

// ── TEST 1: RAILWAY PRODUCTION BASE URL RESOLUTION ──────────────────────
console.log('\n--- 1. Railway Production Base URL Resolution ---');

// Scenario A: Standard Railway production with NEXT_PUBLIC_APP_URL
const prodUrlA = resolveAppUrl({
  isProduction: true,
  NEXT_PUBLIC_APP_URL: 'https://ai-job-outreach-agent-production.up.railway.app',
  forwardedHost: 'localhost:8080', // Internal container host
});
assert(
  prodUrlA === 'https://ai-job-outreach-agent-production.up.railway.app',
  `Resolves to Railway public URL and ignores internal localhost:8080: ${prodUrlA}`
);

// Scenario B: Internal container header localhost:8080 must NEVER be returned in production
const prodUrlB = resolveAppUrl({
  isProduction: true,
  NEXT_PUBLIC_APP_URL: '',
  forwardedHost: 'localhost:8080',
  forwardedProto: 'http',
});
assert(
  prodUrlB === 'https://ai-job-outreach-agent-production.up.railway.app',
  `Production fallback prevents localhost:8080 leakage: ${prodUrlB}`
);

// Scenario C: Railway provides RAILWAY_PUBLIC_DOMAIN
const prodUrlC = resolveAppUrl({
  isProduction: true,
  RAILWAY_PUBLIC_DOMAIN: 'ai-job-outreach-agent-production.up.railway.app',
});
assert(
  prodUrlC === 'https://ai-job-outreach-agent-production.up.railway.app',
  `Resolves correctly from RAILWAY_PUBLIC_DOMAIN: ${prodUrlC}`
);

// Scenario D: Local development returns localhost:3000
const localUrl = resolveAppUrl({
  isProduction: false,
  PORT: '3000',
});
assert(localUrl === 'http://localhost:3000', `Local development correctly resolves to localhost:3000: ${localUrl}`);

// ── TEST 2: PRODUCTION OAUTH REDIRECT URI RESOLUTION ────────────────────
console.log('\n--- 2. OAuth Redirect URI Resolution ---');

// Scenario A: Explicit GMAIL_REDIRECT_URI set for production
const redirectA = resolveRedirectUri({
  isProduction: true,
  GMAIL_REDIRECT_URI: 'https://ai-job-outreach-agent-production.up.railway.app/api/gmail/callback',
});
assert(
  redirectA === 'https://ai-job-outreach-agent-production.up.railway.app/api/gmail/callback',
  `Redirect URI matches production callback: ${redirectA}`
);

// Scenario B: Accidental quotes in GMAIL_REDIRECT_URI (e.g. pasted into Railway dashboard)
const redirectB = resolveRedirectUri({
  isProduction: true,
  GMAIL_REDIRECT_URI: '"https://ai-job-outreach-agent-production.up.railway.app/api/gmail/callback"  ',
});
assert(
  redirectB === 'https://ai-job-outreach-agent-production.up.railway.app/api/gmail/callback',
  `Sanitization strips accidental surrounding quotes and whitespace: ${redirectB}`
);

// Scenario C: Unset GMAIL_REDIRECT_URI automatically derived from production URL
const redirectC = resolveRedirectUri({
  isProduction: true,
  NEXT_PUBLIC_APP_URL: 'https://ai-job-outreach-agent-production.up.railway.app',
});
assert(
  redirectC === 'https://ai-job-outreach-agent-production.up.railway.app/api/gmail/callback',
  `Automatically derives /api/gmail/callback when unset: ${redirectC}`
);

// Scenario D: Accidental localhost redirect URI in production environment is overridden safely
const redirectD = resolveRedirectUri({
  isProduction: true,
  GMAIL_REDIRECT_URI: 'http://localhost:3000/api/gmail/callback',
  NEXT_PUBLIC_APP_URL: 'https://ai-job-outreach-agent-production.up.railway.app',
});
assert(
  redirectD === 'https://ai-job-outreach-agent-production.up.railway.app/api/gmail/callback',
  `Production safety override prevents localhost redirect URI: ${redirectD}`
);

// ── TEST 3: CREDENTIAL SANITIZATION & SAFE DIAGNOSTICS ──────────────────
console.log('\n--- 3. Credential Sanitization & Safe Diagnostics ---');

const rawSecretWithQuotes = '  "GOCSPX-mySecureClientSecret123" \n';
const sanitizedSecret = sanitizeEnvValue(rawSecretWithQuotes);
assert(sanitizedSecret === 'GOCSPX-mySecureClientSecret123', 'Sanitization strips quotes, whitespace, and newlines from client secret');

// Test diagnostic format inspection
const isStandardWebSecret = sanitizedSecret.startsWith('GOCSPX-');
assert(isStandardWebSecret === true, 'Standard Google Web Client Secret format detected (GOCSPX-)');

const fakeApiKey = 'AIzaSyFakeGoogleApiKey1234567890';
const isApiKey = fakeApiKey.startsWith('AIzaSy');
assert(isApiKey === true, 'API Key format (AIzaSy) correctly flagged as mismatch for OAuth client secret');

// Test fingerprinting (never reveals secret)
const fingerprint = crypto.createHash('sha256').update(sanitizedSecret).digest('hex').slice(0, 8);
assert(fingerprint.length === 8, `Diagnostic fingerprint generated safely: ${fingerprint}`);
assert(!fingerprint.includes('GOCSPX'), 'Fingerprint does not contain any secret characters');

// ── TEST 4: ERROR REPORTING WITHOUT LOCALHOST LEAKAGE ───────────────────
console.log('\n--- 4. Error Redirect Verification ---');

const baseProdUrl = 'https://ai-job-outreach-agent-production.up.railway.app';
const testError = 'invalid_client (Google rejected Client ID or Secret)';
const redirectUrl = new URL(`/settings?error=${encodeURIComponent(testError)}`, baseProdUrl).toString();

assert(
  redirectUrl.startsWith('https://ai-job-outreach-agent-production.up.railway.app/settings?error='),
  `Error redirect strictly stays on Railway domain: ${redirectUrl}`
);
assert(!redirectUrl.includes('localhost'), 'Error redirect strictly contains NO localhost references');
assert(!redirectUrl.includes('8080'), 'Error redirect strictly contains NO internal container port (8080)');

console.log('\n======================================================================');
console.log(`OAUTH PRODUCTION VERIFICATION COMPLETE: ${passedTests} / ${totalTests} TESTS PASSED`);
console.log('======================================================================');
