function getEnvVar(key: string, defaultValue?: string): string {
  const value = process.env[key] || defaultValue;
  if (value === undefined) {
    throw new Error(`Missing environment variable: ${key}`);
  }
  return value;
}

function getOptionalEnvVar(key: string, defaultValue: string = ''): string {
  return process.env[key] || defaultValue;
}

export function isValidTimezone(tz: string): boolean {
  if (!tz || typeof tz !== 'string') return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const env = {
  // AI
  geminiApiKey: () => getEnvVar('GEMINI_API_KEY', ''),

  // Gmail OAuth
  googleClientId: () => getOptionalEnvVar('GOOGLE_CLIENT_ID'),
  googleClientSecret: () => getOptionalEnvVar('GOOGLE_CLIENT_SECRET'),
  gmailRedirectUri: () => getOptionalEnvVar('GMAIL_REDIRECT_URI', 'http://localhost:3000/api/gmail/callback'),

  // Security
  encryptionKey: () => getOptionalEnvVar('ENCRYPTION_KEY'),
  nextAuthSecret: () => getOptionalEnvVar('NEXTAUTH_SECRET'),

  // App & Execution Mode
  appUrl: () => getOptionalEnvVar('NEXT_PUBLIC_APP_URL', 'http://localhost:3000'),
  isDryRun: () => process.env.OUTREACH_DRY_RUN === 'true',
  dataDir: () => getOptionalEnvVar('DATA_DIR', 'data'),

  // Timezone with strict validation
  timezone: () => {
    const tz = getOptionalEnvVar('USER_TIMEZONE', 'Asia/Kolkata');
    if (!isValidTimezone(tz)) {
      throw new Error(`Invalid USER_TIMEZONE configuration: "${tz}" is not a recognized IANA timezone identifier.`);
    }
    return tz;
  },

  // Sending Limits & Timers with strict positive validation
  maxDailyEmails: () => {
    const raw = getOptionalEnvVar('MAX_DAILY_EMAILS', '30');
    const parsed = parseInt(raw, 10);
    if (isNaN(parsed) || parsed <= 0) {
      throw new Error(`Invalid MAX_DAILY_EMAILS configuration: "${raw}". Must be a positive integer >= 1.`);
    }
    return parsed;
  },

  sendIntervalMinutes: () => {
    const raw = getOptionalEnvVar('SEND_INTERVAL_MINUTES', '3');
    const parsed = parseInt(raw, 10);
    if (isNaN(parsed) || parsed <= 0) {
      throw new Error(`Invalid SEND_INTERVAL_MINUTES configuration: "${raw}". Must be a positive integer >= 1.`);
    }
    return parsed;
  },

  sendStartHour: () => {
    const raw = getOptionalEnvVar('SEND_START_HOUR', '10');
    const parsed = parseInt(raw, 10);
    if (isNaN(parsed) || parsed < 0 || parsed > 23) {
      throw new Error(`Invalid SEND_START_HOUR configuration: "${raw}". Must be an integer between 0 and 23.`);
    }
    return parsed;
  },

  sendStartMinute: () => {
    const raw = getOptionalEnvVar('SEND_START_MINUTE', '0');
    const parsed = parseInt(raw, 10);
    if (isNaN(parsed) || parsed < 0 || parsed > 59) {
      throw new Error(`Invalid SEND_START_MINUTE configuration: "${raw}". Must be an integer between 0 and 59.`);
    }
    return parsed;
  },
} as const;

/**
 * Validates the entire environment configuration and returns all errors without throwing.
 */
export function validateEnvironmentConfig(): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  try {
    env.timezone();
  } catch (err) {
    if (err instanceof Error) errors.push(err.message);
  }

  try {
    env.maxDailyEmails();
  } catch (err) {
    if (err instanceof Error) errors.push(err.message);
  }

  try {
    env.sendIntervalMinutes();
  } catch (err) {
    if (err instanceof Error) errors.push(err.message);
  }

  try {
    env.sendStartHour();
  } catch (err) {
    if (err instanceof Error) errors.push(err.message);
  }

  try {
    env.sendStartMinute();
  } catch (err) {
    if (err instanceof Error) errors.push(err.message);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
