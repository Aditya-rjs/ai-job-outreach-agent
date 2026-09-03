import crypto from 'crypto';
import { env } from '@/lib/config/env';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // Standard 96 bits for GCM
const AUTH_TAG_LENGTH = 16; // Standard 128 bits for GCM

/**
 * Derives a consistent 32-byte key for AES-256-GCM.
 */
function getEncryptionKey(): Buffer {
  const rawKey = env.encryptionKey();
  if (rawKey && rawKey.trim().length > 0) {
    return crypto.createHash('sha256').update(rawKey.trim()).digest();
  }

  // Development fallback key (warn in development)
  const devSeed = 'ai-job-outreach-agent-local-dev-key-salt-2026';
  return crypto.createHash('sha256').update(devSeed).digest();
}

/**
 * Encrypts plaintext using AES-256-GCM authenticated encryption.
 * Output format: iv:authTag:ciphertext (hex-encoded)
 */
export function encrypt(plaintext: string): string {
  if (!plaintext) return '';

  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');

  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

/**
 * Decrypts AES-256-GCM authenticated ciphertext.
 * Verifies authenticity before returning decrypted string.
 */
export function decrypt(ciphertext: string): string {
  if (!ciphertext) return '';

  const parts = ciphertext.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted payload structure. Expected iv:authTag:ciphertext');
  }

  const [ivHex, authTagHex, encryptedHex] = parts;
  const key = getEncryptionKey();
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}
