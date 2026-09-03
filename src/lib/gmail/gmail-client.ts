import { google, type Auth } from 'googleapis';
type OAuth2Client = Auth.OAuth2Client;
type Credentials = Auth.Credentials;
import crypto from 'crypto';
import { env } from '@/lib/config/env';
import { getDb } from '@/db';
import { settings } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { encrypt, decrypt } from '@/lib/security/encryption';

const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';

/**
 * Creates an unauthenticated Google OAuth2Client instance using environment configuration.
 */
export function createOAuth2Client(): OAuth2Client {
  const clientId = env.googleClientId();
  const clientSecret = env.googleClientSecret();
  const redirectUri = env.gmailRedirectUri();

  if (!clientId || !clientSecret) {
    throw new Error('Google OAuth credentials not configured. Please set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.local.');
  }

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

/**
 * Generates an OAuth authorization consent URL with CSRF state protection.
 */
export function generateAuthUrl(): { url: string; state: string } {
  const oauth2Client = createOAuth2Client();
  const state = crypto.randomBytes(24).toString('hex');

  // Store state in settings table with 10-minute expiry
  const db = getDb();
  const stateData = JSON.stringify({ state, createdAt: Date.now() });

  db.insert(settings)
    .values({ key: 'oauth_state', value: stateData, updatedAt: new Date().toISOString() })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: stateData, updatedAt: new Date().toISOString() },
    })
    .run();

  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [GMAIL_SEND_SCOPE],
    prompt: 'consent',
    state,
  });

  return { url, state };
}

/**
 * Validates the returned OAuth state to prevent CSRF attacks.
 */
export function validateOAuthState(state: string): boolean {
  if (!state) return false;

  const db = getDb();
  const record = db.select().from(settings).where(eq(settings.key, 'oauth_state')).get();
  if (!record || !record.value) return false;

  try {
    const data = JSON.parse(record.value);
    const tenMinutes = 10 * 60 * 1000;
    if (Date.now() - data.createdAt > tenMinutes) {
      return false;
    }
    return data.state === state;
  } catch {
    return false;
  }
}

/**
 * Clears the temporary OAuth state after validation.
 */
export function clearOAuthState(): void {
  const db = getDb();
  db.delete(settings).where(eq(settings.key, 'oauth_state')).run();
}

/**
 * Exchanges authorization code for tokens, verifies connection, encrypts, and stores them safely in SQLite.
 */
export async function handleOAuthCallback(code: string): Promise<{ success: boolean; email?: string }> {
  const oauth2Client = createOAuth2Client();
  const { tokens } = await oauth2Client.getToken(code);

  oauth2Client.setCredentials(tokens);

  // Safely determine authorized email if possible
  let userEmail = '';
  try {
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const profile = await gmail.users.getProfile({ userId: 'me' });
    if (profile.data.emailAddress) {
      userEmail = profile.data.emailAddress;
    }
  } catch (profileErr) {
    // If getProfile is restricted with send-only scope, use fallback indicator
    console.log('Gmail getProfile returned restricted (using authorized session):', profileErr);
    userEmail = 'Authorized Gmail Account';
  }

  // Encrypt tokens before storing in SQLite
  const serializedTokens = JSON.stringify(tokens);
  const encryptedTokens = encrypt(serializedTokens);

  const db = getDb();
  const now = new Date().toISOString();

  db.insert(settings)
    .values({ key: 'gmail_tokens', value: encryptedTokens, updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value: encryptedTokens, updatedAt: now } })
    .run();

  db.insert(settings)
    .values({ key: 'gmail_connected', value: 'true', updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value: 'true', updatedAt: now } })
    .run();

  db.insert(settings)
    .values({ key: 'gmail_email', value: userEmail, updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value: userEmail, updatedAt: now } })
    .run();

  clearOAuthState();
  return { success: true, email: userEmail };
}

/**
 * Loads and decrypts stored tokens from SQLite settings table.
 */
export function loadStoredTokens(): Credentials | null {
  const db = getDb();
  const record = db.select().from(settings).where(eq(settings.key, 'gmail_tokens')).get();
  if (!record || !record.value) return null;

  try {
    const decrypted = decrypt(record.value);
    return JSON.parse(decrypted) as Credentials;
  } catch (err) {
    console.error('Failed to decrypt stored Gmail tokens:', err);
    return null;
  }
}

/**
 * Gets an authenticated Gmail API client with automatic token refreshing and token re-encryption.
 */
export async function getAuthenticatedGmailClient(): Promise<{
  gmail: ReturnType<typeof google.gmail>;
  oauth2Client: OAuth2Client;
  email: string;
}> {
  const tokens = loadStoredTokens();
  if (!tokens) {
    throw new Error('Gmail is not connected. Please connect your Gmail account in Settings.');
  }

  const oauth2Client = createOAuth2Client();
  oauth2Client.setCredentials(tokens);

  // Automatically re-encrypt and persist any refreshed tokens
  oauth2Client.on('tokens', (newTokens) => {
    try {
      const mergedTokens: Credentials = { ...tokens, ...newTokens };
      const encrypted = encrypt(JSON.stringify(mergedTokens));
      const db = getDb();
      db.update(settings)
        .set({ value: encrypted, updatedAt: new Date().toISOString() })
        .where(eq(settings.key, 'gmail_tokens'))
        .run();
    } catch (saveErr) {
      console.error('Failed to persist refreshed Gmail tokens:', saveErr);
    }
  });

  const db = getDb();
  const emailRecord = db.select().from(settings).where(eq(settings.key, 'gmail_email')).get();
  const email = emailRecord?.value || 'me';

  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
  return { gmail, oauth2Client, email };
}

/**
 * Checks whether Gmail credentials are currently stored and verified.
 */
export async function getGmailConnectionStatus(): Promise<{ connected: boolean; email: string | null }> {
  const db = getDb();
  const connectedRecord = db.select().from(settings).where(eq(settings.key, 'gmail_connected')).get();
  const emailRecord = db.select().from(settings).where(eq(settings.key, 'gmail_email')).get();

  if (connectedRecord?.value !== 'true') {
    return { connected: false, email: null };
  }

  const tokens = loadStoredTokens();
  if (!tokens) {
    return { connected: false, email: null };
  }

  return {
    connected: true,
    email: emailRecord?.value || 'Authorized Account',
  };
}

/**
 * Disconnects Gmail by clearing stored credentials without touching outreach history or queue data.
 */
export function disconnectGmail(): void {
  const db = getDb();
  const now = new Date().toISOString();

  // Clear credentials
  db.delete(settings).where(eq(settings.key, 'gmail_tokens')).run();

  db.insert(settings)
    .values({ key: 'gmail_connected', value: 'false', updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value: 'false', updatedAt: now } })
    .run();

  db.insert(settings)
    .values({ key: 'gmail_email', value: '', updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value: '', updatedAt: now } })
    .run();
}
